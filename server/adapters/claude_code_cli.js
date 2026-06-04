import { getAttr } from '../loader.js';
import { nanoToMs, nanoToDate, inferToolSchemas } from './shared.js';

export const FRAMEWORK = 'claude-code-cli';

// Matches CLI telemetry: has user_prompt logs but NO interaction spans
export function canHandle(rawData) {
  const hasUserPrompt = rawData.logs?.some(
    (l) => (l.body?.stringValue || '') === 'claude_code.user_prompt',
  );
  const hasInteraction = rawData.spans?.some(
    (s) => s.name === 'claude_code.interaction',
  );
  return hasUserPrompt && !hasInteraction;
}

export function buildSession(sessionId, raw) {
  const { logs, spans = [], requestBodies = {}, responseBodies = {}, toolOutputEvents = {} } = raw;

  // ── Group logs by prompt.id ──────────────────────────────────────────────
  const logsByPromptId = {};
  for (const log of logs) {
    const pid = getAttr(log.attributes, 'prompt.id');
    if (!pid) continue;
    if (!logsByPromptId[pid]) logsByPromptId[pid] = [];
    logsByPromptId[pid].push(log);
  }

  // Each prompt.id with a user_prompt defines a turn
  const turnGroups = [];
  for (const [pid, turnLogs] of Object.entries(logsByPromptId)) {
    const userPromptLog = turnLogs.find(
      (l) => (l.body?.stringValue || '') === 'claude_code.user_prompt',
    );
    if (!userPromptLog) continue;
    turnGroups.push({ promptId: pid, logs: turnLogs, userPromptLog });
  }

  if (turnGroups.length === 0) return null;

  // Sort turns by user_prompt timestamp
  turnGroups.sort((a, b) => {
    const aN = BigInt(a.userPromptLog.timeUnixNano);
    const bN = BigInt(b.userPromptLog.timeUnixNano);
    return aN < bN ? -1 : aN > bN ? 1 : 0;
  });

  // ── Span indexes ─────────────────────────────────────────────────────────
  // llm_request spans keyed by request_id (when available)
  const llmSpanByRequestId = {};
  // llm_request spans in temporal order (fallback when no request_id)
  const llmSpansByTime = [];
  for (const span of spans) {
    if (span.name === 'claude_code.llm_request') {
      const reqId = getAttr(span.attributes, 'request_id');
      if (reqId) llmSpanByRequestId[reqId] = span;
      llmSpansByTime.push(span);
    }
  }
  llmSpansByTime.sort((a, b) => {
    const aN = BigInt(a.startTimeUnixNano);
    const bN = BigInt(b.startTimeUnixNano);
    return aN < bN ? -1 : aN > bN ? 1 : 0;
  });

  // tool spans keyed by tool_use_id
  const toolSpanByUseId = {};
  // tool spans in temporal order (fallback when no tool_use_id)
  const toolSpansByTime = [];
  // child spans (execution, blocked_on_user) keyed by parentSpanId
  const childSpansByParent = {};
  for (const span of spans) {
    if (span.name === 'claude_code.tool') {
      const toolUseId = getAttr(span.attributes, 'tool_use_id');
      if (toolUseId) toolSpanByUseId[toolUseId] = span;
      toolSpansByTime.push(span);
    } else if (span.name === 'claude_code.tool.execution' || span.name === 'claude_code.tool.blocked_on_user') {
      const pid = span.parentSpanId;
      if (pid) {
        if (!childSpansByParent[pid]) childSpansByParent[pid] = [];
        childSpansByParent[pid].push(span);
      }
    }
  }
  toolSpansByTime.sort((a, b) => {
    const aN = BigInt(a.startTimeUnixNano);
    const bN = BigInt(b.startTimeUnixNano);
    return aN < bN ? -1 : aN > bN ? 1 : 0;
  });

  // Extract system prompt from first request body
  const firstReqBody = Object.values(requestBodies)[0];
  const systemPrompt = firstReqBody?.system
    ? (Array.isArray(firstReqBody.system)
        ? firstReqBody.system.map((b) => b.text || '').join('\n')
        : String(firstReqBody.system))
    : '';

  // ── Build turns ──────────────────────────────────────────────────────────
  let llmSpanIdx = 0; // for temporal matching fallback
  const turns = turnGroups.map((group, idx) => {
    const result = buildTurn(
      idx, group, llmSpanByRequestId, llmSpansByTime, llmSpanIdx,
      toolSpanByUseId, toolSpansByTime, childSpansByParent,
      requestBodies, responseBodies, systemPrompt, toolOutputEvents,
    );
    llmSpanIdx = result._nextLlmSpanIdx;
    return result.turn;
  });

  // ── Session summary ──────────────────────────────────────────────────────
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const turn of turns) {
    totalCost += turn.totalCost;
    totalInputTokens += turn.totalInputTokens;
    totalOutputTokens += turn.totalOutputTokens;
  }

  // Merge tools from every observation path. A later non-truncated body can
  // backfill description/schema for a tool whose earlier body got cut off.
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

  for (const reqBody of Object.values(requestBodies)) {
    for (const tool of reqBody.tools || []) {
      mergeTool({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.input_schema || null,
      });
    }
  }

  // Name-only fallback: tools observed via actual use, never demotes a richer entry.
  for (const turn of turns) {
    const agentStep = turn.steps?.find((s) => s.type === 'AGENT');
    for (const block of agentStep?.capturedBlocks || []) {
      if (block.type === 'TOOL_USE') {
        mergeTool({ name: block.name, description: '', inputSchema: null });
      }
    }
    for (const node of agentStep?.nodes || []) {
      if (node.kind === 'TOOL' && node.toolName) {
        mergeTool({ name: node.toolName, description: '', inputSchema: null });
      }
    }
  }

  const session = {
    id: sessionId,
    framework: FRAMEWORK,
    startTime: turns[0].startTime,
    endTime: turns[turns.length - 1].endTime,
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

// ── Build blocks from response body ────────────────────────────────────────
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

// ── Find tool_result blocks in a request body ──────────────────────────────
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

// ── Build a single turn ────────────────────────────────────────────────────
function buildTurn(
  idx, group, llmSpanByRequestId, llmSpansByTime, llmSpanIdx,
  toolSpanByUseId, toolSpansByTime, childSpansByParent,
  requestBodies, responseBodies, systemPrompt, toolOutputEvents,
) {
  const { logs: turnLogs, userPromptLog } = group;

  const userPrompt = getAttr(userPromptLog.attributes, 'prompt') || '';
  const startNano = userPromptLog.timeUnixNano;

  // Sort logs by timeUnixNano
  const sortedLogs = [...turnLogs].sort((a, b) => {
    const aN = BigInt(a.timeUnixNano);
    const bN = BigInt(b.timeUnixNano);
    return aN < bN ? -1 : aN > bN ? 1 : 0;
  });

  const endNano = sortedLogs[sortedLogs.length - 1].timeUnixNano;
  const durationMs = Number(BigInt(endNano) / 1000000n) - Number(BigInt(startNano) / 1000000n);

  const steps = [];
  const agentNodes = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // PROMPT step
  steps.push({ type: 'PROMPT', text: userPrompt });

  // Collect tool groups and hook pairs
  const toolGroups = {};
  const hookPairs = {};

  // Fallback counter for tools without tool_use_id (CLI events may omit it)
  let syntheticToolIdx = 0;
  for (const log of sortedLogs) {
    const body = log.body?.stringValue || '';
    if (body === 'claude_code.tool_decision') {
      const toolUseId = getAttr(log.attributes, 'tool_use_id') || `_syn_${syntheticToolIdx++}`;
      if (!toolGroups[toolUseId]) toolGroups[toolUseId] = {};
      toolGroups[toolUseId].decision = log;
      // Tag the log so event loop can find the same key
      log._toolGroupKey = toolUseId;
    } else if (body === 'claude_code.tool_result') {
      // Match result to the most recent unmatched decision by tool_name
      const toolUseId = getAttr(log.attributes, 'tool_use_id');
      if (toolUseId) {
        if (!toolGroups[toolUseId]) toolGroups[toolUseId] = {};
        toolGroups[toolUseId].result = log;
      } else {
        // Fallback: find the last decision group without a result that matches this tool_name
        const toolName = getAttr(log.attributes, 'tool_name') || '';
        const matchKey = Object.keys(toolGroups).reverse().find((k) =>
          !toolGroups[k].result &&
          getAttr(toolGroups[k].decision?.attributes, 'tool_name') === toolName,
        );
        if (matchKey) {
          toolGroups[matchKey].result = log;
        }
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

  // Build ordered events
  const events = [];
  for (const log of sortedLogs) {
    const body = log.body?.stringValue || '';
    if (body === 'claude_code.api_request') {
      const querySource = getAttr(log.attributes, 'query_source');
      if (querySource === 'generate_session_title') continue;
      events.push({ type: 'llm', log, time: BigInt(log.timeUnixNano) });
    } else if (body === 'claude_code.tool_decision') {
      const toolUseId = getAttr(log.attributes, 'tool_use_id') || log._toolGroupKey;
      events.push({ type: 'tool', toolUseId, log, time: BigInt(log.timeUnixNano) });
    } else if (body === 'claude_code.hook_execution_start') {
      const hookName = getAttr(log.attributes, 'hook_name');
      const promptId = getAttr(log.attributes, 'prompt.id') || '';
      events.push({ type: 'hook', hookKey: `${hookName}:${promptId}`, log, time: BigInt(log.timeUnixNano) });
    }
  }
  events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const llmRequestIds = [];

  for (const ev of events) {
    if (ev.type === 'llm') {
      const log = ev.log;
      const reqId = getAttr(log.attributes, 'request_id');

      // Match llm_request span: by request_id if available, else temporal fallback
      let llmSpan = null;
      if (reqId) {
        llmSpan = llmSpanByRequestId[reqId];
      } else if (llmSpanIdx < llmSpansByTime.length) {
        llmSpan = llmSpansByTime[llmSpanIdx];
        llmSpanIdx++;
      }

      const model = getAttr(log.attributes, 'model') || '';
      const inputTokens = Number(getAttr(log.attributes, 'input_tokens') || 0);
      const outputTokens = Number(getAttr(log.attributes, 'output_tokens') || 0);
      const cacheReadTokens = Number(getAttr(log.attributes, 'cache_read_tokens') || 0);
      const cacheCreationTokens = Number(getAttr(log.attributes, 'cache_creation_tokens') || 0);
      const costUsd = Number(getAttr(log.attributes, 'cost_usd') || 0);
      const llmDurationMs = Number(getAttr(log.attributes, 'duration_ms') || 0);

      const ttftMs = llmSpan ? Number(getAttr(llmSpan.attributes, 'ttft_ms') || 0) : 0;
      const stopReason = llmSpan ? getAttr(llmSpan.attributes, 'stop_reason') || '' : '';

      totalCost += costUsd;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      // Build conversation blocks from response body
      const respBody = reqId ? responseBodies[reqId] : null;
      const blocks = buildBlocksFromResponse(respBody);

      if (reqId) llmRequestIds.push(reqId);

      // Subagent scaffolding: tag with agent_id/parent_agent_id when present
      const llmAgentId = getAttr(llmSpan?.attributes, 'agent_id') || '';
      const llmParentAgentId = getAttr(llmSpan?.attributes, 'parent_agent_id') || '';

      const llmNode = {
        kind: 'LLM_CALL',
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd,
        durationMs: llmDurationMs,
        ttftMs,
        stopReason,
        requestId: reqId || '',
        blocks,
        graphNode: '',
      };
      if (llmAgentId) llmNode.agentId = llmAgentId;
      if (llmParentAgentId) llmNode.parentAgentId = llmParentAgentId;

      llmNode._eventTime = ev.time;
      agentNodes.push(llmNode);
    } else if (ev.type === 'tool') {
      const { toolUseId } = ev;
      const group = toolGroups[toolUseId] || {};
      const decisionLog = group.decision;
      const resultLog = group.result;

      let toolName = getAttr(decisionLog?.attributes, 'tool_name') ||
        getAttr(resultLog?.attributes, 'tool_name') || '';
      const decision = getAttr(decisionLog?.attributes, 'decision') || 'unknown';
      const source = getAttr(decisionLog?.attributes, 'source') || '';
      let toolInput = getAttr(resultLog?.attributes, 'tool_input') || '';
      const toolResultSizeBytes = Number(getAttr(resultLog?.attributes, 'tool_result_size_bytes') || 0);
      let toolDurationMs = Number(getAttr(resultLog?.attributes, 'duration_ms') || 0);
      let success = getAttr(resultLog?.attributes, 'success');

      // MCP tool name resolution
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

      // Enrich toolInput from tool_parameters when tool_input is empty
      if (!toolInput) {
        const toolParamsStr = getAttr(resultLog?.attributes, 'tool_parameters') || '';
        if (toolParamsStr) {
          try {
            const tp = JSON.parse(toolParamsStr);
            const inputObj = {};
            if (tp.full_command) inputObj.command = tp.full_command;
            else if (tp.bash_command) inputObj.command = tp.bash_command;
            if (tp.description) inputObj.description = tp.description;
            if (tp.file_path) inputObj.file_path = tp.file_path;
            if (tp.mcp_server_name) inputObj.mcp_server = tp.mcp_server_name;
            if (tp.mcp_tool_name) inputObj.mcp_tool = tp.mcp_tool_name;
            if (tp.skill_name) inputObj.skill = tp.skill_name;
            if (tp.subagent_type) inputObj.subagent_type = tp.subagent_type;
            if (Object.keys(inputObj).length > 0) toolInput = JSON.stringify(inputObj);
          } catch {}
        }
      }

      // Enrich from tool spans (file_path, full_command, execution duration/success)
      let toolSpan = toolSpanByUseId[toolUseId];
      if (!toolSpan) {
        // Fallback: match by tool_name in temporal order
        const spanIdx = toolSpansByTime.findIndex((s) =>
          !s._matched && getAttr(s.attributes, 'tool_name') === toolName,
        );
        if (spanIdx >= 0) {
          toolSpan = toolSpansByTime[spanIdx];
          toolSpan._matched = true;
        }
      }
      let toolOutput = '';
      if (toolSpan) {
        // Extract toolInput from span attrs when log-level tool_input is empty
        if (!toolInput) {
          const filePath = getAttr(toolSpan.attributes, 'file_path');
          const fullCommand = getAttr(toolSpan.attributes, 'full_command');
          if (filePath) toolInput = JSON.stringify({ file_path: filePath });
          else if (fullCommand) toolInput = JSON.stringify({ command: fullCommand });
        }
        // Use execution child span for accurate duration and success
        const children = childSpansByParent[toolSpan.spanId] || [];
        const execSpan = children.find((s) => s.name === 'claude_code.tool.execution');
        if (execSpan) {
          const execDur = Number(getAttr(execSpan.attributes, 'duration_ms') || 0);
          if (execDur > 0 || !toolDurationMs) toolDurationMs = execDur;
          const execSuccess = getAttr(execSpan.attributes, 'success');
          if (execSuccess !== undefined) success = execSuccess;
        }
        // Fall back to parent span duration if still 0
        if (!toolDurationMs) {
          toolDurationMs = Number(getAttr(toolSpan.attributes, 'duration_ms') || 0);
        }
        // Extract tool.output event data (tool_output from OTEL_LOG_TOOL_CONTENT=1)
        const toolOutputEvent = toolOutputEvents[toolSpan.spanId];
        if (toolOutputEvent) {
          const evAttrs = toolOutputEvent.attributes || [];
          toolOutput = getAttr(evAttrs, 'tool_output') || '';
        }
      }

      // Subagent scaffolding: tag with agent_id/parent_agent_id when present
      const toolAgentId = getAttr(toolSpan?.attributes, 'agent_id') || '';
      const toolParentAgentId = getAttr(toolSpan?.attributes, 'parent_agent_id') || '';

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
        // Span timing for parallel detection (cleaned up later)
        _spanStart: toolSpan ? toolSpan.startTimeUnixNano : null,
        _spanEnd: toolSpan ? toolSpan.endTimeUnixNano : null,
        _toolSpanId: toolSpan ? toolSpan.spanId : null,
      };
      if (toolOutput) toolNode.toolOutput = toolOutput;
      if (toolAgentId) toolNode.agentId = toolAgentId;
      if (toolParentAgentId) toolNode.parentAgentId = toolParentAgentId;

      // Enrich with error info from result log
      const toolError = getAttr(resultLog?.attributes, 'error') || '';
      if (toolError) toolNode.error = toolError;

      // Enrich with blocked_on_user timing from child span
      if (toolSpan) {
        const blockedSpan = (childSpansByParent[toolSpan.spanId] || [])
          .find(s => s.name === 'claude_code.tool.blocked_on_user');
        if (blockedSpan) {
          const blockedMs = Number(getAttr(blockedSpan.attributes, 'duration_ms') || 0);
          const blockedDec = getAttr(blockedSpan.attributes, 'decision') || '';
          if (blockedMs > 500) toolNode.blockedDurationMs = blockedMs;
          if (blockedDec && blockedDec !== 'accept') toolNode.blockedDecision = blockedDec;
        }
      }

      toolNode._eventTime = ev.time;
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
        _eventTime: ev.time,
      });
    }
  }

  // Infer stopReason from event ordering when not available from spans
  for (let i = 0; i < agentNodes.length; i++) {
    const node = agentNodes[i];
    if (node.kind !== 'LLM_CALL' || node.stopReason) continue;
    // Look at the next node after this LLM_CALL
    const next = agentNodes[i + 1];
    if (next && (next.kind === 'TOOL' || next.kind === 'HOOK')) {
      node.stopReason = 'tool_use';
    } else if (!next || next.kind === 'LLM_CALL') {
      // Last LLM call or followed by another LLM call (no tool in between)
      node.stopReason = 'end_turn';
    }
  }

  // Detect parallel tool groups from span timing overlap
  for (let i = 0; i < agentNodes.length; i++) {
    const node = agentNodes[i];
    if (node.kind !== 'TOOL' || !node._spanStart) continue;
    const group = [i];
    for (let j = i + 1; j < agentNodes.length; j++) {
      const next = agentNodes[j];
      if (next.kind !== 'TOOL' || !next._spanStart) break;
      const groupEnd = group.reduce((mx, k) => {
        const e = BigInt(agentNodes[k]._spanEnd || '0');
        return e > mx ? e : mx;
      }, 0n);
      if (BigInt(next._spanStart) < groupEnd) {
        group.push(j);
      } else break;
    }
    if (group.length > 1) {
      const groupId = `parallel_${i}`;
      for (const idx of group) {
        agentNodes[idx].parallelGroup = groupId;
        agentNodes[idx].parallelSize = group.length;
      }
      i = group[group.length - 1]; // skip past the group
    }
  }

  // Clean up internal span timing fields
  for (const node of agentNodes) {
    delete node._spanStart;
    delete node._spanEnd;
  }

  // Inject tool_results from next request body's messages
  for (let i = 0; i < agentNodes.length; i++) {
    const node = agentNodes[i];
    if (node.kind !== 'LLM_CALL' || !node.blocks?.length) continue;

    const toolUseIds = new Set(
      node.blocks.filter((b) => b.type === 'TOOL_USE').map((b) => b.id),
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

  // Promote Agent-tool invocations to canonical AGENT-kind AgentNodes.
  //
  // Detection: a TOOL node whose `toolName === 'Agent'` and which has a
  // claude_code.tool.execution child span defines a sub-agent window. All
  // subsequent agentNodes whose _eventTime falls inside that window were
  // emitted by the sub-agent and belong nested under it.
  //
  // The promotion is recursive: after pulling sub-agent nodes into the new
  // AGENT node's `nodes` array, we re-run the same pass on that array so
  // Task-within-Task (sub-sub-agents) classify the same way at any depth.
  // This matches the "same recognition logic at every depth" contract from
  // the canonical schema (see CLAUDE.md AgentNode AGENT kind).
  (function promoteSubAgents(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.kind !== 'TOOL' || node.toolName !== 'Agent') continue;
      if (!node._toolSpanId) continue;

      const children = childSpansByParent[node._toolSpanId] || [];
      const execSpan = children.find(s => s.name === 'claude_code.tool.execution');
      if (!execSpan) continue;

      const execStart = BigInt(execSpan.startTimeUnixNano);
      const execEnd = BigInt(execSpan.endTimeUnixNano);

      const subIndices = [];
      for (let j = i + 1; j < nodes.length; j++) {
        const candidate = nodes[j];
        if (!candidate._eventTime) continue;
        if (candidate._eventTime >= execStart && candidate._eventTime <= execEnd) {
          subIndices.push(j);
        }
      }

      if (subIndices.length === 0) continue;

      const subNodes = subIndices.map(j => nodes[j]);
      for (const j of subIndices.reverse()) nodes.splice(j, 1);

      // Recurse so a Task call inside this sub-agent is itself promoted.
      promoteSubAgents(subNodes);

      // Pull subagent_type from the tool's parameters (set during tool event
      // construction earlier). Falls back to the generic 'Agent' label.
      let agentType = 'subagent';
      let agentName = 'Agent';
      try {
        const parsed = node.toolInput ? JSON.parse(node.toolInput) : {};
        if (parsed.subagent_type) {
          agentName = parsed.subagent_type;
          agentType = 'subagent';
        }
      } catch {}

      const startTimeIso = nanoToDate(execSpan.startTimeUnixNano).toISOString();
      const endTimeIso = nanoToDate(execSpan.endTimeUnixNano).toISOString();
      const subDurationMs = Number((execEnd - execStart) / 1000000n);

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
        durationMs: subDurationMs,
        startTime: startTimeIso,
        endTime: endTimeIso,
        _eventTime: node._eventTime,
      };
    }
  })(agentNodes);

  // Clean up internal temp fields (recurses into nested AGENT.nodes)
  (function cleanTempFields(nodes) {
    for (const node of nodes) {
      delete node._eventTime;
      delete node._toolSpanId;
      if (node.kind === 'AGENT' && Array.isArray(node.nodes)) cleanTempFields(node.nodes);
    }
  })(agentNodes);

  // Build capturedBlocks by flattening LLM_CALL blocks (when response bodies are available)
  const allBlocks = agentNodes.filter(n => n.kind === 'LLM_CALL').flatMap(n => n.blocks || []);
  let capturedBlocks = allBlocks.length > 0 ? allBlocks : null;

  // Mark the last TEXT block as AGENT_RESPONSE (matches anthropic adapter behavior)
  if (capturedBlocks) {
    for (let i = capturedBlocks.length - 1; i >= 0; i--) {
      if (capturedBlocks[i].type === 'TEXT') {
        capturedBlocks[i] = { ...capturedBlocks[i], type: 'AGENT_RESPONSE' };
        break;
      }
      if (capturedBlocks[i].type === 'TOOL_USE' || capturedBlocks[i].type === 'TOOL_RESULT') break;
    }
  }

  // Compute outputText from the last TEXT/AGENT_RESPONSE block
  let outputText = '';
  if (capturedBlocks) {
    for (let i = capturedBlocks.length - 1; i >= 0; i--) {
      if (capturedBlocks[i].type === 'AGENT_RESPONSE' || capturedBlocks[i].type === 'TEXT') {
        outputText = capturedBlocks[i].text || '';
        break;
      }
    }
  }

  // AGENT step
  steps.push({ type: 'AGENT', nodes: agentNodes, capturedBlocks, upstreamPre: [], upstreamPost: [], userPrompt });

  // FINAL step
  steps.push({
    type: 'FINAL',
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    durationMs,
  });

  // Aggregate model/tokens from LLM_CALL nodes for the workflow graph
  const llmNodes = agentNodes.filter(n => n.kind === 'LLM_CALL');
  const aggregatedModel = llmNodes[0]?.model || '';
  const aggregatedInputTokens = llmNodes.reduce((sum, n) => sum + n.inputTokens, 0);
  const aggregatedOutputTokens = llmNodes.reduce((sum, n) => sum + n.outputTokens, 0);

  // Workflow graph: single AGENT node (no pipeline spans in CLI data)
  const agentStepData = { type: 'AGENT', nodes: agentNodes, capturedBlocks, userPrompt };
  const workflowGraph = {
    hasPipeline: false,
    groups: [{
      groupIdx: 0,
      nodes: [{
        nodeId: group.promptId,
        kind: 'AGENT',
        label: 'agent',
        spanName: 'claude_code.cli',
        model: aggregatedModel,
        durationMs,
        inputTokens: aggregatedInputTokens,
        outputTokens: aggregatedOutputTokens,
        maxTokens: 0,
        inputText: userPrompt,
        outputText,
        systemText: systemPrompt || '',
        agentStepData,
      }],
    }],
  };

  return {
    turn: {
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
    },
    _nextLlmSpanIdx: llmSpanIdx,
  };
}
