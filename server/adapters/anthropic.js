// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { getAttr } from '../loader.js';
import { nanoToMs, nanoToDate, buildWorkflowNode, inferToolSchemas, getDescendants, collectToolCallsFromAgentNodes, stampParallelGroup, normalizeAnthropicContentBlock } from './shared.js';

export const FRAMEWORK = 'anthropic-sdk';

// Spans that only appear when an outer Python SDK wraps the CLI:
//   - `agentobserve.session`: emitted by agentobserve's bootstrap when imported
//     from a Python process (claude-agent-sdk path).
//   - `anthropic.chat`: emitted by opentelemetry-instrumentation-anthropic when
//     the user code calls the Anthropic Python SDK directly.
//   - `weverse.pipeline`: demo-specific outer orchestrator span.
// A direct `claude` CLI invocation emits `claude_code.interaction` but none of
// these — that's what distinguishes it from the SDK.
const SDK_MARKER_SPANS = new Set([
  'agentobserve.session',
  'anthropic.chat',
  'weverse.pipeline',
]);

function hasSdkMarkers(rawData, orphanSpans = []) {
  if (rawData.sdkCapture) return true;
  for (const s of rawData.spans || []) {
    if (SDK_MARKER_SPANS.has(s.name)) return true;
  }
  for (const s of orphanSpans) {
    if (SDK_MARKER_SPANS.has(s.name)) return true;
  }
  return false;
}

export function canHandle(rawData) {
  return rawData.spans?.some((s) => s.name === 'claude_code.interaction') ?? false;
}

export function buildSession(sessionId, raw, orphanSpans = []) {
  const { logs, spans: rawSpans, requestBodies = {}, responseBodies = {}, sdkCapture } = raw;

  // Find all interaction spans — each is a turn root
  const interactionSpans = rawSpans
    .filter((s) => s.name === 'claude_code.interaction')
    .sort((a, b) => {
      const aN = BigInt(a.startTimeUnixNano);
      const bN = BigInt(b.startTimeUnixNano);
      return aN < bN ? -1 : aN > bN ? 1 : 0;
    });

  if (interactionSpans.length === 0) return null;

  // Match orphan anthropic.chat spans to this session by temporal proximity (+/-60s buffer)
  const sessionStartNs = BigInt(interactionSpans[0].startTimeUnixNano);
  const sessionEndNs = BigInt(interactionSpans[interactionSpans.length - 1].endTimeUnixNano);
  const BUFFER = 60_000_000_000n;
  const matchedOrphans = orphanSpans.filter((s) => {
    const start = BigInt(s.startTimeUnixNano);
    const end   = BigInt(s.endTimeUnixNano);
    return start >= sessionStartNs - BUFFER && end <= sessionEndNs + BUFFER;
  });
  const spans = matchedOrphans.length > 0 ? [...rawSpans, ...matchedOrphans] : rawSpans;

  // Build llm_request span index by request_id
  const llmSpanByRequestId = {};
  for (const span of spans) {
    if (span.name === 'claude_code.llm_request') {
      const reqId = getAttr(span.attributes, 'request_id');
      if (reqId) llmSpanByRequestId[reqId] = span;
    }
  }

  // Build tool span index by tool_use_id (from tool.execution spans)
  const toolSpanByUseId = {};
  for (const span of spans) {
    if (span.name === 'claude_code.tool' || span.name === 'claude_code.tool.execution') {
      const toolUseId = getAttr(span.attributes, 'tool_use_id');
      if (toolUseId) toolSpanByUseId[toolUseId] = span;
    }
  }

  // Collect orchestrator (upstream) LLM spans — emitted by the outer Python app
  const orchestratorSpans = spans
    .filter((s) => s.name === 'anthropic.chat')
    .sort((a, b) => {
      const aN = BigInt(a.startTimeUnixNano);
      const bN = BigInt(b.startTimeUnixNano);
      return aN < bN ? -1 : aN > bN ? 1 : 0;
    });

  // Children index: parentSpanId -> [child spans]
  const childrenOf = {};
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    if (!childrenOf[span.parentSpanId]) childrenOf[span.parentSpanId] = [];
    childrenOf[span.parentSpanId].push(span);
  }

  // Pipeline spans sorted by start time (matched to turns by temporal overlap)
  const pipelineSpans = spans
    .filter((s) => s.name === 'weverse.pipeline' || s.name === 'agentobserve.session')
    .sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1));

  // Extract system prompt: prefer SDK capture, fall back to request body
  const firstReqBody = Object.values(requestBodies)[0];
  const systemPrompt = sdkCapture?.systemPrompt
    || (firstReqBody?.system
        ? (Array.isArray(firstReqBody.system)
            ? firstReqBody.system.map((b) => b.text || '').join('\n')
            : String(firstReqBody.system))
        : '');

  // Per-session tool catalog with shared object identity across all scopes.
  // `mergeTool` is the single mint point; entries are shared between
  // session.availableTools, turn.availableTools, and per-agent availableTools
  // so inferToolSchemas mutations propagate to every reference.
  const toolCatalog = new Map();
  function mergeTool({ name, description, inputSchema }) {
    if (!name) return null;
    const existing = toolCatalog.get(name);
    if (!existing) {
      const entry = { name, description: description || '', inputSchema: inputSchema || null };
      toolCatalog.set(name, entry);
      return entry;
    }
    if (!existing.description && description) existing.description = description;
    if (!existing.inputSchema && inputSchema) existing.inputSchema = inputSchema;
    return existing;
  }

  // Session-only contribution: outer-orchestrator `anthropic.chat` tool defs.
  // These belong to upstream pipeline LLM calls (guardrails, routers, etc.)
  // rather than the agent itself, so they never surface at turn/agent scope —
  // but they remain in the session-wide catalog for the session list view.
  for (const span of spans) {
    if (span.name !== 'anthropic.chat') continue;
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

  // For each log, find which interaction span it belongs to by timestamp
  function findTurnSpan(timeNano) {
    const t = BigInt(timeNano);
    for (const span of interactionSpans) {
      const start = BigInt(span.startTimeUnixNano);
      const end = BigInt(span.endTimeUnixNano);
      if (t >= start && t <= end) return span;
    }
    // fallback: closest span before this time
    let best = null;
    for (const span of interactionSpans) {
      const start = BigInt(span.startTimeUnixNano);
      if (start <= t) best = span;
    }
    return best;
  }

  // Group logs by turn (interaction span)
  const logsByTurnSpanId = {};
  for (const log of logs) {
    const span = findTurnSpan(log.timeUnixNano);
    if (!span) continue;
    const key = span.spanId;
    if (!logsByTurnSpanId[key]) logsByTurnSpanId[key] = [];
    logsByTurnSpanId[key].push(log);
  }

  // Build turns
  const turns = interactionSpans.map((span, idx) => {
    const turnLogs = logsByTurnSpanId[span.spanId] || [];
    const capturedTurn = sdkCapture?.turns?.[idx] || null;
    const prevEnd = idx > 0 ? interactionSpans[idx - 1].endTimeUnixNano : '0';
    const nextStart = idx < interactionSpans.length - 1
      ? interactionSpans[idx + 1].startTimeUnixNano
      : null;
    return buildTurn(idx, span, turnLogs, llmSpanByRequestId, toolSpanByUseId,
      requestBodies, responseBodies, capturedTurn, orchestratorSpans, prevEnd, nextStart,
      pipelineSpans, childrenOf, mergeTool);
  });

  // Session summary
  const firstSpan = interactionSpans[0];
  const lastSpan = interactionSpans[interactionSpans.length - 1];

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const turn of turns) {
    totalCost += turn.totalCost;
    totalInputTokens += turn.totalInputTokens;
    totalOutputTokens += turn.totalOutputTokens;
  }

  // Session-level catalog is the union of every entry minted during turn
  // construction (plus the orchestrator pre-merge above). Object identity is
  // preserved with turn/agent lists via the shared `mergeTool` closure.
  const availableTools = [...toolCatalog.values()];

  // The CLI binary and the Python SDK both emit `claude_code.interaction`
  // spans, so canHandle() catches both. Distinguish them here: only label
  // as the SDK when an outer-orchestrator marker is present; otherwise this
  // was a direct `claude` CLI run.
  const framework = hasSdkMarkers(raw, matchedOrphans) ? FRAMEWORK : 'claude-code-cli';

  const session = {
    id: sessionId,
    framework,
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

// Build conversation blocks from a response body content array
function buildBlocksFromResponse(respBody) {
  if (!respBody?.content) return [];
  const blocks = [];
  for (const item of respBody.content) {
    const block = normalizeAnthropicContentBlock(item);
    if (block) blocks.push(block);
  }
  return blocks;
}

// Find tool_result blocks in a request body's messages that match the given tool_use ids
function findToolResults(reqBody, toolUseIds) {
  if (!reqBody?.messages) return {};
  const results = {};
  for (const msg of reqBody.messages) {
    if (msg.role !== 'user') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const item of content) {
      if (item.type === 'tool_result' && toolUseIds.has(item.tool_use_id)) {
        const text = Array.isArray(item.content)
          ? item.content.map((c) => c.text || '').join('')
          : (typeof item.content === 'string' ? item.content : '');
        results[item.tool_use_id] = text;
      }
    }
  }
  return results;
}

function buildWorkflowGraph(pipelineSpan, childrenOf, interactionSpan, agentStepData, preSpans = [], postSpans = []) {
  let groups;

  if (!pipelineSpan) {
    groups = [{
      groupIdx: 0,
      nodes: [{
        nodeId: interactionSpan.spanId,
        kind: 'AGENT',
        label: 'agent',
        spanName: 'claude_code.interaction',
        model: '',
        durationMs: nanoToMs(interactionSpan.endTimeUnixNano) - nanoToMs(interactionSpan.startTimeUnixNano),
        inputTokens: 0,
        outputTokens: 0,
        maxTokens: 0,
        outputText: '',
        systemText: '',
        agentStepData,
      }],
    }];
  } else {
    const children = (childrenOf[pipelineSpan.spanId] || [])
      .sort((a, b) => {
        const aN = BigInt(a.startTimeUnixNano);
        const bN = BigInt(b.startTimeUnixNano);
        return aN < bN ? -1 : aN > bN ? 1 : 0;
      });

    const agentStart = BigInt(interactionSpan.startTimeUnixNano);

    groups = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      let kind;
      if (child.name === 'claude_code.interaction') {
        kind = 'AGENT';
      } else if (child.name === 'anthropic.chat') {
        kind = BigInt(child.startTimeUnixNano) < agentStart ? 'UPSTREAM_LLM' : 'DOWNSTREAM_LLM';
      } else {
        kind = 'PIPELINE_MEMBER';
      }
      groups.push({
        groupIdx: i,
        nodes: [buildWorkflowNode(child, kind, kind === 'AGENT' ? agentStepData : null)],
      });
    }

    // If the interaction span wasn't a direct pipeline child, inject it
    if (!groups.some((g) => g.nodes.some((n) => n.kind === 'AGENT'))) {
      const agentNode = {
        nodeId: interactionSpan.spanId,
        kind: 'AGENT',
        label: 'agent',
        spanName: 'claude_code.interaction',
        model: '',
        durationMs: nanoToMs(interactionSpan.endTimeUnixNano) - nanoToMs(interactionSpan.startTimeUnixNano),
        inputTokens: 0,
        outputTokens: 0,
        maxTokens: 0,
        outputText: '',
        systemText: '',
        agentStepData,
      };
      const agentStartMs = nanoToMs(interactionSpan.startTimeUnixNano);
      let insertIdx = children.length;
      for (let i = 0; i < children.length; i++) {
        if (nanoToMs(children[i].startTimeUnixNano) > agentStartMs) { insertIdx = i; break; }
      }
      groups.splice(insertIdx, 0, { groupIdx: insertIdx, nodes: [agentNode] });
    }
  }

  // Unified pre/post span injection with correct chronological ordering
  const graphSpanIds = new Set(groups.flatMap((g) => g.nodes.map((n) => n.nodeId)));

  const newPreGroups = [...preSpans]
    .filter((s) => !graphSpanIds.has(s.spanId))
    .sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))
    .map((s) => ({ groupIdx: 0, nodes: [buildWorkflowNode(s, 'UPSTREAM_LLM', null)] }));

  const newPostGroups = [...postSpans]
    .filter((s) => !graphSpanIds.has(s.spanId))
    .sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))
    .map((s) => ({ groupIdx: 0, nodes: [buildWorkflowNode(s, 'DOWNSTREAM_LLM', null)] }));

  if (newPreGroups.length > 0) groups.unshift(...newPreGroups);
  if (newPostGroups.length > 0) groups.push(...newPostGroups);

  for (let i = 0; i < groups.length; i++) groups[i].groupIdx = i;

  return { hasPipeline: !!pipelineSpan, groups };
}

function buildTurn(idx, interactionSpan, logs, llmSpanByRequestId, toolSpanByUseId, requestBodies, responseBodies, capturedTurn, orchestratorSpans = [], prevEnd = '0', nextStart = null, pipelineSpans = [], childrenOf = {}, mergeTool = () => null) {
  const attrs = interactionSpan.attributes;
  const userPrompt = getAttr(attrs, 'user_prompt') || '';
  const startNano = interactionSpan.startTimeUnixNano;
  const endNano = interactionSpan.endTimeUnixNano;
  const durationMs =
    Number(BigInt(endNano) / 1000000n) - Number(BigInt(startNano) / 1000000n);

  // Sort logs by timeUnixNano
  const sortedLogs = [...logs].sort((a, b) => {
    const aN = BigInt(a.timeUnixNano);
    const bN = BigInt(b.timeUnixNano);
    return aN < bN ? -1 : aN > bN ? 1 : 0;
  });

  const steps = [];
  const agentNodes = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // PROMPT step - first
  steps.push({ type: 'PROMPT', text: userPrompt });

  // Track tool groups: tool_use_id -> { decision, result }
  const toolGroups = {};
  // Track hooks: pair start+complete by hook_name+prompt.id
  const hookPairs = {};

  // First pass: collect tool decisions and results
  for (const log of sortedLogs) {
    const body = log.body?.stringValue || '';
    if (body === 'claude_code.tool_decision') {
      const toolUseId = getAttr(log.attributes, 'tool_use_id');
      if (toolUseId) {
        if (!toolGroups[toolUseId]) toolGroups[toolUseId] = {};
        toolGroups[toolUseId].decision = log;
      }
    } else if (body === 'claude_code.tool_result') {
      const toolUseId = getAttr(log.attributes, 'tool_use_id');
      if (toolUseId) {
        if (!toolGroups[toolUseId]) toolGroups[toolUseId] = {};
        toolGroups[toolUseId].result = log;
      }
    } else if (body === 'claude_code.hook_execution_start') {
      const hookName = getAttr(log.attributes, 'hook_name');
      const promptId = getAttr(log.attributes, 'prompt.id') || '';
      const key = `${hookName}:${promptId}`;
      if (!hookPairs[key]) hookPairs[key] = {};
      hookPairs[key].start = log;
    } else if (body === 'claude_code.hook_execution_complete') {
      const hookName = getAttr(log.attributes, 'hook_name');
      const promptId = getAttr(log.attributes, 'prompt.id') || '';
      const key = `${hookName}:${promptId}`;
      if (!hookPairs[key]) hookPairs[key] = {};
      hookPairs[key].complete = log;
    }
  }

  // Build ordered event list with type tagging
  const events = [];

  for (const log of sortedLogs) {
    const body = log.body?.stringValue || '';
    if (body === 'claude_code.api_request') {
      const querySource = getAttr(log.attributes, 'query_source');
      // Skip CLI-internal calls that don't belong to the agent's conversation:
      // session-title generation and the post-turn "what should the user type
      // next?" prompt suggestion. Including them would make the suggestion's
      // tiny reply masquerade as the agent's final response.
      if (querySource === 'generate_session_title' || querySource === 'prompt_suggestion') continue;
      events.push({ type: 'llm', log, time: BigInt(log.timeUnixNano) });
    } else if (body === 'claude_code.tool_decision') {
      const toolUseId = getAttr(log.attributes, 'tool_use_id');
      events.push({ type: 'tool', toolUseId, log, time: BigInt(log.timeUnixNano) });
    } else if (body === 'claude_code.hook_execution_start') {
      const hookName = getAttr(log.attributes, 'hook_name');
      const promptId = getAttr(log.attributes, 'prompt.id') || '';
      events.push({ type: 'hook', hookKey: `${hookName}:${promptId}`, log, time: BigInt(log.timeUnixNano) });
    }
  }

  events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  // We need to track the request_ids in order to look up tool_results from NEXT request body
  const llmRequestIds = [];

  for (const ev of events) {
    if (ev.type === 'llm') {
      const log = ev.log;
      const reqId = getAttr(log.attributes, 'request_id');
      const llmSpan = reqId ? llmSpanByRequestId[reqId] : null;

      const model = getAttr(log.attributes, 'model') || '';
      const inputTokens = Number(getAttr(log.attributes, 'input_tokens') || 0);
      const outputTokens = Number(getAttr(log.attributes, 'output_tokens') || 0);
      const cacheReadTokens = Number(getAttr(log.attributes, 'cache_read_tokens') || 0);
      const cacheCreationTokens = Number(getAttr(log.attributes, 'cache_creation_tokens') || 0);
      const costUsd = Number(getAttr(log.attributes, 'cost_usd') || 0);
      const durationMs = Number(getAttr(log.attributes, 'duration_ms') || 0);

      const ttftMs = llmSpan ? Number(getAttr(llmSpan.attributes, 'ttft_ms') || 0) : 0;
      const stopReason = llmSpan ? getAttr(llmSpan.attributes, 'stop_reason') || '' : '';

      totalCost += costUsd;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      // Build conversation blocks from response body (OTEL_LOG_RAW_API_BODIES path)
      const respBody = reqId ? responseBodies[reqId] : null;
      const blocks = buildBlocksFromResponse(respBody);

      if (reqId) llmRequestIds.push(reqId);

      agentNodes.push({
        kind: 'LLM_CALL',
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd,
        durationMs,
        ttftMs,
        stopReason,
        requestId: reqId || '',
        blocks,
        graphNode: '',
      });
    } else if (ev.type === 'tool') {
      const { toolUseId } = ev;
      const group = toolGroups[toolUseId] || {};
      const decisionLog = group.decision;
      const resultLog = group.result;

      let toolName = getAttr(decisionLog?.attributes, 'tool_name') ||
        getAttr(resultLog?.attributes, 'tool_name') || '';
      const decision = getAttr(decisionLog?.attributes, 'decision') || 'unknown';
      const source = getAttr(decisionLog?.attributes, 'source') || '';
      const toolInput = getAttr(resultLog?.attributes, 'tool_input') || '';
      const toolResultSizeBytes = Number(getAttr(resultLog?.attributes, 'tool_result_size_bytes') || 0);
      const toolDurationMs = Number(getAttr(resultLog?.attributes, 'duration_ms') || 0);
      const success = getAttr(resultLog?.attributes, 'success');

      // For MCP tools, resolve the actual tool name from tool_parameters
      if (toolName === 'mcp_tool') {
        const toolParamsStr = getAttr(resultLog?.attributes, 'tool_parameters') || '';
        try {
          const tp = JSON.parse(toolParamsStr);
          if (tp.mcp_tool_name) {
            toolName = tp.mcp_server_name
              ? `${tp.mcp_server_name}/${tp.mcp_tool_name}`
              : tp.mcp_tool_name;
          }
        } catch {}
      }

      const toolSpan = toolSpanByUseId[toolUseId];
      const toolError = getAttr(resultLog?.attributes, 'error') || '';
      const toolNode = {
        kind: 'TOOL',
        toolUseId,
        toolName,
        decision,
        source,
        toolInput,
        toolResultSizeBytes,
        durationMs: toolDurationMs,
        success: success === 'true' || success === true,
      };
      if (toolError) toolNode.error = toolError;
      agentNodes.push(toolNode);
    } else if (ev.type === 'hook') {
      const { hookKey } = ev;
      const pair = hookPairs[hookKey] || {};
      const startLog = pair.start || ev.log;
      const completeLog = pair.complete;

      const hookName = getAttr(startLog.attributes, 'hook_name') || '';
      const hookEvent = getAttr(startLog.attributes, 'hook_event') || '';
      const totalDurationMs = completeLog
        ? Number(getAttr(completeLog.attributes, 'total_duration_ms') || 0)
        : 0;
      const numSuccess = completeLog
        ? Number(getAttr(completeLog.attributes, 'num_success') || 0)
        : 0;
      const numHooks = completeLog
        ? Number(getAttr(completeLog.attributes, 'num_hooks') || 0)
        : Number(getAttr(startLog.attributes, 'num_hooks') || 0);

      agentNodes.push({
        kind: 'HOOK',
        hookName,
        hookEvent,
        durationMs: totalDurationMs,
        success: numSuccess === numHooks && numHooks > 0,
        numHooks,
        numSuccess,
      });
    }
  }

  // Upstream / downstream LLM spans (anthropic.chat from outer orchestrator)
  const turnStart = BigInt(interactionSpan.startTimeUnixNano);
  const turnEnd   = BigInt(interactionSpan.endTimeUnixNano);
  const prevEndBig   = BigInt(prevEnd);
  const nextStartBig = nextStart ? BigInt(nextStart) : null;

  const preSpans = orchestratorSpans.filter((s) => {
    const end   = BigInt(s.endTimeUnixNano);
    const start = BigInt(s.startTimeUnixNano);
    return end <= turnStart && start >= prevEndBig;
  });

  const postSpans = orchestratorSpans.filter((s) => {
    const start = BigInt(s.startTimeUnixNano);
    const end   = BigInt(s.endTimeUnixNano);
    return start >= turnEnd && (nextStartBig === null || end <= nextStartBig);
  });

  const upstreamPre  = preSpans.map((s) => buildWorkflowNode(s, 'UPSTREAM_LLM', null));
  const upstreamPost = postSpans.map((s) => buildWorkflowNode(s, 'DOWNSTREAM_LLM', null));

  // TOOL-node lookup so TOOL_RESULT blocks can carry status (success / error
  // reason / duration). Pairing on the FE then stays block-local.
  const toolNodeByUseId = {};
  for (const n of agentNodes) {
    if (n.kind === 'TOOL' && n.toolUseId) toolNodeByUseId[n.toolUseId] = n;
  }

  // SDK capture: build flat conversation blocks for the turn
  let capturedBlocks = null;
  if (capturedTurn) {
    // Build tool_result lookup from user messages
    const toolResultMap = {}; // tool_use_id -> {text, name, is_error}
    for (const msg of capturedTurn.messages) {
      if (msg.role !== 'user') continue;
      for (const b of msg.blocks || []) {
        if (b.type === 'TOOL_RESULT') toolResultMap[b.id] = b;
      }
    }

    // The SDK capture strips extended-thinking content even when the API
    // returned it (it shows up as { type: "THOUGHT", text: "" }). Source the
    // redacted-with-signature variant from the LLM_CALL.blocks we already
    // built from api_bodies via the normalizer — and fall back to a plain
    // redacted shape when no api-body match exists.
    const redactedThoughtPool = [];
    for (const n of agentNodes) {
      if (n.kind !== 'LLM_CALL') continue;
      for (const b of n.blocks || []) {
        if (b.type === 'THOUGHT') redactedThoughtPool.push(b);
      }
    }
    let thoughtPoolIdx = 0;

    // Flatten all assistant blocks in order; inject TOOL_RESULT after each TOOL_USE
    capturedBlocks = [];
    for (const msg of capturedTurn.messages) {
      if (msg.role !== 'assistant') continue;
      for (const block of msg.blocks || []) {
        if (block.type === 'THOUGHT') {
          const text = typeof block.text === 'string' ? block.text : '';
          const isRedacted = text.trim() === '' || text.trim() === '<REDACTED>';
          if (isRedacted) {
            const better = redactedThoughtPool[thoughtPoolIdx++];
            capturedBlocks.push(better || { type: 'THOUGHT', text: '', redacted: true, signature: '' });
          } else {
            capturedBlocks.push({ type: 'THOUGHT', text, redacted: false });
          }
          continue;
        }
        capturedBlocks.push(block);
        if (block.type === 'TOOL_USE' && toolResultMap[block.id]) {
          const r = toolResultMap[block.id];
          const tn = toolNodeByUseId[block.id];
          const errText = tn?.error || '';
          const ok = tn ? (!errText && tn.success !== false) : !(r.is_error);
          capturedBlocks.push({
            type: 'TOOL_RESULT',
            id: block.id,
            name: block.name,
            text: r.text || '',
            is_error: r.is_error || false,
            success: ok,
            errorText: errText,
            durationMs: tn?.durationMs ?? 0,
          });
        }
      }
    }
  } else {
    // Fallback: OTEL_LOG_RAW_API_BODIES path — build blocks from response bodies
    // and inject tool_results from the next request body's messages
    for (let i = 0; i < agentNodes.length; i++) {
      const node = agentNodes[i];
      if (node.kind !== 'LLM_CALL' || !node.blocks?.length) continue;

      const toolUseIds = new Set(
        node.blocks.filter((b) => b.type === 'TOOL_USE').map((b) => b.id)
      );
      if (toolUseIds.size === 0) continue;

      const myIdx = llmRequestIds.indexOf(node.requestId);
      const nextReqId = myIdx >= 0 ? llmRequestIds[myIdx + 1] : undefined;
      const nextReqBody = nextReqId ? requestBodies[nextReqId] : undefined;

      if (nextReqBody) {
        const resultTexts = findToolResults(nextReqBody, toolUseIds);
        const expanded = [];
        for (const block of node.blocks) {
          expanded.push(block);
          if (block.type === 'TOOL_USE' && resultTexts[block.id] !== undefined) {
            const tn = toolNodeByUseId[block.id];
            const errText = tn?.error || '';
            const ok = tn ? (!errText && tn.success !== false) : true;
            expanded.push({
              type: 'TOOL_RESULT',
              id: block.id,
              name: block.name,
              text: resultTexts[block.id],
              success: ok,
              errorText: errText,
              durationMs: tn?.durationMs ?? 0,
              is_error: !ok || undefined,
            });
          }
        }
        node.blocks = expanded;
      }
    }
  }

  // Mark final TEXT block as AGENT_RESPONSE (distinguishes final reply from mid-conversation text)
  if (capturedBlocks) {
    for (let i = capturedBlocks.length - 1; i >= 0; i--) {
      if (capturedBlocks[i].type === 'TEXT') {
        capturedBlocks[i] = { ...capturedBlocks[i], type: 'AGENT_RESPONSE' };
        break;
      }
      if (capturedBlocks[i].type === 'TOOL_USE' || capturedBlocks[i].type === 'TOOL_RESULT') break;
    }
  }

  // Promote Agent-tool invocations to canonical AGENT-kind AgentNodes.
  //
  // Detection: a TOOL node whose `toolName === 'Agent'` corresponds to a
  // `claude_code.tool` span (with `tool_name=Agent`) under the turn's
  // interaction span. The sub-agent's LLM and nested tool calls appear as
  // descendant spans (`claude_code.llm_request`, `claude_code.tool`) of
  // that Agent tool span. We pull the matched top-level AgentNodes into
  // the new AGENT node's `nodes` array.
  //
  // Correlation: SDK `claude_code.tool` spans do NOT carry a `tool_use_id`
  // attribute — only the logs do. We instead match the Nth Agent-named
  // tool span (in temporal order) to the Nth Agent-named TOOL AgentNode.
  // Both lists are temporally ordered, so positional matching is reliable
  // for a single turn.
  //
  // Mirrors the recursive `promoteSubAgents` pass in claude_code_cli.js.
  const agentToolSpansForTurn = getDescendants(interactionSpan.spanId, childrenOf)
    .filter((s) => s.name === 'claude_code.tool' && getAttr(s.attributes, 'tool_name') === 'Agent')
    .sort((a, b) => {
      const aN = BigInt(a.startTimeUnixNano);
      const bN = BigInt(b.startTimeUnixNano);
      return aN < bN ? -1 : aN > bN ? 1 : 0;
    });

  (function promoteSubAgentsSDK(nodes, toolSpansToConsume) {
    let toolSpanIdx = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.kind !== 'TOOL' || node.toolName !== 'Agent') continue;
      const toolSpan = toolSpansToConsume[toolSpanIdx++];
      if (!toolSpan) continue;

      // Descendant request_ids identify which LLM_CALL nodes belong to the
      // sub-agent. (For nested Agent tools, those descendants will include
      // further `claude_code.tool` spans — those become sub-sub-agent
      // candidates and are passed to the recursive call below.)
      const subLlmReqIds = new Set();
      const nestedAgentToolSpans = [];
      for (const d of getDescendants(toolSpan.spanId, childrenOf)) {
        if (d.name === 'claude_code.llm_request') {
          const reqId = getAttr(d.attributes, 'request_id');
          if (reqId) subLlmReqIds.add(reqId);
        } else if (d.name === 'claude_code.tool' && getAttr(d.attributes, 'tool_name') === 'Agent') {
          nestedAgentToolSpans.push(d);
        }
      }
      // Tool descendants that aren't Agent tools — the sub-agent's
      // ordinary tool calls. Match by start-time order against TOOL nodes
      // in the sub-agent's window.
      const subOrdinaryToolSpans = getDescendants(toolSpan.spanId, childrenOf)
        .filter((d) => d.name === 'claude_code.tool' && getAttr(d.attributes, 'tool_name') !== 'Agent');

      if (subLlmReqIds.size === 0 && nestedAgentToolSpans.length === 0 && subOrdinaryToolSpans.length === 0) continue;

      // Match the Agent's tool span time window — anything from the same
      // turn whose timestamp falls inside is a candidate for sub-agent.
      const winStart = BigInt(toolSpan.startTimeUnixNano);
      const winEnd = BigInt(toolSpan.endTimeUnixNano);

      // Build a quick lookup: tool spans by tool_name in order, for
      // matching ordinary sub-tool TOOL nodes.
      let subOrdinaryIdx = 0;
      const subOrdinaryByName = {};
      for (const s of subOrdinaryToolSpans.sort((a, b) => {
        const aN = BigInt(a.startTimeUnixNano);
        const bN = BigInt(b.startTimeUnixNano);
        return aN < bN ? -1 : aN > bN ? 1 : 0;
      })) {
        const tn = getAttr(s.attributes, 'tool_name') || '';
        if (!subOrdinaryByName[tn]) subOrdinaryByName[tn] = [];
        subOrdinaryByName[tn].push(s);
      }
      const subOrdinaryRemaining = JSON.parse(JSON.stringify(
        Object.fromEntries(Object.entries(subOrdinaryByName).map(([k, v]) => [k, v.length])),
      ));

      const subIndices = [];
      for (let j = i + 1; j < nodes.length; j++) {
        const c = nodes[j];
        if (c.kind === 'LLM_CALL' && c.requestId && subLlmReqIds.has(c.requestId)) {
          subIndices.push(j);
        } else if (c.kind === 'TOOL') {
          // Ordinary sub-agent tool — match by tool_name + count remaining
          const tn = c.toolName || '';
          if (subOrdinaryRemaining[tn] > 0) {
            subOrdinaryRemaining[tn] -= 1;
            subIndices.push(j);
          }
        }
      }
      if (subIndices.length === 0) continue;

      const subNodes = subIndices.map((j) => nodes[j]);
      for (const j of subIndices.reverse()) nodes.splice(j, 1);

      // Recurse so Task-within-Task is also promoted, passing in the
      // sub-agent's own nested Agent tool spans.
      promoteSubAgentsSDK(subNodes, nestedAgentToolSpans);

      // Extract agent metadata: prefer subagent_type, fall back to
      // description (truncated), then the generic "Agent" label.
      let agentName = 'Agent';
      let agentType = 'subagent';
      try {
        const parsed = node.toolInput ? JSON.parse(node.toolInput) : {};
        if (parsed.subagent_type) {
          agentName = parsed.subagent_type;
        } else if (parsed.description) {
          agentName = String(parsed.description).slice(0, 60);
        }
      } catch {}

      const startNanoSpan = toolSpan.startTimeUnixNano;
      const endNanoSpan = toolSpan.endTimeUnixNano;

      nodes[i] = {
        kind: 'AGENT',
        agentName,
        agentType,
        // Preserve toolUseId so the frontend can splice this AGENT into
        // the parent's conversation view at the matching TOOL_USE block,
        // instead of rendering it in a separate appendix.
        toolUseId: node.toolUseId || '',
        source: node.source || '',
        nodes: subNodes,
        durationMs: Number((BigInt(endNanoSpan) - BigInt(startNanoSpan)) / 1000000n),
        startTime: nanoToDate(startNanoSpan).toISOString(),
        endTime: nanoToDate(endNanoSpan).toISOString(),
      };
    }
  })(agentNodes, agentToolSpansForTurn);

  // Parallel detection — structural, from the SDK's raw OTEL data paths.
  // The Anthropic API emits a parallel batch as N tool_use blocks in ONE
  // assistant response. Two data sources express the same thing:
  //   1. responseBodies[reqId].content   (file mode, raw API payload)
  //   2. capturedTurn.messages[m].blocks (SDK capture path)
  // We try (1) first because it's exact OTEL; (2) fills in when bodies
  // weren't captured. Recurses into promoted sub-agents.
  (function stampParallelFromAnthropicSources(nodes) {
    // Path 1: raw response bodies
    for (const respBody of Object.values(responseBodies || {})) {
      const content = Array.isArray(respBody?.content) ? respBody.content : [];
      const toolUseIds = content
        .filter((c) => c && c.type === 'tool_use' && c.id)
        .map((c) => c.id);
      if (toolUseIds.length >= 2) stampParallelGroup(nodes, toolUseIds);
    }
    // Path 2: SDK capture per-assistant-message blocks
    if (capturedTurn?.messages) {
      for (const msg of capturedTurn.messages) {
        if (msg.role !== 'assistant') continue;
        const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
        const toolUseIds = blocks
          .filter((b) => b && b.type === 'TOOL_USE' && b.id)
          .map((b) => b.id);
        if (toolUseIds.length >= 2) stampParallelGroup(nodes, toolUseIds);
      }
    }
    // Recurse into sub-agents — they may themselves emit parallel batches
    // via their own LLM_CALL.blocks (we don't have a separate response-body
    // file for sub-agents, so use the canonical LLM_CALL.blocks already
    // assembled from the same raw OTEL).
    for (const n of nodes) {
      if (n.kind !== 'AGENT' || !Array.isArray(n.nodes)) continue;
      for (const child of n.nodes) {
        if (child.kind !== 'LLM_CALL' || !Array.isArray(child.blocks)) continue;
        const toolUseIds = child.blocks
          .filter((b) => b && b.type === 'TOOL_USE' && b.id)
          .map((b) => b.id);
        if (toolUseIds.length >= 2) stampParallelGroup(n.nodes, toolUseIds);
      }
      stampParallelFromAnthropicSources(n.nodes);
    }
  })(agentNodes);

  // Derived tool-call summary — counts every TOOL-kind invocation by name,
  // recursing into nested AGENT-kind sub-agents so calls roll up.
  const toolCallCounts = collectToolCallsFromAgentNodes(agentNodes);

  // Per-agent-scope availableTools (strict isolation, no cross-scope leak).
  //
  // Each AGENT scope's list is built ONLY from its own direct LLM_CALL
  // children — never traversing into AGENT-kind children — so a sub-agent's
  // tools never leak into its parent's catalog and vice versa. Mirrors the
  // direct-children-only convention used by `collectToolCallsFromAgentNodes`.
  function collectScopeTools(scopedNodes) {
    const list = [];
    const seen = new Set();
    function take({ name, description, inputSchema }) {
      const entry = mergeTool({ name, description, inputSchema });
      if (!entry || seen.has(entry.name)) return;
      seen.add(entry.name);
      list.push(entry);
    }
    for (const node of scopedNodes || []) {
      if (node.kind === 'LLM_CALL') {
        const reqId = node.requestId;
        const reqBody = reqId ? requestBodies[reqId] : null;
        for (const tool of reqBody?.tools || []) {
          take({
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.input_schema || null,
          });
        }
        const llmSpan = reqId ? llmSpanByRequestId[reqId] : null;
        const defs = llmSpan ? getAttr(llmSpan.attributes, 'gen_ai.tool.definitions') : null;
        if (defs) {
          try {
            const arr = JSON.parse(defs);
            if (Array.isArray(arr)) {
              for (const t of arr) {
                take({
                  name: t.name,
                  description: t.description || '',
                  inputSchema: t.input_schema || t.inputSchema || null,
                });
              }
            }
          } catch {}
        }
        for (const block of node.blocks || []) {
          if (block?.type === 'TOOL_USE' && block.name) {
            take({ name: block.name, description: '', inputSchema: null });
          }
        }
      } else if (node.kind === 'TOOL' && node.toolName) {
        take({ name: node.toolName, description: '', inputSchema: null });
      }
    }
    return list;
  }

  // Attach availableTools to every AGENT-kind node in the tree, then compute
  // the top-level step's own list. Each scope is independent.
  (function attachAvailableToolsToAgentTree(nodes) {
    for (const node of nodes || []) {
      if (node.kind === 'AGENT') {
        node.availableTools = collectScopeTools(node.nodes);
        attachAvailableToolsToAgentTree(node.nodes);
      }
    }
  })(agentNodes);
  const stepAvailableTools = collectScopeTools(agentNodes);

  // Turn-level union: top-level step's tools + every nested AGENT's tools.
  // Dedupe by object identity (entries are minted by the shared mergeTool).
  const turnAvailableTools = [];
  const turnSeen = new Set();
  function unionInto(list) {
    for (const t of list || []) {
      if (!turnSeen.has(t.name)) { turnSeen.add(t.name); turnAvailableTools.push(t); }
    }
  }
  unionInto(stepAvailableTools);
  (function gatherFromTree(nodes) {
    for (const node of nodes || []) {
      if (node.kind === 'AGENT') {
        unionInto(node.availableTools);
        gatherFromTree(node.nodes);
      }
    }
  })(agentNodes);

  // AGENT step (collapsed cascade of all LLM/TOOL/HOOK nodes)
  steps.push({ type: 'AGENT', nodes: agentNodes, capturedBlocks, upstreamPre, upstreamPost, userPrompt, toolCallCounts, availableTools: stepAvailableTools });

  // FINAL step
  steps.push({
    type: 'FINAL',
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    durationMs,
  });

  // Build workflow graph — find pipeline span by temporal overlap (different traceId from interaction)
  const iStart = BigInt(interactionSpan.startTimeUnixNano);
  const iEnd   = BigInt(interactionSpan.endTimeUnixNano);
  const pipelineSpan = pipelineSpans.find((p) => {
    const pStart = BigInt(p.startTimeUnixNano);
    const pEnd   = BigInt(p.endTimeUnixNano);
    return pStart <= iStart && pEnd >= iEnd;
  }) || null;
  const agentStepData = { type: 'AGENT', nodes: agentNodes, capturedBlocks, userPrompt, toolCallCounts, availableTools: stepAvailableTools };
  const workflowGraph = buildWorkflowGraph(pipelineSpan, childrenOf, interactionSpan, agentStepData, preSpans, postSpans);

  return {
    idx,
    userPrompt,
    startTime: nanoToDate(startNano).toISOString(),
    endTime: nanoToDate(endNano).toISOString(),
    durationMs,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    steps,
    workflowGraph,
    availableTools: turnAvailableTools,
  };
}
