# agentObserve

Agent observability platform — visualizes OpenTelemetry traces from AI agent frameworks. See every LLM call, tool use, and workflow step your agent makes, locally.

![agentObserve Dashboard](docs/dashboard.png)

Supports **LangChain / LangGraph**, the **Anthropic SDK / Claude Agent SDK**, and **Claude Code**.

```
your agent  -->  Receiver (:4318)  -->  API (:3001)  -->  Dashboard (:5173)
                  receives OTEL          parses sessions     React + Vite
```

---

## Quickstart

### 1. Start the dashboard

Prereq: **Docker** ([install](https://docs.docker.com/get-docker/)).

```bash
git clone https://github.com/Photon48/agentObserve.git
cd agentObserve
make upd
```

Open **http://localhost:5173**. Telemetry persists in `./telemetry/` and survives restarts.

#### Commands

The `Makefile` wraps `docker compose` with one-letter suffixes — `d` = detached, `b` = (re)build:

| Command | What it does |
|---|---|
| `make up` | Foreground, no rebuild. Streams logs from the current images. |
| `make upd` | Detached, no rebuild. **Use this for day-to-day starts.** |
| `make upb` | Foreground, **rebuild** images from source, then start. Prunes dangling images. |
| `make upbd` | Detached, **rebuild** images from source, then start. Prunes dangling images. **Use this to upgrade.** |
| `make down` | Stop and remove containers. Data in `./telemetry/` is preserved. |

The `--build` flag is what tells Docker to pick up source changes; without it, `docker compose up` reuses the existing image and you keep seeing the old build. The `b` shortcuts always rebuild, and follow up with `docker image prune -f` so the previous build's untagged layers don't pile up.

### Upgrading

When a new version drops, from your `agentObserve/` checkout:

```bash
git pull
make upbd
```

That rebuilds all three images against the new source, replaces the running containers in place, and removes the now-untagged previous images. Same single port (5173), no manual cleanup.

### 2. Connect your agent

Pick the section that matches your framework.

---

### LangChain / LangGraph

```bash
# from your agent project's venv
pip install /path/to/agentObserve/cli[langchain]
```

Set these env vars before importing LangChain:

```bash
export AGENTOBSERVE_ENABLED=1
export LANGCHAIN_TRACING_V2=true
export LANGSMITH_OTEL_ONLY=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Run your agent. Traces appear at http://localhost:5173.

**Grouping non-graph LLM calls into the same trace.** If you call `.invoke()` *outside* the LangGraph context (guardrails, NER, post-processing), wrap your request handler with `@traceable`:

```python
from langsmith import traceable

@traceable(run_type="chain", name="ai_request")
async def handle_request(...):
    # everything called from here attaches as descendants of this span
    ...
```

---

### Anthropic SDK / Claude Agent SDK

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

---

### Claude Code

**No Python install needed.** Add an `"env"` block to your `.claude/settings.json` — the same file you already use for hooks, plugins, and permissions. Two scopes:

- **Project-level** — `<your-project>/.claude/settings.json`. Applies only when `claude` runs from that directory.
- **User-level** — `~/.claude/settings.json`. Applies to every `claude` session.

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

---

## How it works

1. Your agent emits OTEL traces (and optionally logs/events) to the **receiver** at `localhost:4318`.
2. The receiver writes protobuf + JSON files into `telemetry/<session_id>/`.
3. The **API server** loads those files, auto-detects which framework produced them, and parses them into a canonical session schema (turns, steps, LLM calls, tool calls, agent hierarchy).
4. The **React dashboard** fetches sessions from the API and renders workflow graphs, agent-step cascades, timing bars, and token / cost summaries.

Everything stays on your machine.

## License & copyright

agentObserve is **Copyright (c) 2026 Rishu Goyal** and licensed under the [Business Source License 1.1](LICENSE) (BSL 1.1).

**Plain English:**

- ✅ Free to **self-host, modify, fork, and embed** agentObserve inside your own products, internal tooling, and customer-facing services — commercial or otherwise.
- ✅ Free to install the **client SDK** (`cli/` in this repo) into any agent project.
- ❌ You **may not offer agentObserve itself as a hosted or managed service** to third parties. This restriction is what funds open development through a future paid managed tier.
- 🔄 Each released version **automatically converts to Apache License 2.0** four years after its publication date.

Need a license that permits running agentObserve as a hosted service for your customers? Contact **rishu.goyal433@gmail.com** for commercial licensing.

Full license text in [LICENSE](LICENSE); third-party notices in [NOTICE](NOTICE).
