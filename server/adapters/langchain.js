import { getAttr } from '../loader.js';
import { nanoToMs, nanoToDate, sortByStart, inferToolSchemas } from './shared.js';

export const FRAMEWORK = 'langchain';

export function canHandle(rawData) {
  return rawData.spans?.some((s) => s.name === 'LangGraph') ?? false;
}

// ── Span traversal helpers ──────────────────────────────────────────────────

function getDescendants(spanId, childrenOf) {
  const result = [];
  for (const child of childrenOf[spanId] || []) {
    result.push(child);
    result.push(...getDescendants(child.spanId, childrenOf));
  }
  return result;
}

function findDescendantByName(spanId, name, childrenOf) {
  for (const child of childrenOf[spanId] || []) {
    if (child.name === name) return child;
    const deeper = findDescendantByName(child.spanId, name, childrenOf);
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

function extractPromptText(promptStr) {
  if (!promptStr) return '';
  try {
    const obj = JSON.parse(promptStr);
    if (typeof obj.user_message === 'string') return obj.user_message;
    if (typeof obj === 'string') return obj;
    if (obj.messages) {
      // messages is typically [[msg, msg, ...]]  (array of arrays)
      const flat = Array.isArray(obj.messages[0]) ? obj.messages.flat() : obj.messages;
      for (const m of flat) {
        const content = m.kwargs?.content ?? m.content;
        if (typeof content === 'string') return content;
      }
    }
    return Object.values(obj).filter((v) => typeof v === 'string').join('\n');
  } catch {
    return promptStr;
  }
}

function extractCompletionText(completionStr) {
  if (!completionStr) return '';
  try {
    const obj = JSON.parse(completionStr);
    if (obj.generations) {
      return obj.generations.flat().map((g) => g.text || '').join('');
    }
    for (const key of ['output', 'final_response', 'agent_response', 'result']) {
      if (obj[key]) {
        if (typeof obj[key] === 'string') return obj[key];
        if (typeof obj[key]?.content === 'string') return obj[key].content;
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
    .filter((s) => s.name === 'LangGraph' && (!s.parentSpanId || !spanById[s.parentSpanId]))
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

  // Available tools: deduplicated from execute_tool spans
  const availableTools = [];
  const toolNamesSeen = new Set();
  for (const span of spans) {
    if (getAttr(span.attributes, 'gen_ai.operation.name') === 'execute_tool') {
      if (!toolNamesSeen.has(span.name)) {
        toolNamesSeen.add(span.name);
        availableTools.push({ name: span.name, description: '', inputSchema: null });
      }
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

    const childLlm = findDescendantByName(child.spanId, 'ChatAnthropic', childrenOf);
    const model = childLlm ? (getAttr(childLlm.attributes, 'gen_ai.request.model') || '') : '';
    const inTok = childLlm ? Number(getAttr(childLlm.attributes, 'gen_ai.usage.input_tokens') || 0) : 0;
    const outTok = childLlm ? Number(getAttr(childLlm.attributes, 'gen_ai.usage.output_tokens') || 0) : 0;

    const hasNestedAgent = findDescendantByName(child.spanId, 'agent', childrenOf)
                        || findDescendantByName(child.spanId, 'LangGraph', childrenOf);
    const kind = hasNestedAgent ? 'AGENT' : 'PIPELINE_MEMBER';

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
