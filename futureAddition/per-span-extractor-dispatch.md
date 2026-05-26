# Per-span extractor dispatch (mixed-framework traces)

## Problem this addresses

Today the adapter system in `server/adapters/` dispatches **once per session**: each
adapter exposes `canHandle(rawData)`, the first match wins, and that adapter
builds the entire session.

This is fine when a session's spans all come from one framework. It breaks down
when a single trace contains spans from multiple frameworks — which happens
naturally in real services. Examples:

- A FastAPI request that calls LangChain (LangSmith spans) plus direct Anthropic
  SDK calls (OpenLLMetry / opentelemetry-instrumentation-anthropic spans).
- A LangGraph agent that uses tool implementations which themselves call
  OpenAI directly with `opentelemetry-instrumentation-openai`.
- Any service that has both a `[langchain]`-instrumented path and an
  `[anthropic]`-instrumented path active at the same time.

Under the current design, one adapter wins (say, `langchain`) and the
Anthropic-shaped spans get rendered with the wrong extraction logic — wrong
prompt format, missing token counts, missing tool blocks.

## What stays the same

- **Canonical schema** (Session → Turn → Step → AgentNode → Block) does not
  change. Consumers of the API see the same shape.
- **Tree traversal** is already framework-agnostic — parent/child links from
  OTEL are all that's needed. Today's `langchain.js` builds `childrenOf` and
  walks it; that part is reusable as-is.

## What needs to change

Split the adapter into two layers:

### 1. Generic OTEL session builder (new, in `server/adapters/`)

- Builds the parent/child index from `spans`.
- Finds turn roots: any span with no parent **in the set** (regardless of
  name).
- Walks each root subtree in OTEL-native order — parent-child, not timestamp.
  Timestamp is only the tiebreaker for siblings.
- For each span, calls into the framework extractor registry to produce the
  canonical `AgentNode` / `Block` shape.
- Assembles the Session.

This file owns no framework knowledge. It does not parse `gen_ai.prompt`. It
does not know what `LangGraph` or `ChatAnthropic` mean.

### 2. Per-span extractor registry (new, `server/adapters/extractors/`)

Each extractor exports:

```js
export const matches = (span) => boolean;        // does this extractor own this span?
export const extract = (span, ctx) => AgentNode | Block | null;
```

Dispatch order: first `matches` that returns true wins for that span.

Initial extractors to port from the existing adapters:

- `extractors/langsmith.js` — owns spans with `scope.name === 'langsmith'`.
  Pulls `gen_ai.prompt`, `gen_ai.completion`, the LangChain-serialized
  message format, `langsmith.span.kind`, the middleware spans. Logic comes
  from today's `langchain.js` (`extractPromptText`, `extractCompletionText`,
  `buildBlocksFromLLMSpan`, `extractLlmSpanInputText`,
  `extractLlmSpanSystemText`).
- `extractors/anthropic.js` — owns spans whose attributes contain
  `gen_ai.system === 'anthropic'` (or scope name matches
  `opentelemetry.instrumentation.anthropic`). Logic comes from today's
  `anthropic.js`.
- `extractors/openai.js` — same pattern for
  `opentelemetry-instrumentation-openai`, when added.
- `extractors/fastapi.js` (optional) — recognises FastAPI server spans
  (`http.method`, `http.route` attributes) so they render as workflow group
  containers in the UI rather than being treated as LLM calls. Without this
  they currently appear as empty / unknown nodes.

### 3. Adapter registry simplification

`server/adapters/index.js` no longer dispatches one adapter per session. It
always calls the generic builder. The `canHandle` mechanism is removed (or
kept only for fully bespoke pipelines that opt out of the generic builder).

## Why this is deferred, not urgent

The immediate use case (svc_ai_client) is single-framework: only LangSmith
spans, plus a FastAPI request span on top once
`opentelemetry-instrumentation-fastapi` is enabled. The narrower change
(widening `langchain.js` root filter + recognising FastAPI roots) covers it
cleanly. The full split above pays off when a second framework's spans start
showing up in the same trace.

## Migration path

1. Land the narrower fix first (root filter widening in `langchain.js` so it
   doesn't break under the new wrapper span — see git history around the
   `_auto.py` inbound-instrumentor split).
2. Build the generic OTEL session builder under a feature flag
   (env var `AGENTOBSERVE_ADAPTER=generic` or similar). Run both in parallel
   and diff their outputs on the same telemetry directory.
3. Port the langsmith extractor first; verify it matches current output on
   existing svc_ai_client sessions.
4. Port the anthropic extractor; verify against existing Claude Agent SDK
   sessions.
5. Switch default to generic; keep the legacy per-session adapters around
   for one release as a fallback.
6. Remove `canHandle` from the adapter contract; update
   `CLAUDE.md → Adding a New Adapter` to describe the extractor contract
   instead.

## Non-goals

- No change to the canonical schema.
- No change to UI components — they read the same JSON.
- No change to the OTEL receiver — it keeps writing raw protobuf+JSON
  per session.
- No timestamp-based grouping. Parent-child links from OTEL context
  propagation are the single source of truth for span relationships.
