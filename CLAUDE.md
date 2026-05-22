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
CLAUDE_CODE_ENABLE_TELEMETRY=1                     # enables Claude Agent SDK telemetry
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1              # enables detailed span attributes
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

**Caveats for Anthropic SDK:**
- The Claude Agent SDK emits its own OTEL spans — `agentobserve` creates a root span and propagates `TRACEPARENT` to subprocesses
- The env vars must be passed in `ClaudeAgentOptions.env` as well, because the SDK spawns a subprocess
- For multi-turn conversations using `resume`, preserve the same env vars across turns
- `TRACEPARENT` is auto-injected into `os.environ` by the bootstrap — pass it through if spawning subprocesses

**Optional env vars for richer telemetry:**

```bash
OTEL_LOG_USER_PROMPTS=1     # include user prompt text in logs
OTEL_LOG_TOOL_DETAILS=1     # include tool names and metadata
OTEL_LOG_TOOL_CONTENT=1     # include full tool input/output content
```

**Minimal integration pattern:**

```python
import os

os.environ["AGENTOBSERVE_ENABLED"] = "1"
os.environ["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
os.environ["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1"
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4318"
os.environ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"

from claude_agent_sdk import ClaudeAgentOptions, query

options = ClaudeAgentOptions(
    system_prompt="You are a helpful assistant.",
    max_turns=10,
    permission_mode="bypassPermissions",
    env={
        "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
        "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    },
)

async for msg in query(prompt="Hello!", options=options):
    print(msg)
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
| `server/adapters/shared.js` | Shared utils: `nanoToMs`, `nanoToDate`, `sortByStart`, `buildWorkflowNode` |
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
id, framework ('anthropic'|'langchain'), startTime, endTime, turnCount,
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
