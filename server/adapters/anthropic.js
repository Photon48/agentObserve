import { getAttr } from '../loader.js';
import { nanoToMs, nanoToDate, buildWorkflowNode, inferToolSchemas } from './shared.js';

export const FRAMEWORK = 'anthropic';

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
      pipelineSpans, childrenOf);
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

  // Extract available tools from request bodies (deduplicated by name)
  const availableTools = [];
  const toolNamesSeen = new Set();
  for (const reqBody of Object.values(requestBodies)) {
    for (const tool of reqBody.tools || []) {
      if (!toolNamesSeen.has(tool.name)) {
        toolNamesSeen.add(tool.name);
        availableTools.push({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.input_schema || null,
        });
      }
    }
  }

  // Fallback: collect unique tool names from TOOL_USE blocks when no request bodies have tools
  if (availableTools.length === 0) {
    for (const turn of turns) {
      const agentStep = turn.steps?.find((s) => s.type === 'AGENT');
      for (const block of agentStep?.capturedBlocks || []) {
        if (block.type === 'TOOL_USE' && !toolNamesSeen.has(block.name)) {
          toolNamesSeen.add(block.name);
          availableTools.push({ name: block.name, description: '', inputSchema: null });
        }
      }
    }
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

// Build conversation blocks from a response body content array
function buildBlocksFromResponse(respBody) {
  if (!respBody?.content) return [];
  const blocks = [];
  for (const item of respBody.content) {
    if (item.type === 'thinking') {
      blocks.push({ type: 'THOUGHT', text: item.thinking || '' });
    } else if (item.type === 'text') {
      blocks.push({ type: 'TEXT', text: item.text || '' });
    } else if (item.type === 'tool_use') {
      blocks.push({ type: 'TOOL_USE', id: item.id, name: item.name, input: item.input || {} });
    }
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

function buildTurn(idx, interactionSpan, logs, llmSpanByRequestId, toolSpanByUseId, requestBodies, responseBodies, capturedTurn, orchestratorSpans = [], prevEnd = '0', nextStart = null, pipelineSpans = [], childrenOf = {}) {
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
      if (querySource === 'generate_session_title') continue;
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

      agentNodes.push({
        kind: 'TOOL',
        toolUseId,
        toolName,
        decision,
        source,
        toolInput,
        toolResultSizeBytes,
        durationMs: toolDurationMs,
        success: success === 'true' || success === true,
      });
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

    // Flatten all assistant blocks in order; inject TOOL_RESULT after each TOOL_USE
    capturedBlocks = [];
    for (const msg of capturedTurn.messages) {
      if (msg.role !== 'assistant') continue;
      for (const block of msg.blocks || []) {
        capturedBlocks.push(block);
        if (block.type === 'TOOL_USE' && toolResultMap[block.id]) {
          const r = toolResultMap[block.id];
          capturedBlocks.push({
            type: 'TOOL_RESULT',
            id: block.id,
            name: block.name,
            text: r.text || '',
            is_error: r.is_error || false,
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
            expanded.push({
              type: 'TOOL_RESULT',
              id: block.id,
              name: block.name,
              text: resultTexts[block.id],
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

  // AGENT step (collapsed cascade of all LLM/TOOL/HOOK nodes)
  steps.push({ type: 'AGENT', nodes: agentNodes, capturedBlocks, upstreamPre, upstreamPost, userPrompt });

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
  const agentStepData = { type: 'AGENT', nodes: agentNodes, capturedBlocks, userPrompt };
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
  };
}
