# agentObserve

Agent observability platform — visualizes OpenTelemetry traces from AI agent frameworks. See every LLM call, tool use, and workflow step your agent makes, locally.

![agentObserve Dashboard](docs/dashboard.png)

Supports **LangChain / LangGraph**, the **Anthropic SDK / Claude Agent SDK**, and the **raw `claude` CLI**.

```
your agent  -->  Receiver (:4318)  -->  API (:3001)  -->  Dashboard (:5173)
                  receives OTEL          parses sessions     React + Vite
```

---

## Part A — Run the dashboard

Prereq: **Docker** ([install](https://docs.docker.com/get-docker/)). No Node, Python, or `uv` required.

```bash
git clone https://github.com/Photon48/agentObserve.git
cd agentObserve
docker compose up -d
```

Open **http://localhost:5173**.

Telemetry persists in `./telemetry/` on the host (mounted into the containers as `/data`), so sessions survive restarts and reboots.

### Lifecycle

| Command | What it does |
|---|---|
| `docker compose up -d` | Start all 3 services in the background |
| `docker compose down` | Stop and remove containers |
| `docker compose restart` | Restart all services |
| `docker compose ps` | Show running services and their ports |
| `docker compose logs -f` | Tail logs from all services |
| `docker compose pull && docker compose up -d` | Upgrade to the latest released images |

### Hacking on agentObserve itself

For hot-reload development — edit code on the host, see changes instantly in the running stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

The dev override swaps nginx for the Vite dev server, runs the API under `node --watch`, and runs the receiver with `uvicorn --reload`. All three source trees are bind-mounted from the host.

---

## Part B — Send your agent's traces in

Three self-contained paths. **Pick the one that matches what you're running** — each block is standalone, no cross-references.

### B.1 — LangChain / LangGraph

```bash
# from your agent project's venv
pip install /path/to/agentObserve/cli[langchain]
```

Set these env vars before importing LangChain (in code or in your shell):

```bash
export AGENTOBSERVE_ENABLED=1
export LANGCHAIN_TRACING_V2=true
export LANGSMITH_OTEL_ONLY=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Run your agent. Traces appear at http://localhost:5173.

LangSmith's built-in OTEL exporter handles routing — no code changes anywhere in your graph.

**Grouping non-graph LLM calls into the same trace.** If you call `.invoke()` *outside* the LangGraph context (guardrails, NER, post-processing), wrap your request handler with `@traceable`:

```python
from langsmith import traceable

@traceable(run_type="chain", name="ai_request")
async def handle_request(...):
    # everything called from here attaches as descendants of this span
    ...
```

### B.2 — Anthropic SDK / Claude Agent SDK

```bash
# from your agent project's venv
pip install /path/to/agentObserve/cli[anthropic]
```

Set these env vars before instantiating the SDK:

```bash
export AGENTOBSERVE_ENABLED=1
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Optional but recommended — richer traces (sub-agents, thoughts, full tool I/O)
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_LOG_TOOL_CONTENT=1
export OTEL_LOG_RAW_API_BODIES=file:/tmp/agentobserve_bodies
```

If you spawn `claude` via the Python SDK, mirror the same env vars into `ClaudeCodeOptions.env` — the SDK runs the CLI in a subprocess that doesn't inherit your shell exports:

```python
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

### B.3 — Raw Claude Code CLI

**No Python install needed.** Add an `"env"` block to your existing `.claude/settings.json` — the same file you already use for hooks, plugins, and permissions. Two scopes:

- **Project-level** — `<your-project>/.claude/settings.json`. Applies only when `claude` runs from that directory.
- **User-level** — `~/.claude/settings.json`. Applies to every `claude` session, regardless of cwd.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
    "OTEL_LOG_RAW_API_BODIES": "file:/tmp/agentobserve_bodies"
  }
}
```

If `settings.json` already exists, add the `env` key alongside whatever else is there — Claude Code merges, it doesn't overwrite.

Restart `claude`. Traces flow.

**Why `OTEL_LOG_RAW_API_BODIES=file:<dir>` and not `=1`:** the inline form caps each body at 60 KB, which truncates the `tools` array off the end of any multi-turn conversation and leaves the dashboard without tool descriptions or input schemas. File mode writes untruncated bodies to disk; the receiver moves them into `telemetry/<session>/api_bodies/`.

---

## Updates

On startup, the API service polls GitHub for the latest release of agentObserve and exposes the result at `GET /api/version`. The dashboard renders a dismissible banner at the top whenever you're behind, including the one-line upgrade command. Dismissals are per-version — dismissing v1.3.0 doesn't suppress v1.4.0.

To suppress the check entirely:

```bash
AGENTOBSERVE_UPDATE_SOURCE=disabled docker compose up -d
```

---

## How it works

1. Your agent emits OTEL traces (and optionally logs/events) to the **receiver** at `localhost:4318`.
2. The receiver writes protobuf + JSON files into `telemetry/<session_id>/`.
3. The **API server** loads those files, auto-detects which framework produced them, and parses them into a canonical session schema (turns, steps, LLM calls, tool calls, agent hierarchy).
4. The **React dashboard** fetches sessions from the API and renders workflow graphs, agent-step cascades, timing bars, and token / cost summaries.

Everything stays on your machine.

## Adding adapter support

agentObserve uses an adapter pattern so new frameworks can plug in without touching shared code. To add one:

1. Create `server/adapters/<name>.js`.
2. Export `FRAMEWORK`, `canHandle(rawData)`, and `buildSession(sessionId, rawData, orphanSpans)`.
3. Register it in `server/adapters/index.js`.

See `server/adapters/langchain.js` for the most complete reference (handles structured outputs, parallel tool calls, sub-agents, and the LangSmith-vs-OTEL attribute split).

## License & copyright

agentObserve is **Copyright (c) 2026 Rishu Goyal** and licensed under the [Business Source License 1.1](LICENSE) (BSL 1.1).

**Plain English:**

- ✅ Free to **self-host, modify, fork, and embed** agentObserve inside your own products, internal tooling, and customer-facing services — commercial or otherwise.
- ✅ Free to install the **client SDK** (`cli/` in this repo) into any agent project.
- ❌ You **may not offer agentObserve itself as a hosted or managed service** to third parties. This restriction is what funds open development through a future paid managed tier.
- 🔄 Each released version **automatically converts to Apache License 2.0** four years after its publication date.

Need a license that permits running agentObserve as a hosted service for your customers? Contact **rishu.goyal433@gmail.com** for commercial licensing.

Full license text in [LICENSE](LICENSE); third-party notices in [NOTICE](NOTICE).
