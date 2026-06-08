# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.
import atexit
import os
from pathlib import Path

# Default staging dir for raw API bodies (Claude Code CLI file mode).
# Inline mode (OTEL_LOG_RAW_API_BODIES=1) truncates bodies at 60 KB and strips
# the trailing `tools` array off every multi-turn request, so the dashboard
# loses tool descriptions and input schemas. File mode writes untruncated
# bodies to this dir; the OTEL receiver moves them per-session on arrival.
_DEFAULT_BODY_DIR = "/tmp/agentobserve_bodies"


def _configure_raw_body_mode():
    """If Claude Code telemetry is on and the user hasn't picked a body mode,
    default to file mode so tool definitions survive the 60 KB inline cap."""
    if not os.environ.get("CLAUDE_CODE_ENABLE_TELEMETRY"):
        return
    if os.environ.get("OTEL_LOG_RAW_API_BODIES"):
        return  # user already chose a mode — don't override
    Path(_DEFAULT_BODY_DIR).mkdir(parents=True, exist_ok=True)
    os.environ["OTEL_LOG_RAW_API_BODIES"] = f"file:{_DEFAULT_BODY_DIR}"


def setup():
    _configure_raw_body_mode()

    # Skip if a TracerProvider is already configured (e.g. opentelemetry-instrument CLI)
    from opentelemetry import trace
    if not isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
        return

    from opentelemetry import context
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    # 1. TracerProvider with OTLP exporter
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    service_name = os.environ.get("OTEL_SERVICE_NAME", "agentobserve")
    resource = Resource.create({"service.name": service_name})

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
    )
    trace.set_tracer_provider(provider)

    # 2. Load all installed instrumentors
    # Skip in LangSmith OTEL-only mode: LangSmith emits its own LLM spans
    # through the TracerProvider, and the auto-loaded HTTP client
    # instrumentors (urllib3/requests/httpx) inject traceparent headers
    # into outbound calls — which breaks AWS SigV4 signing for Bedrock.
    if not os.environ.get("LANGSMITH_OTEL_ONLY"):
        _load_instrumentors(provider)

    # 3. Create root session span + propagate TRACEPARENT for subprocesses
    # Skip root span for LangChain — LangSmith manages its own hierarchy.
    # Also register the LangChain tool-definitions callback so bound tools land
    # on LLM spans (LangSmith's OTEL exporter doesn't emit them itself).
    if os.environ.get("LANGSMITH_OTEL_ONLY"):
        try:
            from ._langchain_handler import register_tool_definitions_handler
            register_tool_definitions_handler()
        except Exception:
            pass
        return

    tracer = provider.get_tracer("agentobserve")
    root_span = tracer.start_span("agentobserve.session")
    ctx = trace.set_span_in_context(root_span)
    context.attach(ctx)

    carrier = {}
    TraceContextTextMapPropagator().inject(carrier, context=ctx)
    if "traceparent" in carrier:
        os.environ["TRACEPARENT"] = carrier["traceparent"]

    # 4. Cleanup on exit
    def _shutdown():
        root_span.end()
        provider.force_flush(timeout_millis=5000)
        provider.shutdown()
    atexit.register(_shutdown)


def _load_instrumentors(provider):
    """Discover and activate all installed opentelemetry instrumentors."""
    from importlib.metadata import entry_points

    try:
        eps = entry_points(group="opentelemetry_instrumentor")
    except TypeError:
        eps = entry_points().get("opentelemetry_instrumentor", [])

    for ep in eps:
        try:
            instrumentor_class = ep.load()
            instrumentor = instrumentor_class()
            if not instrumentor.is_instrumented_by_opentelemetry:
                instrumentor.instrument(tracer_provider=provider)
        except Exception:
            pass  # Skip instrumentors whose dependencies aren't installed
