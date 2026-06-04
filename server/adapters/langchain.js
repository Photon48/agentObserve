import { getAttr } from '../loader.js';
import {
  nanoToMs,
  nanoToDate,
  sortByStart,
  inferToolSchemas,
  getDescendants,
  detectWorkflowNodeKind,
  extractTextContent,
} from './shared.js';

export const FRAMEWORK = 'langchain';

export function canHandle(rawData) {
  return rawData.spans?.some((s) => s.name === 'LangGraph') ?? false;
}

// ── Span traversal helpers ──────────────────────────────────────────────────

function findDescendantByName(spanId, name, childrenOf) {
  for (const child of childrenOf[spanId] || []) {
    if (child.name === name) return child;
    const deeper = findDescendantByName(child.spanId, name, childrenOf);
    if (deeper) return deeper;
  }
  return null;
}

function findDescendantBy(spanId, childrenOf, predicate) {
  for (const child of childrenOf[spanId] || []) {
    if (predicate(child)) return child;
    const deeper = findDescendantBy(child.spanId, childrenOf, predicate);
    if (deeper) return deeper;
  }
  return null;
}

// ── LangChain OTEL attribute extraction ─────────────────────────────────────
//
// LangChain serializes data differently from Anthropic's SDK:
//   gen_ai.prompt    → { messages: [[{ lc, type, id, kwargs: { content } }]] }
//   gen_ai.completion → { generations: [[{ text, message: { kwargs: { content } } }]] }
//
// `content` is a string for text-only responses, or an array of
// { type: 'text'|'tool_use', ... } blocks when the LLM invokes tools.

// Recognized keys that name a user query. Tried in priority order so that
// when `@traceable` (or any handler-decorator) captures multiple kwargs, the
// user query wins over auxiliary inputs like session_id or model_override.
const USER_QUERY_KEYS = [
  'user_query', 'user_message', 'query', 'prompt', 'message',
  'input', 'text', 'content',
];

// Skip stringified Python/JS object reprs like
// "<starlette.requests.Request object at 0xffff…>". These show up when a
// caller passes a non-JSON-serializable arg to `@traceable`.
function isReprString(s) {
  return typeof s === 'string' && /^<.+>$/.test(s.trim());
}

function findUserQueryInObject(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return isReprString(obj) ? '' : obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const t = findUserQueryInObject(item);
      if (t) return t;
    }
    return '';
  }
  if (typeof obj !== 'object') return '';
  // 1. Priority key match (case-insensitive) at this level
  for (const wanted of USER_QUERY_KEYS) {
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === wanted) {
        const t = findUserQueryInObject(obj[key]);
        if (t) return t;
      }
    }
  }
  // 2. Recurse into any container
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const t = findUserQueryInObject(v);
      if (t) return t;
    }
  }
  return '';
}

function extractPromptText(promptStr) {
  if (!promptStr) return '';
  try {
    const obj = JSON.parse(promptStr);

    // LangChain chat-format: `{messages: [[{kwargs:{content}}, …], …]}`.
    // Walk in reverse to prefer the latest user turn over earlier system msgs.
    if (obj && typeof obj === 'object' && obj.messages) {
      const flat = Array.isArray(obj.messages[0]) ? obj.messages.flat() : obj.messages;
      for (let i = flat.length - 1; i >= 0; i--) {
        const m = flat[i];
        const role = m?.kwargs?.type || m?.type || m?.role || '';
        const content = m?.kwargs?.content ?? m?.content;
        if (role === 'human' || role === 'user') {
          if (typeof content === 'string' && !isReprString(content)) return content;
        }
      }
    }

    // Generic case: walk priority keys, recursively. Handles arbitrary
    // handler signatures like `(kickoff_request, request)` where the user
    // query lives at `kickoff_request.user_query` and the noise (Request
    // repr) gets filtered automatically.
    const t = findUserQueryInObject(obj);
    if (t) return t;

    // Fallback: any non-repr string in the object.
    if (typeof obj === 'string') return isReprString(obj) ? '' : obj;
    return Object.values(obj || {})
      .filter((v) => typeof v === 'string' && !isReprString(v))
      .join('\n');
  } catch {
    return isReprString(promptStr) ? '' : promptStr;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT — Structured-output LLM calls (read before changing this function)
//
// LangChain's `.with_structured_output(PydanticModel)`, `.bind_tools(...,
// tool_choice="any")`, JSON-mode bindings, and other schema-forcing helpers
// all use the *same trick* under the hood: they ask the underlying LLM
// provider (Anthropic, Bedrock, OpenAI) for a tool call whose ARGUMENTS are
// the structured payload. The LLM's text response is therefore empty —
// the answer lives in a tool_use content block on the assistant message.
//
// Captured serialization for these calls (langsmith[otel] format):
//   { generations: [[{
//       text: "",                                  ← EMPTY, easy to miss
//       message: { kwargs: { content: [
//         { type: "tool_use",
//           name: "<SchemaName>",
//           input: { …the structured fields… },    ← the real answer
//           id: "tooluse_…" }
//       ] } }
//   }]] }
//
// Plain-text LLM calls (no schema binding) have `text` populated normally.
// So we read `g.text` first; only when it's empty do we mine the content
// blocks for `tool_use` payloads.
//
// If a future adapter (OpenAI, Anthropic SDK, Vertex, …) reports "the LLM
// output is empty but the user can see a JSON object in the source span":
// check whether that framework uses provider tool-use to enforce a schema.
// The fix shape is the same: prefer plain text; on empty text, walk the
// assistant message's content for tool_use blocks and stringify the inputs.
// ─────────────────────────────────────────────────────────────────────────────

function extractCompletionText(completionStr) {
  if (!completionStr) return '';
  try {
    const obj = JSON.parse(completionStr);
    if (obj.generations) {
      const out = obj.generations.flat().map((g) => {
        if (g.text) return g.text;
        // Structured-output path — see the block comment above this function.
        const content = g.message?.kwargs?.content;
        if (Array.isArray(content)) {
          const parts = [];
          for (const block of content) {
            if (block?.type === 'text' && block.text) parts.push(block.text);
            else if (block?.type === 'tool_use' && block.input) {
              parts.push(JSON.stringify(block.input, null, 2));
            }
          }
          return parts.join('\n');
        }
        return '';
      }).join('');
      if (out) return out;
    }
    for (const key of ['output', 'final_response', 'agent_response', 'result']) {
      if (obj[key] === undefined) continue;
      const v = obj[key];
      if (typeof v === 'string') return v;
      // Try string-or-content-block on the value or its `.content`.
      const text = extractTextContent(v) || extractTextContent(v?.content);
      if (text) return text;
      // Structured-output binders (Pydantic, JSON schema, …) emit a plain
      // object — pretty-print so users can see what the chain produced.
      if (typeof v === 'object' && v !== null) {
        return JSON.stringify(v, null, 2);
      }
    }
    return Object.values(obj).filter((v) => typeof v === 'string').join('\n\n');
  } catch {
    return completionStr;
  }
}

// ── LLM child span extraction (for standalone workflow nodes) ────────────────
//
// Chain-level spans (e.g. intent_classifier, tov_rewriter) carry the *user's*
// prompt. The actual LLM input lives on the descendant ChatAnthropic span.
// These helpers read gen_ai.prompt from that LLM span and format it the same
// way shared.js buildWorkflowNode formats Anthropic spans: [ROLE]\ncontent

function extractLlmSpanInputText(llmSpan) {
  const promptStr = getAttr(llmSpan.attributes, 'gen_ai.prompt');
  if (!promptStr) return '';
  try {
    const obj = JSON.parse(promptStr);
    if (obj.messages) {
      const flat = Array.isArray(obj.messages[0]) ? obj.messages.flat() : obj.messages;
      const parts = [];
      for (const m of flat) {
        const role = m.kwargs?.type || m.type || 'unknown';
        const content = m.kwargs?.content ?? m.content ?? '';
        if (typeof content === 'string' && content) {
          parts.push(`[${role.toUpperCase()}]\n${content}`);
        }
      }
      if (parts.length > 0) return parts.join('\n\n');
    }
  } catch {}
  return extractPromptText(promptStr);
}

function extractLlmSpanSystemText(llmSpan) {
  const promptStr = getAttr(llmSpan.attributes, 'gen_ai.prompt');
  if (!promptStr) return '';
  try {
    const obj = JSON.parse(promptStr);
    if (obj.messages) {
      const flat = Array.isArray(obj.messages[0]) ? obj.messages.flat() : obj.messages;
      for (const m of flat) {
        const role = m.kwargs?.type || m.type || '';
        if (role === 'system') {
          return m.kwargs?.content ?? m.content ?? '';
        }
      }
    }
  } catch {}
  return '';
}

// ── Block extraction from LLM span ─────────────────────────────────────────
//
// Parses gen_ai.completion to produce Block[] matching the canonical schema.
// Handles both string content (→ TEXT) and array content (→ TEXT + TOOL_USE).

function buildBlocksFromLLMSpan(span) {
  const completionStr = getAttr(span.attributes, 'gen_ai.completion');
  if (!completionStr) return [];

  try {
    const obj = JSON.parse(completionStr);
    const gen = obj.generations?.flat()?.[0];
    if (!gen) return [];

    const content = gen.message?.kwargs?.content;

    // Array content: mixed text + tool_use blocks (agent decided to call tools)
    if (Array.isArray(content)) {
      const blocks = [];
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          blocks.push({ type: 'TEXT', text: item.text });
        } else if (item.type === 'tool_use') {
          blocks.push({ type: 'TOOL_USE', id: item.id || '', name: item.name || '', input: item.input || {} });
        }
      }
      return blocks;
    }

    // String content (or text field): single text block
    if (gen.text) {
      return [{ type: 'TEXT', text: gen.text }];
    }
  } catch {}

  return [];
}

// ── Build TOOL_RESULT blocks from tool execution spans ──────────────────────
//
// Tool spans have gen_ai.completion with the tool output. We pair each
// TOOL_USE block (from the preceding LLM response) with its TOOL_RESULT.

function buildToolResultBlock(toolSpan) {
  const output = extractCompletionText(getAttr(toolSpan.attributes, 'gen_ai.completion'));
  return {
    type: 'TOOL_RESULT',
    id: toolSpan.spanId,
    name: toolSpan.name,
    text: output,
  };
}

// ── Build capturedBlocks: unified conversation for the whole turn ────────────
//
// Walks LLM and tool spans in chronological order and produces the same block
// stream that Anthropic's SDK capture gives us. Each LLM span contributes its
// response blocks, and each tool span contributes a TOOL_RESULT block that
// follows the TOOL_USE it fulfills.

function buildCapturedBlocks(agentNodes, llmAndToolSpans) {
  const blocks = [];

  for (const span of llmAndToolSpans) {
    const op = getAttr(span.attributes, 'gen_ai.operation.name');
    if (op === 'execute_tool') {
      blocks.push(buildToolResultBlock(span));
    } else {
      blocks.push(...buildBlocksFromLLMSpan(span));
    }
  }

  // Mark the final TEXT block as AGENT_RESPONSE (same convention as Anthropic adapter)
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'TEXT') {
      blocks[i] = { ...blocks[i], type: 'AGENT_RESPONSE' };
      break;
    }
    if (blocks[i].type === 'TOOL_USE' || blocks[i].type === 'TOOL_RESULT') break;
  }

  return blocks.length > 0 ? blocks : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Session builder
// ═════════════════════════════════════════════════════════════════════════════

export function buildSession(sessionId, raw) {
  const { spans } = raw;
  if (!spans || spans.length === 0) return null;

  const spanById = {};
  const childrenOf = {};
  for (const span of spans) {
    spanById[span.spanId] = span;
    if (span.parentSpanId) {
      if (!childrenOf[span.parentSpanId]) childrenOf[span.parentSpanId] = [];
      childrenOf[span.parentSpanId].push(span);
    }
  }

  const rootSpans = spans
    .filter((s) => !s.parentSpanId || !spanById[s.parentSpanId])
    .sort(sortByStart);

  if (rootSpans.length === 0) return null;

  // System prompt: from the first Prompt span with a system message
  let systemPrompt = '';
  for (const span of spans) {
    if (span.name !== 'Prompt') continue;
    const comp = getAttr(span.attributes, 'gen_ai.completion');
    if (!comp) continue;
    try {
      const obj = JSON.parse(comp);
      const output = obj.output || [];
      for (const msg of (Array.isArray(output) ? output : [])) {
        if (msg.type === 'system' && msg.content) {
          systemPrompt = msg.content;
          break;
        }
      }
      if (systemPrompt) break;
    } catch {}
  }

  // Fallback: extract system prompt from LLM span messages
  if (!systemPrompt) {
    for (const span of spans) {
      if (getAttr(span.attributes, 'langsmith.span.kind') !== 'llm') continue;
      const promptStr = getAttr(span.attributes, 'gen_ai.prompt');
      if (!promptStr) continue;
      try {
        const obj = JSON.parse(promptStr);
        if (obj.messages) {
          const flat = Array.isArray(obj.messages[0]) ? obj.messages.flat() : obj.messages;
          for (const m of flat) {
            const msgType = m.kwargs?.type || m.type;
            if (msgType === 'system') {
              systemPrompt = m.kwargs?.content || m.content || '';
              break;
            }
          }
        }
        if (systemPrompt) break;
      } catch {}
    }
  }

  // Available tools: prefer gen_ai.tool.definitions on LLM spans (emitted by
  // agentobserve's LangChain callback handler), fall back to execute_tool names.
  const availableTools = [];
  const toolIndex = new Map();
  function mergeTool({ name, description, inputSchema }) {
    if (!name) return;
    const existing = toolIndex.get(name);
    if (!existing) {
      const entry = { name, description: description || '', inputSchema: inputSchema || null };
      toolIndex.set(name, entry);
      availableTools.push(entry);
      return;
    }
    if (!existing.description && description) existing.description = description;
    if (!existing.inputSchema && inputSchema) existing.inputSchema = inputSchema;
  }

  for (const span of spans) {
    // Two paths emit gen_ai.tool.definitions:
    //   1. langsmith LLM spans (kind=llm or op=chat) — for frameworks that
    //      land tool definitions on the LLM span itself.
    //   2. `agentobserve.tool_definitions` helper spans emitted by the
    //      agentobserve LangChain callback handler. LangSmith creates its
    //      OTEL spans lazily (outside the OTEL context-var), so the handler
    //      can't write onto the LLM span directly — instead it opens this
    //      short-lived sibling span that the loader buckets into the
    //      session by `session.id`.
    const kind = getAttr(span.attributes, 'langsmith.span.kind');
    const op   = getAttr(span.attributes, 'gen_ai.operation.name');
    const isLlmSpan = kind === 'llm' || op === 'chat';
    const isHelperSpan = span.name === 'agentobserve.tool_definitions';
    if (!isLlmSpan && !isHelperSpan) continue;
    const defs = getAttr(span.attributes, 'gen_ai.tool.definitions');
    if (!defs) continue;
    try {
      const arr = JSON.parse(defs);
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        mergeTool({
          name: t.name,
          description: t.description || '',
          inputSchema: t.input_schema || t.inputSchema || null,
        });
      }
    } catch {}
  }

  for (const span of spans) {
    if (getAttr(span.attributes, 'gen_ai.operation.name') === 'execute_tool') {
      mergeTool({ name: span.name, description: '', inputSchema: null });
    }
  }

  const turns = rootSpans.map((root, idx) =>
    buildTurn(idx, root, childrenOf, spanById)
  );

  const firstSpan = rootSpans[0];
  const lastSpan = rootSpans[rootSpans.length - 1];

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const turn of turns) {
    totalCost += turn.totalCost;
    totalInputTokens += turn.totalInputTokens;
    totalOutputTokens += turn.totalOutputTokens;
  }

  const session = {
    id: sessionId,
    framework: FRAMEWORK,
    startTime: nanoToDate(firstSpan.startTimeUnixNano).toISOString(),
    endTime: nanoToDate(lastSpan.endTimeUnixNano).toISOString(),
    turnCount: turns.length,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    systemPrompt,
    availableTools,
    turns,
  };

  inferToolSchemas(session);
  return session;
}

// ═════════════════════════════════════════════════════════════════════════════
// Turn builder
// ═════════════════════════════════════════════════════════════════════════════

function buildTurn(idx, rootSpan, childrenOf, spanById) {
  const startNano = rootSpan.startTimeUnixNano;
  const endNano = rootSpan.endTimeUnixNano;
  const durationMs = nanoToMs(endNano) - nanoToMs(startNano);

  const userPrompt = extractPromptText(getAttr(rootSpan.attributes, 'gen_ai.prompt'));

  const descendants = getDescendants(rootSpan.spanId, childrenOf);

  // Token totals from all LLM spans
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const llmSpans = descendants.filter((s) => getAttr(s.attributes, 'langsmith.span.kind') === 'llm');
  for (const s of llmSpans) {
    totalInputTokens += Number(getAttr(s.attributes, 'gen_ai.usage.input_tokens') || 0);
    totalOutputTokens += Number(getAttr(s.attributes, 'gen_ai.usage.output_tokens') || 0);
  }

  // ── Agent nodes: LLM + tool spans in chronological order ──────────────────
  const llmAndToolSpans = descendants
    .filter((s) => {
      const kind = getAttr(s.attributes, 'langsmith.span.kind');
      const op = getAttr(s.attributes, 'gen_ai.operation.name');
      return kind === 'llm' || op === 'execute_tool';
    })
    .sort(sortByStart);

  const agentNodes = [];
  for (const span of llmAndToolSpans) {
    const op = getAttr(span.attributes, 'gen_ai.operation.name');
    const spanDur = nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano);

    if (op === 'execute_tool') {
      let toolInput = '';
      try { toolInput = getAttr(span.attributes, 'gen_ai.prompt') || ''; } catch {}
      const toolOutput = extractCompletionText(getAttr(span.attributes, 'gen_ai.completion'));
      agentNodes.push({
        kind: 'TOOL',
        toolUseId: span.spanId,
        toolName: span.name,
        decision: 'accept',
        source: 'langchain',
        toolInput,
        toolResultSizeBytes: toolOutput.length,
        durationMs: spanDur,
        success: true,
      });
    } else {
      const model = getAttr(span.attributes, 'gen_ai.request.model') || '';
      const inTok = Number(getAttr(span.attributes, 'gen_ai.usage.input_tokens') || 0);
      const outTok = Number(getAttr(span.attributes, 'gen_ai.usage.output_tokens') || 0);
      const graphNode = getAttr(span.attributes, 'langsmith.metadata.langgraph_node') || '';
      agentNodes.push({
        kind: 'LLM_CALL',
        model,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: spanDur,
        ttftMs: 0,
        stopReason: '',
        requestId: '',
        blocks: buildBlocksFromLLMSpan(span),
        graphNode,
      });
    }
  }

  // ── Captured blocks: unified conversation stream ──────────────────────────
  const capturedBlocks = buildCapturedBlocks(agentNodes, llmAndToolSpans);

  // ── Steps ─────────────────────────────────────────────────────────────────
  const steps = [
    { type: 'PROMPT', text: userPrompt },
    { type: 'AGENT', nodes: agentNodes, capturedBlocks, upstreamPre: [], upstreamPost: [], userPrompt },
    { type: 'FINAL', totalCost: 0, totalInputTokens, totalOutputTokens, durationMs },
  ];

  // ── Scoped agent step builder (for AGENT workflow nodes) ─────────────────
  //
  // TODO(sub-agents): LangChain/LangGraph sub-graph detection.
  //
  // The canonical schema allows AGENT-kind AgentNodes (recursive) — see
  // CLAUDE.md "AgentNode (discriminated on `kind`)" — but this builder
  // flattens all descendant LLM + tool spans into a single list, regardless
  // of whether they belong to a nested sub-graph. As a result, sub-graph
  // invocations (one StateGraph calling another) collapse into a flat
  // cascade and the user cannot drill into the sub-graph as its own scope.
  //
  // Detection signals when we have a real trace:
  //   - A descendant span whose `langsmith.metadata.langgraph_checkpoint_ns`
  //     contains an additional pipe-delimited segment beyond the enclosing
  //     scope. LangGraph stamps sub-graph spans with namespaces like
  //     `parent_node:UUID|child_node:UUID` — additional `|` segments
  //     indicate nesting depth.
  //   - A descendant span with `langsmith.metadata.langgraph_node` whose
  //     value is distinct from the enclosing node — that span and its
  //     descendants belong to the inner node.
  //   - The OTEL standard marker `gen_ai.operation.name === 'invoke_agent'`
  //     on a descendant span.
  //
  // Implementation when ready:
  //   1. Walk descendants of childSpan grouped by `langgraph_checkpoint_ns`
  //      depth or by `langgraph_node` boundary.
  //   2. For each grouped sub-tree, use `classifyAgentNodeKind(
  //        rootSpanId, childrenOf, isLLM, isTool, isAgentSpan)` from
  //      ./shared.js — where `isAgentSpan` ORs `gen_ai.operation.name ===
  //      'invoke_agent'` with `langsmith.metadata.langgraph_node` (already
  //      the pattern used at the workflow level here).
  //   3. Emit AGENT-kind nodes:
  //      `{ kind: 'AGENT', agentName: <langgraph_node>, agentType:
  //        'subagent', nodes: [...], durationMs, startTime, endTime }`
  //      and recurse so nested sub-graphs classify the same way.
  //
  // Reference: see the recursive `promoteSubAgents` IIFE in
  // server/adapters/claude_code_cli.js for the working pattern. Verify
  // against a captured LangGraph session that actually invokes a sub-graph
  // (e.g. one StateGraph compiled into another's tool slot) — we don't
  // have one yet.
  function buildScopedAgentStep(childSpan) {
    const scopedDescendants = getDescendants(childSpan.spanId, childrenOf);
    const scopedLlmAndToolSpans = scopedDescendants
      .filter((s) => {
        const k = getAttr(s.attributes, 'langsmith.span.kind');
        const op = getAttr(s.attributes, 'gen_ai.operation.name');
        return k === 'llm' || op === 'execute_tool';
      })
      .sort(sortByStart);

    const scopedNodes = [];
    for (const span of scopedLlmAndToolSpans) {
      const op = getAttr(span.attributes, 'gen_ai.operation.name');
      const spanDur = nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano);

      if (op === 'execute_tool') {
        let toolInput = '';
        try { toolInput = getAttr(span.attributes, 'gen_ai.prompt') || ''; } catch {}
        const toolOutput = extractCompletionText(getAttr(span.attributes, 'gen_ai.completion'));
        scopedNodes.push({
          kind: 'TOOL',
          toolUseId: span.spanId,
          toolName: span.name,
          decision: 'accept',
          source: 'langchain',
          toolInput,
          toolResultSizeBytes: toolOutput.length,
          durationMs: spanDur,
          success: true,
        });
      } else {
        const model = getAttr(span.attributes, 'gen_ai.request.model') || '';
        const inTok = Number(getAttr(span.attributes, 'gen_ai.usage.input_tokens') || 0);
        const outTok = Number(getAttr(span.attributes, 'gen_ai.usage.output_tokens') || 0);
        const graphNode = getAttr(span.attributes, 'langsmith.metadata.langgraph_node') || '';
        scopedNodes.push({
          kind: 'LLM_CALL',
          model,
          inputTokens: inTok,
          outputTokens: outTok,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          durationMs: spanDur,
          ttftMs: 0,
          stopReason: '',
          requestId: '',
          blocks: buildBlocksFromLLMSpan(span),
          graphNode,
        });
      }
    }

    const scopedBlocks = buildCapturedBlocks(scopedNodes, scopedLlmAndToolSpans);
    return { type: 'AGENT', nodes: scopedNodes, capturedBlocks: scopedBlocks, upstreamPre: [], upstreamPost: [], userPrompt };
  }

  // ── Workflow graph ────────────────────────────────────────────────────────
  const directChildren = (childrenOf[rootSpan.spanId] || []).sort(sortByStart);
  const groups = [];
  for (const child of directChildren) {
    const childStart = BigInt(child.startTimeUnixNano);
    const childDur = nanoToMs(child.endTimeUnixNano) - nanoToMs(child.startTimeUnixNano);

    const isLLM = (s) =>
      getAttr(s.attributes, 'langsmith.span.kind') === 'llm' ||
      getAttr(s.attributes, 'gen_ai.operation.name') === 'chat';
    const isTool = (s) =>
      getAttr(s.attributes, 'gen_ai.operation.name') === 'execute_tool';
    // Strong agent marker: LangGraph stamps every span inside a graph node
    // with `langsmith.metadata.langgraph_node`. Also honor the OTEL
    // standard `invoke_agent` for any framework that emits it.
    const isAgentSpan = (s) =>
      !!getAttr(s.attributes, 'langsmith.metadata.langgraph_node') ||
      getAttr(s.attributes, 'gen_ai.operation.name') === 'invoke_agent';
    const kind = detectWorkflowNodeKind(child.spanId, childrenOf, isLLM, isTool, isAgentSpan);

    // Pull model + token metadata from the LLM span. Prefer self when the
    // workflow child IS the LLM (direct ChatBedrockConverse / ChatAnthropic /
    // etc.); otherwise find the first LLM descendant (RunnableSequence,
    // middleware wrappers, …).
    const childLlm = isLLM(child)
      ? child
      : findDescendantBy(child.spanId, childrenOf, isLLM);
    const model = childLlm ? (getAttr(childLlm.attributes, 'gen_ai.request.model') || '') : '';
    const inTok = childLlm ? Number(getAttr(childLlm.attributes, 'gen_ai.usage.input_tokens') || 0) : 0;
    const outTok = childLlm ? Number(getAttr(childLlm.attributes, 'gen_ai.usage.output_tokens') || 0) : 0;

    const inputText = (childLlm && kind !== 'AGENT')
      ? extractLlmSpanInputText(childLlm)
      : extractPromptText(getAttr(child.attributes, 'gen_ai.prompt'));
    const outputText = (childLlm && kind !== 'AGENT')
      ? extractCompletionText(getAttr(childLlm.attributes, 'gen_ai.completion'))
      : extractCompletionText(getAttr(child.attributes, 'gen_ai.completion'));
    const systemText = (childLlm && kind !== 'AGENT')
      ? extractLlmSpanSystemText(childLlm)
      : '';

    const nodeObj = {
      nodeId: child.spanId,
      kind,
      label: child.name,
      spanName: child.name,
      model,
      durationMs: childDur,
      inputTokens: inTok,
      outputTokens: outTok,
      maxTokens: 0,
      inputText,
      outputText,
      systemText,
      agentStepData: kind === 'AGENT' ? buildScopedAgentStep(child) : null,
    };

    // Temporally overlapping children → same group (parallel execution)
    const lastGroup = groups[groups.length - 1];
    if (lastGroup) {
      const lastNode = lastGroup._spans[lastGroup._spans.length - 1];
      const lastEnd = BigInt(lastNode.endTimeUnixNano);
      if (childStart < lastEnd) {
        lastGroup.nodes.push(nodeObj);
        lastGroup._spans.push(child);
        continue;
      }
    }

    groups.push({ groupIdx: groups.length, nodes: [nodeObj], _spans: [child] });
  }

  for (const g of groups) delete g._spans;
  for (let i = 0; i < groups.length; i++) groups[i].groupIdx = i;

  return {
    idx,
    userPrompt,
    startTime: nanoToDate(startNano).toISOString(),
    endTime: nanoToDate(endNano).toISOString(),
    durationMs,
    totalCost: 0,
    totalInputTokens,
    totalOutputTokens,
    steps,
    workflowGraph: { hasPipeline: true, groups },
  };
}
