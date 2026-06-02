# agentObserve

Agent observability platform — visualizes OTEL telemetry from AI agent frameworks.
Supports **LangChain / LangGraph** and **Anthropic SDK (Claude Agent SDK)**.

This file is the instruction set for setting up agentObserve. There are two parts:
1. **Server** — the 3 services that receive, parse, and display telemetry
2. **Client library** — a Python package installed into the user's agent project that auto-sends telemetry

---

## Part 1: Server Setup

### Prerequisites

The user's machine needs:
- **Node.js >= 18** — for Express API and Vite frontend
- **Python >= 3.11** — for the OTEL receiver
- **uv** — Python package manager ([install](https://docs.astral.sh/uv/getting-started/installation/): `curl -LsSf https://astral.sh/uv/install.sh | sh`)

### Setup and Start

```bash
git clone <repo-url>
cd agentObserve
make setup    # creates .venv, installs Python + Node deps
make start    # starts all 3 services
```

The dashboard is at **http://localhost:5173**.

`make setup` does three things:
1. `uv venv .venv && uv sync` — creates Python venv, installs FastAPI + OTEL protobuf deps
2. `npm install` — installs Express, React, Vite, etc.
3. `mkdir -p telemetry` — creates the telemetry data directory

### Service Management

| Command | What it does |
|---|---|
| `make start` | Start all services (receiver :4318, Express :3001, Vite :5173) |
| `make stop` | Stop all services |
| `make restart` | Stop then start |
| `make status` | Show running/stopped + PIDs + ports |
| `make logs` | Tail all service logs |

Individual: `make start-receiver`, `make stop-express`, etc. PIDs in `.pids/`, logs in `.logs/`.

### The Three Services

| Service | Port | What it does |
|---|---|---|
| **OTEL Receiver** | 4318 | FastAPI app (`otel_receiver.py`). Accepts protobuf at `/v1/{traces,metrics,logs}`, saves to `telemetry/<session_id>/` |
| **Express API** | 3001 | Reads telemetry JSON, auto-detects framework, parses into canonical sessions. Serves `GET /api/sessions` and `GET /api/sessions/:id` |
| **Vite Frontend** | 5173 | React UI. Proxies `/api` to Express. Session list, workflow graph, step detail |

---

## Part 2: Client Library Setup (User's Agent Project)

**ASK THE USER**: Which framework does your agent use — **LangChain/LangGraph** or **Anthropic SDK (Claude Agent SDK)**?

The `agentobserve` package lives in `cli/` within this repo. It is installed into the user's own project venv (NOT the agentObserve server venv). It uses `hatch-autorun` to auto-activate on import — zero code changes needed.

### Framework: LangChain / LangGraph

**Install into the user's project venv:**

```bash
# From the user's project directory, pointing to the cloned agentObserve repo
pip install /path/to/agentObserve/cli[langchain]

# Or with uv:
uv pip install /path/to/agentObserve/cli[langchain]

# Or as a uv source in their pyproject.toml:
# [tool.uv.sources]
# agentobserve = { path = "/path/to/agentObserve/cli", editable = true }
# Then add "agentobserve[langchain]" to [project.dependencies]
```

The `[langchain]` extra installs `langsmith[otel]` which provides LangSmith's native OTEL exporter.

**Required environment variables** — set these before running the agent:

```bash
AGENTOBSERVE_ENABLED=1                            # activates the bootstrap hook
LANGCHAIN_TRACING_V2=true                          # enables LangSmith tracing
LANGSMITH_OTEL_ONLY=true                           # exports via OTEL instead of LangSmith cloud
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # points to the agentObserve receiver
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf          # required protocol
```

**Caveats for LangChain/LangGraph:**
- `LANGCHAIN_TRACING_V2=true` is required even though we're not sending to LangSmith cloud — it activates the tracing pipeline
- `LANGSMITH_OTEL_ONLY=true` is critical — without it, traces go to LangSmith cloud instead of agentObserve
- The agentobserve bootstrap skips creating a root span when `LANGSMITH_OTEL_ONLY` is set because LangSmith manages its own span hierarchy
- A `LANGCHAIN_API_KEY` is NOT required when using `LANGSMITH_OTEL_ONLY=true`
- Session ID: set `LANGCHAIN_PROJECT` to a UUID to group all traces from one run into a single session. If not set, spans land in `telemetry/unknown/`

**Minimal integration pattern:**

```python
import os, uuid

session_id = str(uuid.uuid4())

os.environ["AGENTOBSERVE_ENABLED"] = "1"
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGSMITH_OTEL_ONLY"] = "true"
os.environ["LANGCHAIN_PROJECT"] = session_id
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4318"
os.environ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"

# Everything below this point is the user's existing code — unchanged
from langgraph.graph import StateGraph, START, END
# ... their agent code ...
```

**Grouping LLM calls under one trace per request.** Only needed when the
agent makes LangChain `.invoke()` calls *outside* the LangGraph context
(e.g. guardrails, NER, tool planning, RAG routing, post-processing). Each
such top-level `.invoke()` starts its own OTEL root trace because there is
no parent span in the OTEL context-var at the moment it runs — and the
dashboard will render only the LangGraph subtree, dropping everything else.

Fix: place a `@traceable` decorator from `langsmith` at the request
boundary. With `LANGSMITH_OTEL_ONLY=true` (already required above), the
decorator emits a standard OTEL span via the TracerProvider that
agentobserve installs. Every nested `.invoke()` attaches as a child via
OTEL context propagation, collapsing all spans into a single trace.

```python
from langsmith import traceable

@traceable(run_type="chain", name="ai_request")
async def handle_request(...):
    # existing code — guardrails, LangGraph agent, NER, tools — all attach
    # as descendants of this span automatically.
    ...
```

No other code changes required. Works for any HTTP framework (FastAPI,
Flask, Django, etc.) — no inbound OTEL instrumentor needed.

### Framework: Anthropic SDK (Claude Agent SDK)

**Install into the user's project venv:**

```bash
pip install /path/to/agentObserve/cli[anthropic]

# Or with uv:
uv pip install /path/to/agentObserve/cli[anthropic]
```

The `[anthropic]` extra installs `opentelemetry-instrumentation-anthropic` which auto-instruments all Anthropic API calls.

**Required environment variables:**

```bash
AGENTOBSERVE_ENABLED=1                            # activates the bootstrap hook
CLAUDE_CODE_ENABLE_TELEMETRY=1                     # enables Claude Code telemetry
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1              # enables trace spans
OTEL_METRICS_EXPORTER=otlp                         # REQUIRED: enable metrics export
OTEL_LOGS_EXPORTER=otlp                            # REQUIRED: enable logs/events export
OTEL_TRACES_EXPORTER=otlp                          # REQUIRED: enable trace spans export
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

**Caveats for Anthropic SDK:**
- The Claude Agent SDK emits its own OTEL spans — `agentobserve` creates a root span and propagates `TRACEPARENT` to subprocesses
- The env vars must be passed in `ClaudeCodeOptions.env` as well, because the SDK spawns a subprocess
- `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, and `OTEL_TRACES_EXPORTER` MUST be set to `otlp` — without them, Claude Code collects telemetry but sends nothing
- For multi-turn conversations using `resume`, preserve the same env vars across turns
- `TRACEPARENT` is auto-injected into `os.environ` by the bootstrap — pass it through if spawning subprocesses

**Optional env vars for richer telemetry:**

```bash
OTEL_LOG_USER_PROMPTS=1     # include user prompt text in logs
OTEL_LOG_TOOL_DETAILS=1     # include tool names and metadata
OTEL_LOG_TOOL_CONTENT=1     # include full tool input/output content
OTEL_LOG_RAW_API_BODIES=1   # include full API request/response JSON (enables capturedBlocks)
```

**Minimal integration pattern (Python SDK):**

```python
import os

os.environ["AGENTOBSERVE_ENABLED"] = "1"
os.environ["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
os.environ["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1"
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4318"
os.environ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"

from claude_code_sdk import ClaudeCodeOptions, query

options = ClaudeCodeOptions(
    max_turns=10,
    env={
        "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
        "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
        "OTEL_METRICS_EXPORTER": "otlp",
        "OTEL_LOGS_EXPORTER": "otlp",
        "OTEL_TRACES_EXPORTER": "otlp",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    },
)

async for msg in query(prompt="Hello!", options=options):
    print(msg)
```

**Direct CLI usage (no SDK wrapper):**

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
OTEL_METRICS_EXPORTER=otlp \
OTEL_LOGS_EXPORTER=otlp \
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_LOG_USER_PROMPTS=1 \
OTEL_LOG_TOOL_DETAILS=1 \
OTEL_LOG_TOOL_CONTENT=1 \
OTEL_LOG_RAW_API_BODIES=1 \
claude
```

### How the Client Library Works (for reference)

The `agentobserve` package (`cli/src/agentobserve/`) uses `hatch-autorun` to run `_bootstrap.py` at import time:

1. `_bootstrap.py` checks `AGENTOBSERVE_ENABLED` env var — if not set, does nothing
2. If set, calls `_auto.setup()` which:
   - Creates an OTEL `TracerProvider` with `OTLPSpanExporter` pointing at the receiver
   - Discovers and activates all installed OTEL instrumentors (anthropic, langchain, openai)
   - For non-LangChain: creates a root `agentobserve.session` span and injects `TRACEPARENT`
   - Registers an `atexit` handler to flush and shutdown cleanly

This means **no code changes** in the user's agent — just install the package and set env vars.

---

## Architecture Reference

```
OTEL Receiver (otel_receiver.py)
  -> telemetry/<session_id>/ (.pb + .json)
    -> Loader (server/loader.js) — reads JSON, groups by session
      -> Adapters (server/adapters/) — framework-specific parsing
        -> Express API (server/routes.js) — serves canonical schema at :3001
          -> React Frontend (Vite) — session list, workflow graph, step panel
```

## Key File Paths

| File | Purpose |
|---|---|
| `otel_receiver.py` | FastAPI OTEL receiver, saves protobuf + JSON |
| `cli/` | Python package (`agentobserve`) — client instrumentation lib |
| `cli/src/agentobserve/_auto.py` | OTEL TracerProvider setup, instrumentor loading |
| `cli/src/agentobserve/_bootstrap.py` | Auto-activation hook (checks `AGENTOBSERVE_ENABLED`) |
| `cli/pyproject.toml` | Package definition with `[anthropic]`, `[langchain]`, `[openai]` extras |
| `server/loader.js` | Reads telemetry dirs, groups spans/logs by session ID |
| `server/adapters/index.js` | Adapter registry — detection + routing |
| `server/adapters/shared.js` | Shared utils: `nanoToMs`, `nanoToDate`, `sortByStart`, `buildWorkflowNode`, `getDescendants`, `detectWorkflowNodeKind` |
| `server/adapters/anthropic.js` | Anthropic/Claude Code adapter |
| `server/adapters/langchain.js` | LangChain/LangGraph adapter |
| `server/parser.js` | Re-exports `buildSessions()` from adapters |
| `server/routes.js` | GET `/api/sessions` (list) and `/api/sessions/:id` (detail) |
| `src/components/WorkflowGraph.jsx` | Renders pipeline workflow nodes |
| `src/components/StepPanel.jsx` | AgentStep cascade (LLM_CALL, TOOL, HOOK nodes) |

## Canonical Schema

Every adapter returns this shape. Fields a framework can't populate use the listed defaults.

### Session
```
id, framework ('claude-code-cli'|'anthropic-sdk'|'langchain'), startTime, endTime, turnCount,
totalCost (0), totalInputTokens, totalOutputTokens, systemPrompt (''),
availableTools ([]), turns[]
```

### Turn
```
idx, userPrompt (''), startTime, endTime, durationMs, totalCost (0),
totalInputTokens, totalOutputTokens, steps[], workflowGraph
```

### Step (discriminated on `type`)
- **PROMPT**: `{ type, text }`
- **AGENT**: `{ type, nodes: AgentNode[], capturedBlocks, upstreamPre, upstreamPost, userPrompt }`
- **FINAL**: `{ type, totalCost, totalInputTokens, totalOutputTokens, durationMs }`

### AgentNode (discriminated on `kind`)
- **LLM_CALL**: `kind, model, inputTokens, outputTokens, cacheReadTokens (0), cacheCreationTokens (0), costUsd (0), durationMs, ttftMs (0), stopReason (''), requestId (''), blocks ([]), graphNode ('')`
- **TOOL**: `kind, toolUseId, toolName, decision ('unknown'), source (''), toolInput (''), toolResultSizeBytes (0), durationMs, success (true)`
- **HOOK**: `kind, hookName, hookEvent, durationMs, success, numHooks, numSuccess`
- **AGENT**: `kind, agentName, agentType ('subagent'|'task'|''), source (''), nodes: AgentNode[], durationMs, startTime, endTime` — recursive: `nodes` may itself contain AGENT-kind entries. Use the shared `classifyAgentNodeKind` / `buildNestedAgentStep` helpers in `shared.js` to detect and emit these uniformly at any depth.

### Block (discriminated on `type`)
- **THOUGHT**: `{ type, text }`
- **TEXT**: `{ type, text }`
- **TOOL_USE**: `{ type, id, name, input }`
- **TOOL_RESULT**: `{ type, id, name, text, is_error? }`
- **AGENT_RESPONSE**: `{ type, text }`

### WorkflowGraph / WorkflowNode
- `WorkflowGraph`: `{ hasPipeline, groups: [{ groupIdx, nodes: WorkflowNode[] }] }`
- `WorkflowNode`: `nodeId, kind ('AGENT'|'UPSTREAM_LLM'|'DOWNSTREAM_LLM'|'PIPELINE_MEMBER'), label, spanName, model (''), durationMs, inputTokens (0), outputTokens (0), maxTokens (0), inputText (''), outputText (''), systemText (''), agentStepData (null)`

## Adapter Contract

Each adapter in `server/adapters/` exports:

```js
export const FRAMEWORK = 'myframework';
export function canHandle(rawData) { ... }
export function buildSession(sessionId, rawData, orphanSpans = []) { ... }
```

Detection priority in `adapters/index.js`: anthropic -> langchain (first `canHandle` wins).

## Adding a New Adapter

1. Create `server/adapters/<name>.js`
2. Export `FRAMEWORK`, `canHandle(rawData)`, `buildSession(sessionId, rawData, orphanSpans)`
3. Import shared utils from `./shared.js` and `getAttr` from `../loader.js`
4. Register in `server/adapters/index.js`
5. Return a session matching the canonical schema

### Agent detection — do NOT hardcode span names

Use the shared `detectWorkflowNodeKind` helper. It returns `'AGENT'` or
`'PIPELINE_MEMBER'` for a workflow child. Rules, in priority order:

1. **Strong signal:** any descendant matches `isAgentSpan` → AGENT.
2. **Iterative reasoning fallback:** ≥2 LLM descendants → AGENT.
3. **Tool dispatch fallback:** any tool invocation → AGENT.
4. Else → PIPELINE_MEMBER.

The helper is framework-agnostic; your adapter supplies up to three
predicates that say what these spans look like in your telemetry:

```js
import { detectWorkflowNodeKind } from './shared.js';
import { getAttr } from '../loader.js';

// Prefer OTEL gen_ai semantic conventions when the framework follows them.
const isLLM  = (s) => getAttr(s.attributes, 'gen_ai.operation.name') === 'chat';
const isTool = (s) => getAttr(s.attributes, 'gen_ai.operation.name') === 'execute_tool';

// Optional. Strongly recommended — catches one-shot agent runs (single LLM,
// no tools) that the structural fallbacks miss. Use the framework's own
// agent-boundary marker, or the OTEL standard `invoke_agent`.
const isAgentSpan = (s) =>
  getAttr(s.attributes, 'gen_ai.operation.name') === 'invoke_agent';

const kind = detectWorkflowNodeKind(child.spanId, childrenOf, isLLM, isTool, isAgentSpan);
```

If a framework emits non-OTEL attributes (e.g. LangSmith's
`langsmith.span.kind === 'llm'` or `langsmith.metadata.langgraph_node`),
OR them into the predicate inside the adapter — never push framework-
specific branches into `shared.js`. `server/adapters/langchain.js` is the
working reference: its `isAgentSpan` checks for `langsmith.metadata.langgraph_node`
because LangGraph stamps every span inside a graph node with it.

### Structured-output LLM calls — watch for empty `text`

If a new adapter reports an LLM span where the user sees a JSON object in
the source telemetry but agentObserve renders the output as empty, the
cause is almost always **schema-bound tool use**.

LangChain (`.with_structured_output(...)`, `.bind_tools(..., tool_choice="any")`,
JSON-mode bindings), the OpenAI function-calling API, Anthropic's
tool-use, and Bedrock Converse with toolConfig all share one mechanism:
the LLM emits the structured payload as the *arguments* of a synthetic
tool call. The provider returns an assistant message whose `text` is empty
and whose `content` array contains a `tool_use` block carrying the
structured payload as `input`.

Captured shape (LangChain serialization):
```
{ generations: [[{
    text: "",                                       ← EMPTY
    message: { kwargs: { content: [
      { type: "tool_use", name: "<Schema>",
        input: { …the answer… }, id: "tooluse_…" }
    ] } }
}]] }
```
Other frameworks differ in field names but follow the same pattern: prefer
text → empty → walk the assistant message's content blocks for tool_use
inputs and stringify them.

The working reference is `extractCompletionText` in
`server/adapters/langchain.js` (block comment above it details the
serialization shape). When adding a new adapter, port the same idea:

1. Read the LLM's text first.
2. If empty, scan the assistant message's content blocks for `text` and
   `tool_use` entries.
3. Concatenate `text` blocks; pretty-print `tool_use.input` (or
   equivalent — `function_call.arguments` for legacy OpenAI, etc.).

Symptoms that point here: guardrails / plain chat models render
correctly; classifiers / planners / extractors return empty.
