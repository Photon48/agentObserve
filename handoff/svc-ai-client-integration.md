# Handoff: svc_ai_client → agentObserve integration

**Status:** install complete; diagnosis complete; plan agreed; **changes not yet executed**.

## 1. Current state

- **python-svc branch:** `experiment/agentobserve` (off `AIX-MantleAWSTransition`) at
  `~/Documents/deputy/python-svc`. Uncommitted — review before commit.
- **agentObserve server:** already running locally. `make start` from
  `~/Documents/agentObserve`. Receiver :4318, Express :3001, Vite :5173.
  Dashboard at <http://localhost:5173>.
- **Client install:** `agentObserve/cli/` vendored to
  `python-svc/libs/agentobserve/` (mirrors the `libs/feature_flags` pattern).
  Wired into `svc_ai_client/pyproject.toml` via
  `[tool.uv.sources] agentobserve = {path = "../../libs/agentobserve"}` and
  the `[langchain]` extra. `Dockerfile` gained
  `COPY ./libs/agentobserve /build/libs/agentobserve`. `uv.lock` regenerated.
- **Env vars** (`svc_ai_client/docker-compose.yml`): `AGENTOBSERVE_ENABLED=1`,
  `LANGCHAIN_TRACING_V2=true`, `LANGSMITH_OTEL_ONLY=true`,
  `LANGCHAIN_PROJECT=svc_ai_client_local`,
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`,
  `OTEL_SERVICE_NAME=${TARGET}`. Plus
  `extra_hosts: host.docker.internal:host-gateway`.
- **Run command:** `TARGET=svc_ai_client mk compose.upb` from python-svc root.

## 2. The problem

After rebuild + traffic, telemetry lands but the dashboard renders **only the
LangGraph scheduling agent**. All other LLM calls in svc_ai_client (guardrails,
NER, tool_planner, RAG router, tone_of_voice) are invisible in the UI.

## 3. Diagnosis (don't redo — already verified)

Inspected `telemetry/svc_ai_client_local/traces_*.json` for one user request:

- **52 spans captured**, all under `langsmith` scope.
- Split across **15 distinct `traceId`s**:
  - 3 rooted at `LangGraph` (scheduling agent)
  - 3 rooted at `RunnableSequence` (NER, tool_planner)
  - 9 rooted at standalone `ChatBedrockConverse` (guardrails, tone_of_voice)

The data is fully captured. The gap is rendering: `server/adapters/langchain.js:227`
keeps only spans where `name === 'LangGraph'` and silently drops the other 14
traces.

**Why 15 traces:** each `.invoke()` outside the LangGraph context starts a fresh
trace because no parent OTEL span exists. LangSmith nests under an existing
OTEL parent if one is in the context-var — without one, every top-level
`.invoke()` is its own root.

**ddtrace is not the cause.** Disabling Datadog will not change what
agentObserve sees. ddtrace uses its own internal tracer, not OTEL.

## 4. Agreed approach (universal, not FastAPI-specific)

Create the parent span at the request boundary using **OTEL auto-instrumentation**
— the same mechanism that gives ddtrace a free FastAPI request span for
Datadog. Real parent-child relationships via OTEL context propagation. Never
timestamp-based.

agentobserve already discovers any installed inbound instrumentor via
`entry_points("opentelemetry_instrumentor")`. The user picks whichever
instrumentor matches their stack (FastAPI / Flask / Django / ASGI / gRPC /
Lambda / Celery / …). agentobserve does **not** bundle one.

### Three changes

| File | Change |
|---|---|
| `agentObserve/cli/src/agentobserve/_auto.py` | Today: skips ALL instrumentor loading in `LANGSMITH_OTEL_ONLY` mode (line 34) — too coarse. Change: only skip outbound HTTP-client patches (`urllib3`, `requests`, `httpx`, `aiohttp-client` — these break AWS SigV4). Load all other entry-point instrumentors through. Also: if no inbound instrumentor fires, fall back to the existing `agentobserve.session` process-level root span (currently also skipped in this mode). ~15 lines. |
| `python-svc/src/svc_ai_client/pyproject.toml` | Add `opentelemetry-instrumentation-fastapi` to dependencies. This is the **user's** choice of inbound instrumentor; a Flask svc would add the Flask one instead. Run `uv lock` after. 1 dep line + uv.lock. |
| `agentObserve/server/adapters/langchain.js` | Two edits, additive: (1) widen the root filter at line 227 from `name === 'LangGraph'` to "any span with no parent in the set"; (2) in `buildTurn`, find the `LangGraph` descendant inside the turn root and route it through the existing agent-extraction code unchanged. Standalone `ChatBedrockConverse` and `RunnableSequence` children become additional `UPSTREAM_LLM`/`DOWNSTREAM_LLM` workflow nodes using helpers already in the file. ~30 lines. |

After the `_auto.py` change, **re-vendor** `agentObserve/cli/` → `python-svc/libs/agentobserve/`
(use `rsync -a --exclude='__pycache__'`).

### What stays untouched

- All existing helpers in `langchain.js` (`extractPromptText`,
  `extractLlmSpanInputText`, `buildBlocksFromLLMSpan`, middleware handling).
- LangGraph subtree rendering — byte-identical output for the agent step.
- The Anthropic adapter. The canonical schema. The OTEL receiver.
- No code changes in python-svc — only one dep line.

## 5. Validation

After rebuild:

1. Hit `/ai/v1/kickoff` or `/ai/v1/chat` once.
2. In `telemetry/svc_ai_client_local/`, all spans for that request should
   share **one `traceId`** (aggregate with the snippet below).
3. Dashboard should show one turn per request with all components as
   connected nodes; agent step internals unchanged.

Aggregation snippet (run from `telemetry/svc_ai_client_local/`):
```bash
python3 -c "
import json, glob
ids = set()
for f in sorted(glob.glob('traces_*.json')):
    for rs in json.load(open(f)).get('resourceSpans', []):
        for ss in rs.get('scopeSpans', []):
            for s in ss.get('spans', []):
                ids.add(s.get('traceId'))
print(f'Distinct trace IDs: {len(ids)}')
"
```
Before: ~15 per request. After: 1.

### If validation fails

Most likely cause: `langsmith[otel]` not honouring the OTEL parent context
(version-dependent wart). **Diagnose against the captured `traces_*.json`
before changing strategy.** Do **not** start adding code to python-svc as a
workaround.

## 6. Anti-patterns

- Don't hardcode span names in the adapter ("agent_turn", "LangGraph",
  anything). Adapter must be framework-aware but service-agnostic.
- Don't bundle a specific server instrumentor in agentobserve's `[langchain]`
  extra. Users install what matches their stack.
- Don't synthesize parent-child from timestamps. OTEL context only.
- Don't disable ddtrace to "fix" tracing. It isn't interfering.
- Don't add code to python-svc beyond a single dep line.

## 7. Deferred — bigger refactor

See `agentObserve/futureAddition/per-span-extractor-dispatch.md`. Splits the
adapter system into a generic OTEL traversal layer + per-span framework-specific
extractors. Pays off when one trace contains spans from multiple frameworks
(e.g., LangSmith + Anthropic SDK + OpenAI). Not needed for this experiment.

## 8. File pointers

**agentObserve:**
- Adapter: `server/adapters/langchain.js`
- Bootstrap: `cli/src/agentobserve/_auto.py` (note local modifications exist)
- Receiver: `otel_receiver.py`
- Captured telemetry: `telemetry/svc_ai_client_local/`

**python-svc (`~/Documents/deputy/python-svc`, on `experiment/agentobserve`):**
- Compose: `src/svc_ai_client/docker-compose.yml`
- Dockerfile: `src/svc_ai_client/Dockerfile`
- Pyproject: `src/svc_ai_client/pyproject.toml`
- Vendored client: `libs/agentobserve/`
- LangChain LLM call sites (all `ChatBedrockConverse` via `utils/llm_utils.py:create_bedrock_model`):
  - `flows/components/guardrails.py:125` (LLM classifier — captured)
  - `flows/components/tone_of_voice.py:208,357,482`
  - `preprompt/tool_planner.py:260`
  - `NER/entity_extractor.py:193`
- **Direct boto3 call (NOT a LangChain wrapper — will not appear in LangSmith
  traces, separate from the LLM classifier above):** `tools/guardrail.py:42`
  (`apply_guardrail` for AWS Bedrock guardrail API).

## 9. Memory pointers

Already saved at
`~/.claude/projects/-Users-rishugoyalmantel-Documents-agentObserve/memory/`:
- `user_role.md` — Deputy engineer, python-svc + agentObserve context
- `project_python_svc_integration.md` — branch + integration approach
- `MEMORY.md` — index

## 10. User preferences observed this session

- Wants **minimal code in python-svc**. Adapter fixes preferred over
  service-side edits.
- Wants **agentObserve to stay distributable**. No service-specific names in
  adapter; no framework-specific bundles in extras.
- Wants **real parent-child relationships from OTEL**, not timestamp-based
  grouping.
- Wants **methodical reasoning, scoped diagnosis, succinct answers**. Less
  prose, more decisions.
- The integration **should coexist with Datadog**, not replace it. Both run
  in parallel.
