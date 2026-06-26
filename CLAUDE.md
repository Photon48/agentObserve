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
OTEL_LOG_RAW_API_BODIES=file:/tmp/agentobserve_bodies  # full API JSON via file refs (no 60KB truncation)
```

**Why `file:<dir>` instead of `=1`:** the CLI caps inline body payloads at 60 KB. The JSON field order is `model → messages → system → tools → …`, so once messages cross ~60 KB (which happens by turn 2 of any non-trivial conversation), the `tools` array gets chopped off entirely and `safeParseBody` in `loader.js` returns null for those events. The dashboard then has no tool descriptions or input schemas to display. File mode writes each body to `<dir>/<uuid>.{request,response}.json`; the OTEL receiver moves these files into `telemetry/<session>/api_bodies/` on arrival, and the loader reads them via `body_ref`.

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
        "OTEL_LOG_RAW_API_BODIES": "file:/tmp/agentobserve_bodies",
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
OTEL_LOG_RAW_API_BODIES=file:/tmp/agentobserve_bodies \
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
totalCost (0), totalInputTokens, totalOutputTokens,
totalCacheReadTokens (0), totalCacheCreationTokens (0), totalContextInputTokens, cachePct (0),
systemPrompt (''), availableTools ([]), turns[]
```

### Turn
```
idx, userPrompt (''), startTime, endTime, durationMs, totalCost (0),
totalInputTokens, totalOutputTokens,
totalCacheReadTokens (0), totalCacheCreationTokens (0), totalContextInputTokens, cachePct (0),
steps[], workflowGraph, availableTools ([])
```
`idx` is the turn's identity within a session (0-based position in `session.turns`). `availableTools` is the per-turn union of tools offered to any AGENT scope in this turn — a subset of `session.availableTools` that shares JS object identity with the session-level entries (so schema inference applied at the session level propagates here automatically).

#### Cache-aware token fields (session + turn + FINAL)

`totalInputTokens` is **fresh** (uncached) input only — the raw Anthropic
`usage.input_tokens`. With prompt caching the model also reads reused context
(`totalCacheReadTokens`, the cascading conversation history) and writes new cache
(`totalCacheCreationTokens`). The input the model actually saw is
`totalContextInputTokens = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens`.
`cachePct` = `round(cacheRead / totalContext * 100)` — the share of input volume
served from cache (cache-creation counts as context but not as "served"). All of
these are summed from the per-LLM_CALL token fields and computed by the shared
`cachePct()` helper in `shared.js`. LangChain reads its cache counts from the
`langsmith.metadata.usage_metadata` span attribute (`input_token_details.cache_read`
/ `cache_creation`); the OTEL `gen_ai.usage.*` attributes never carry cache data.

### Step (discriminated on `type`)
- **PROMPT**: `{ type, text }`
- **AGENT**: `{ type, nodes: AgentNode[], capturedBlocks, upstreamPre, upstreamPost, userPrompt, toolCallCounts, availableTools, aggInputTokens, aggCacheReadTokens, aggCacheCreationTokens, aggOutputTokens, aggTotalInputTokens, cachePct }` — the `agg*` fields are the **recursive token rollup** for this agent ("an agent is an LLM in a loop"): the sum of every descendant LLM_CALL's tokens, descending into nested AGENT-kind sub-agents so a collapsed agent shows its full in/out. Computed by `stampAgentTokens` / `aggregateAgentTokens` in `shared.js` after each adapter's sub-agent promotion pass runs. `cachePct` is the agent's cache-hit share. `toolCallCounts: Record<string, number>` is a derived summary mapping each tool name to its invocation count among the **direct** TOOL-kind children of this AGENT step's `nodes` list. Calls inside nested AGENT-kind sub-agents are excluded — they surface only when the operator zooms into that sub-agent, which carries its own scope. Empty `{}` when no tools were called at this level. Produced by the shared `collectToolCallsFromAgentNodes` helper in `shared.js`. `availableTools: ToolDef[]` is the **strictly scoped** tool catalog for this AGENT — built only from the LLM definitions/request bodies tied to its own direct LLM_CALL children. Sub-agents' tools never leak up and parent tools never leak down. Shares object identity with `session.availableTools` and `turn.availableTools`. The frontend partitions this list (not the session union) into "called" vs "unused" in the tools sidebar.
- **FINAL**: `{ type, totalCost, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, totalContextInputTokens, cachePct, durationMs }` — token fields mirror the turn's (see "Cache-aware token fields" above).

### AgentNode (discriminated on `kind`)
- **LLM_CALL**: `kind, model, inputTokens, outputTokens, cacheReadTokens (0), cacheCreationTokens (0), costUsd (0), durationMs, ttftMs (0), stopReason (''), requestId (''), blocks ([]), graphNode ('')`
- **TOOL**: `kind, toolUseId, toolName, decision ('unknown'), source (''), toolInput (''), toolResultSizeBytes (0), callTokens (null), resultTokens (null), durationMs, success (true), error? ('')` — a tool has **no token cost of its own**. `callTokens` is the output tokens the dispatching model spent *writing* this tool call (this tool's TOOL_USE block's share of the producing LLM_CALL's exact `outputTokens`); `resultTokens` is the result text tokens *read back* on the next message (the matched TOOL_RESULT block's tokenized text, falling back to `toolResultSizeBytes/4` when the result text was not captured, e.g. `OTEL_LOG_TOOL_CONTENT` off). Both are derived from the exact per-LLM-call token counts by `enrichToolTokens` in `server/toolTokens.js` (see the Block-level attribution note below) and are `null` when unknown so the FE renders an em dash rather than a misleading 0. The proportioning ratio uses `ai-tokenizer` keyed on the dispatching model's encoding, but the per-message total it divides is always the exact API figure.
- **HOOK**: `kind, hookName, hookEvent, durationMs, success, numHooks, numSuccess`
- **AGENT**: `kind, agentName, agentType ('subagent'|'task'|''), source (''), nodes: AgentNode[], durationMs, startTime, endTime, availableTools, aggInputTokens, aggCacheReadTokens, aggCacheCreationTokens, aggOutputTokens, aggTotalInputTokens, cachePct` — recursive: `nodes` may itself contain AGENT-kind entries. The `agg*`/`cachePct` fields are the recursive token rollup for this sub-agent (sum of all descendant LLM_CALLs incl. nested sub-agents), stamped by `stampAgentAggregates` in `shared.js` — the FE shows these on the collapsed sub-agent card. `availableTools` follows the same strict-isolation rule as the AGENT step (only this sub-agent's own direct LLM_CALL children contribute). Use the shared `classifyAgentNodeKind` helper in `shared.js` to detect these; each adapter then emits them through its own recursive promotion pass (`promoteSubAgentsSDK` in `anthropic.js`, `promoteSubAgents` in `claude_code_cli.js`, `buildScopedAgentStep` in `langchain.js`).

#### Parallel grouping on AgentNodes

When the model emits **N ≥ 2 tool_use blocks in a single LLM response**, the matching TOOL- and AGENT-kind AgentNodes are stamped with four optional fields that the FE carousel (`src/components/agentStep/ParallelCarousel.jsx`) coalesces on:

- `parallelGroup: string` — stable id `pg_<firstToolUseId>` shared by every member of one batch
- `parallelSize: number` — group cardinality (always `≥ 2`)
- `parallelIndex: number` — 0-based position within the group, matching the emission order in the LLM response
- `parallelSiblingNames: string[]` — display names of every member, in group order, so the FE can render a "siblings: Bash, Read" label without re-scanning

**Semantic:** the signal is model-emitted parallelism — what the agent decided to dispatch concurrently in one decision — NOT runtime scheduler concurrency. Tools that happen to execute with overlapping wall-clock time but came from separate LLM responses are NOT grouped (that case is visualized in the workflow graph, not the agent-step carousel).

**Detection is per-adapter, from each framework's raw OTEL data** (no shared timing detector):

| Framework | Source of the parallel batch |
|---|---|
| Claude Code CLI | `responseBodies[reqId].content` — any content array with ≥2 `tool_use` blocks |
| Anthropic SDK | `responseBodies[reqId].content`, plus `capturedTurn.messages[m].blocks` when the SDK capture is present |
| LangChain / LangGraph | LLM span `gen_ai.completion → JSON.parse → kwargs.tool_calls` (parallel array LangChain always populates on tool-calling responses); fallback to `kwargs.content` tool_use blocks |

Adapters extract the list of model-native tool_use ids for each batch and pass it to the shared `stampParallelGroup(nodes, toolUseIds)` helper (`server/adapters/shared.js`), which locates every TOOL/AGENT AgentNode whose `toolUseId` matches and stamps the four fields. The group id is built via `parallelGroupIdFor(toolUseIds)` so the format stays centralized. Adapters recurse into nested `AGENT.nodes` so a sub-agent's own parallel batches get stamped at that scope.

### Block (discriminated on `type`)

#### Block-level token attribution

Every output-bearing block carries a `tokens` field — the exact per-LLM-call
token counts attributed down to the block. A message's `output_tokens` is exact
(from the API) but not itemized per block, so `enrichToolTokens` in
`server/toolTokens.js` **splits that exact total** across the message's OUTPUT
blocks (THOUGHT / TEXT / TOOL_USE / AGENT_RESPONSE) in proportion to each
block's tokenized size, using largest-remainder (Hamilton) rounding so
`Σ output-block tokens === node.outputTokens` exactly. A redacted THOUGHT (empty
text, real cost) gets a `signature`-derived floor weight so its share isn't
absorbed by siblings. A TOOL_RESULT is **not** part of the producing call's
output — it is read by the *next* message — so its `tokens` is just its
tokenized result text. `tokens` is **omitted** (not 0) when block content is
unavailable (capture off) so the FE can tell "not measured" from "zero". The
pass stamps `node.blocks` authoritatively then reconciles onto the turn's
flattened `capturedBlocks` (by `id` for TOOL_USE/TOOL_RESULT; by ordered
type+position for text blocks, treating TEXT ≡ AGENT_RESPONSE). It is
framework-agnostic: adapters only emit blocks + exact LLM_CALL token fields.

- **THOUGHT**: `{ type, text, redacted? (false), signature? (''), tokens? }` — Anthropic's
  extended-thinking emits two physically distinct upstream shapes (an
  unredacted `thinking` block with raw reasoning, and either a
  `redacted_thinking` block or a `thinking` block whose `thinking` field
  is the literal string `<REDACTED>` plus an opaque `signature` blob).
  All three adapters collapse both redacted shapes into one canonical
  form: `text === ''` AND `redacted === true`, with the crypto blob
  preserved in `signature`. Unredacted reasoning content lands in `text`
  with `redacted === false`. The FE shows a "redacted by anthropic"
  badge for the redacted case; `signature` stays in the data model but
  is not surfaced in the UI. Normalization lives in
  `normalizeAnthropicContentBlock` in `server/adapters/shared.js` —
  every adapter that may see Anthropic content blocks (anthropic-sdk,
  claude-code-cli, langchain with a Claude backend) routes through it.
- **TEXT**: `{ type, text, tokens? }` — `tokens` is this block's share of the producing message's output (see Block-level attribution above).
- **TOOL_USE**: `{ type, id, name, input, tokens? }` — `tokens` is the output cost of writing this tool call (== the matched TOOL node's `callTokens`).
- **TOOL_RESULT**: `{ type, id, name, text, is_error?, success?, errorText?, durationMs?, tokens? }` — `success`, `errorText`, and `durationMs` are populated by the adapter at emit time from the matched TOOL AgentNode so pairing/status rendering on the FE stays block-local (no cross-reference walk needed). `is_error` is the original Anthropic flag; `success === false` is the canonical source of truth and prefers `errorText` over `text` for the failure reason. `tokens` is the tokenized result text — the "result cost" read by the next message (== the matched TOOL node's `resultTokens`), stamped post-parse by `enrichToolTokens` so the FE can show it without a node lookup.
- **AGENT_RESPONSE**: `{ type, text, tokens? }` — `tokens` as for TEXT (this is the final reply block).

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
