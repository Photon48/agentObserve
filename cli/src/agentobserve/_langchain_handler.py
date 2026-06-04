"""LangChain callback that emits `gen_ai.tool.definitions` on the current OTEL span.

LangSmith's OTEL exporter (used when `LANGSMITH_OTEL_ONLY=true`) does NOT
serialize tools bound via `bind_tools()` / `create_agent(...)` onto its
ChatAnthropic / ChatOpenAI spans. We close that gap by hooking
`on_chat_model_start`, reading the bound tools from the invocation params or
model serialization, normalizing them to the Anthropic shape, and writing
them onto the active OTEL span that LangSmith has already opened for this
LLM call.

Registered globally via `langchain_core.tracers.context.register_configure_hook`
so it fires for every chat-model invocation with no user code changes.
"""
from __future__ import annotations

import json
import os
from contextvars import ContextVar
from typing import Any, Optional

try:
    from langchain_core.callbacks.base import BaseCallbackHandler as _BaseCB
except Exception:  # langchain_core may be absent; subclass object instead.
    _BaseCB = object  # type: ignore[assignment, misc]

_DEBUG_DUMP_COUNT = 0
_DEBUG_DUMP_MAX = 6


def _normalize_tool(t: Any) -> Optional[dict]:
    if not isinstance(t, dict):
        return None
    # OpenAI tool-calling envelope: {type: "function", function: {name, description, parameters}}
    if t.get("type") == "function" and isinstance(t.get("function"), dict):
        f = t["function"]
        return {
            "name": f.get("name", ""),
            "description": f.get("description", ""),
            "input_schema": f.get("parameters") or {},
        }
    # Anthropic-native shape (already canonical)
    return {
        "name": t.get("name", ""),
        "description": t.get("description", ""),
        "input_schema": t.get("input_schema") or t.get("inputSchema") or {},
    }


def _coerce_tools(maybe_tools: Any) -> list:
    """Accept either a list of tool dicts, or a dict whose values are tool dicts."""
    if isinstance(maybe_tools, list):
        return maybe_tools
    if isinstance(maybe_tools, dict):
        # Some langchain paths pass tools as {name: tool_dict}.
        return list(maybe_tools.values())
    return []


def _extract_tools(serialized: Optional[dict], kwargs: dict) -> list:
    """Locate the bound tools regardless of which LangChain version surfaced them.

    Probes (in order):
      - kwargs.invocation_params.{tools, tool_definitions, output_config.tools}
      - kwargs.options.{tools, tool_definitions}
      - serialized.kwargs.{tools, tool_definitions}
      - kwargs.tools
    """
    ip = kwargs.get("invocation_params") or {}
    opts = kwargs.get("options") or {}
    ser_kwargs = (serialized or {}).get("kwargs", {}) if isinstance(serialized, dict) else {}

    candidates = [
        ip.get("tools") if isinstance(ip, dict) else None,
        ip.get("tool_definitions") if isinstance(ip, dict) else None,
        (ip.get("output_config") or {}).get("tools") if isinstance(ip, dict) else None,
        opts.get("tools") if isinstance(opts, dict) else None,
        opts.get("tool_definitions") if isinstance(opts, dict) else None,
        ser_kwargs.get("tools") if isinstance(ser_kwargs, dict) else None,
        ser_kwargs.get("tool_definitions") if isinstance(ser_kwargs, dict) else None,
        kwargs.get("tools"),
    ]
    for c in candidates:
        if c:
            return _coerce_tools(c)
    return []


def _debug_dump(serialized, kwargs):
    global _DEBUG_DUMP_COUNT
    if not os.environ.get("AGENTOBSERVE_DEBUG") or _DEBUG_DUMP_COUNT >= _DEBUG_DUMP_MAX:
        return
    _DEBUG_DUMP_COUNT += 1
    ip = kwargs.get("invocation_params") or {}
    opts = kwargs.get("options") or {}
    ser_k = (serialized or {}).get("kwargs", {}) if isinstance(serialized, dict) else {}
    print(
        f"[agentobserve #{_DEBUG_DUMP_COUNT}] on_chat_model_start "
        f"kwargs={list(kwargs.keys())} "
        f"invocation_params={list(ip.keys()) if isinstance(ip, dict) else type(ip).__name__} "
        f"options={list(opts.keys()) if isinstance(opts, dict) else type(opts).__name__} "
        f"serialized_kwargs={list(ser_k.keys())}",
        flush=True,
    )
    for label, container in (("invocation_params", ip), ("options", opts), ("serialized.kwargs", ser_k)):
        if not isinstance(container, dict):
            continue
        for sk in ("tools", "tool_definitions", "output_config", "tool_choice", "model_kwargs"):
            if sk in container:
                sv = container[sk]
                if isinstance(sv, (list, dict)):
                    preview = f"{type(sv).__name__} len={len(sv) if hasattr(sv, '__len__') else '?'} sample={str(sv)[:400]}"
                else:
                    preview = str(sv)[:400]
                print(f"  [#{_DEBUG_DUMP_COUNT}] {label}.{sk} = {preview}", flush=True)


class AgentObserveToolDefinitionsHandler(_BaseCB):  # type: ignore[misc, valid-type]
    """Subclassing `BaseCallbackHandler` gives us no-op defaults for every
    other lifecycle method (on_llm_end, on_llm_error, etc.) so LangChain
    doesn't log AttributeError warnings for events we don't care about.
    """

    raise_error = False
    run_inline = True
    ignore_llm = False
    ignore_chain = True
    ignore_agent = True
    ignore_retriever = True
    ignore_chat_model = False
    ignore_custom_event = True
    ignore_retry = True

    def on_chat_model_start(
        self,
        serialized,
        messages,
        *,
        run_id=None,
        parent_run_id=None,
        tags=None,
        metadata=None,
        **kwargs,
    ):
        self._emit(serialized, kwargs)

    def on_llm_start(
        self,
        serialized,
        prompts,
        *,
        run_id=None,
        parent_run_id=None,
        tags=None,
        metadata=None,
        **kwargs,
    ):
        # Legacy text-completion LLMs rarely bind tools, but covers any edge cases.
        self._emit(serialized, kwargs)

    def _emit(self, serialized, kwargs):
        _debug_dump(serialized, kwargs)

        tools = _extract_tools(serialized, kwargs)
        if not tools:
            return
        normalized = [n for n in (_normalize_tool(t) for t in tools) if n and n.get("name")]
        if not normalized:
            return

        # LangSmith's OTEL tracer creates its spans in batches (not in the OTEL
        # context-var during the callback), so `trace.get_current_span()` is a
        # NonRecordingSpan here. We can't write onto LangSmith's span directly.
        # Instead: open our own short-lived span carrying just the tool
        # definitions, tagged with `session.id` so the loader buckets it
        # alongside the LangSmith spans for the same session.
        try:
            from opentelemetry import trace
        except Exception:
            return

        session_id = os.environ.get("LANGCHAIN_PROJECT", "")
        try:
            tracer = trace.get_tracer("agentobserve")
            span = tracer.start_span("agentobserve.tool_definitions")
            if session_id:
                span.set_attribute("session.id", session_id)
            span.set_attribute("gen_ai.tool.definitions", json.dumps(normalized))
            span.end()
            if os.environ.get("AGENTOBSERVE_DEBUG"):
                print(
                    f"[agentobserve] emitted span with {len(normalized)} tools "
                    f"(session={session_id or 'unset'})",
                    flush=True,
                )
        except Exception as e:
            if os.environ.get("AGENTOBSERVE_DEBUG"):
                print(f"[agentobserve] emit failed: {e!r}", flush=True)


def register_tool_definitions_handler() -> None:
    """Globally register the handler so every LangChain LLM call fires it.

    Uses `langchain_core.tracers.context.register_configure_hook`: LangChain
    iterates registered hooks every time it builds a CallbackManager and adds
    the handler if the associated ContextVar holds a non-None value. We seed
    the ContextVar with a single shared instance.
    """
    try:
        from langchain_core.tracers.context import register_configure_hook
    except Exception:
        return  # langchain_core not installed; nothing to do.

    handler = AgentObserveToolDefinitionsHandler()
    var: ContextVar = ContextVar("agentobserve_tool_def_handler", default=handler)
    try:
        register_configure_hook(var, inheritable=True)
    except Exception:
        pass
