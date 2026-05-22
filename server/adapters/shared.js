import { getAttr } from '../loader.js';

export function nanoToMs(nano) {
  return Number(BigInt(nano) / 1000000n);
}

export function nanoToDate(nano) {
  return new Date(Number(BigInt(nano) / 1000000n));
}

export function sortByStart(a, b) {
  const aN = BigInt(a.startTimeUnixNano);
  const bN = BigInt(b.startTimeUnixNano);
  return aN < bN ? -1 : aN > bN ? 1 : 0;
}

export function buildWorkflowNode(span, kind, agentStepData) {
  const a = span.attributes || [];
  const model = getAttr(a, 'gen_ai.request.model') || getAttr(a, 'gen_ai.response.model') || '';
  const inputTokens = Number(getAttr(a, 'gen_ai.usage.input_tokens') || 0);
  const outputTokens = Number(getAttr(a, 'gen_ai.usage.output_tokens') || 0);
  const maxTokens = Number(getAttr(a, 'gen_ai.request.max_tokens') || 0);
  const durationMs = nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano);

  // Extract text from a message's content/parts array (handles both formats)
  function extractMsgText(msg) {
    const items = msg.parts || msg.content || (msg.message && msg.message.content) || [];
    if (typeof items === 'string') return items;
    if (!Array.isArray(items)) return '';
    return items
      .filter((c) => c.type === 'text')
      .map((c) => c.text || c.content || '')
      .join('');
  }

  // Parse output text from gen_ai.output.messages
  let outputText = '';
  const outputMsgsStr = getAttr(a, 'gen_ai.output.messages');
  if (outputMsgsStr) {
    try {
      const msgs = JSON.parse(outputMsgsStr);
      const msgArr = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of msgArr) outputText += extractMsgText(msg);
    } catch {}
  }

  // Parse input text from gen_ai.input.messages
  let inputText = '';
  const inputMsgsStr = getAttr(a, 'gen_ai.input.messages');
  if (inputMsgsStr) {
    try {
      const msgs = JSON.parse(inputMsgsStr);
      const msgArr = Array.isArray(msgs) ? msgs : [msgs];
      const parts = [];
      for (const msg of msgArr) {
        const text = extractMsgText(msg);
        const role = msg.role || '';
        if (text) parts.push(`[${role.toUpperCase()}]\n${text}`);
      }
      inputText = parts.join('\n\n');
    } catch {}
  }

  // Parse system instructions (may be a JSON array of content blocks)
  const sysRaw = getAttr(a, 'gen_ai.system_instructions') || '';
  let systemText = '';
  try {
    const items = JSON.parse(sysRaw);
    systemText = (Array.isArray(items) ? items : [items])
      .filter((c) => c.type === 'text')
      .map((c) => c.text || c.content || '')
      .join('\n');
  } catch {
    systemText = sysRaw;
  }

  // Determine label
  let label;
  if (kind === 'AGENT') {
    label = 'agent';
  } else if (maxTokens > 0 && maxTokens <= 20) {
    label = 'guardrail';
  } else if (maxTokens > 1000) {
    label = 'tov-rewriter';
  } else {
    label = 'llm-call';
  }

  return {
    nodeId: span.spanId,
    kind,
    label,
    spanName: span.name,
    model,
    durationMs,
    inputTokens,
    outputTokens,
    maxTokens,
    inputText,
    outputText,
    systemText,
    agentStepData: kind === 'AGENT' ? agentStepData : null,
  };
}

// ── Infer tool schemas from observed inputs ──────────────────────────────────
//
// When tool schemas aren't available in the telemetry (no request bodies for
// Anthropic, or LangChain which never emits them), we infer basic schemas
// from the actual tool_use inputs observed across the session.

function inferType(value) {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object' && value !== null) return 'object';
  return 'string';
}

function buildSchemaFromInputs(inputs) {
  const properties = {};
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    for (const [key, value] of Object.entries(input)) {
      if (!properties[key]) {
        properties[key] = { type: inferType(value) };
      }
    }
  }
  return { type: 'object', properties };
}

export function inferToolSchemas(session) {
  const toolsToInfer = session.availableTools.filter((t) => !t.inputSchema);
  if (toolsToInfer.length === 0) return;

  const inputsByTool = {};

  for (const turn of session.turns) {
    const agentStep = turn.steps?.find((s) => s.type === 'AGENT');
    if (!agentStep) continue;

    // From captured blocks (TOOL_USE entries have parsed input objects)
    for (const block of agentStep.capturedBlocks || []) {
      if (block.type !== 'TOOL_USE' || !block.input) continue;
      if (!inputsByTool[block.name]) inputsByTool[block.name] = [];
      inputsByTool[block.name].push(block.input);
    }

    // From agent nodes (TOOL kind — toolInput is a JSON string)
    for (const node of agentStep.nodes || []) {
      if (node.kind !== 'TOOL' || !node.toolInput) continue;
      if (!inputsByTool[node.toolName]) inputsByTool[node.toolName] = [];
      try {
        const parsed = typeof node.toolInput === 'string'
          ? JSON.parse(node.toolInput) : node.toolInput;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          inputsByTool[node.toolName].push(parsed);
        }
      } catch {}
    }
  }

  for (const tool of toolsToInfer) {
    const inputs = inputsByTool[tool.name];
    if (inputs?.length > 0) {
      tool.inputSchema = buildSchemaFromInputs(inputs);
    }
  }
}
