// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { getAttr } from '../loader.js';

export function nanoToMs(nano) {
  return Number(BigInt(nano) / 1000000n);
}

// Normalize a single Anthropic-format content block into a canonical Block.
// Returns null when the item type isn't one we surface (e.g. tool_result lives
// in a separate pairing pass). Anthropic's redacted extended-thinking arrives
// as type==='redacted_thinking' with a `data` field, OR as type==='thinking'
// with the literal string "<REDACTED>" in the `thinking` field plus a
// `signature` blob — both forms collapse to the same redacted THOUGHT shape so
// the FE renders one consistent badge.
export function normalizeAnthropicContentBlock(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'thinking') {
    const raw = typeof item.thinking === 'string' ? item.thinking : '';
    const isRedacted = raw.trim() === '<REDACTED>';
    if (isRedacted) {
      return { type: 'THOUGHT', text: '', redacted: true, signature: item.signature || '' };
    }
    return { type: 'THOUGHT', text: raw, redacted: false };
  }
  if (item.type === 'redacted_thinking') {
    return { type: 'THOUGHT', text: '', redacted: true, signature: item.data || '' };
  }
  if (item.type === 'text') {
    return { type: 'TEXT', text: item.text || '' };
  }
  if (item.type === 'tool_use') {
    return { type: 'TOOL_USE', id: item.id || '', name: item.name || '', input: item.input || {} };
  }
  return null;
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

// ── Content extraction ──────────────────────────────────────────────────────
//
// Handles both plain strings AND the Anthropic-style content-block array
// ([{type:'text', text:'...'}, …]) — a cross-vendor convention used by
// Anthropic SDK, MCP, OpenAI structured content, and many tool integrations.
// Framework-agnostic; adapters call this whenever they pull text from
// `gen_ai.completion` / `gen_ai.prompt` / tool outputs.

export function extractTextContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text || '')
      .join('');
  }
  return '';
}

// ── Span traversal ──────────────────────────────────────────────────────────

export function getDescendants(spanId, childrenOf) {
  const result = [];
  for (const child of childrenOf[spanId] || []) {
    result.push(child);
    result.push(...getDescendants(child.spanId, childrenOf));
  }
  return result;
}

// ── Framework-agnostic workflow-node classification ─────────────────────────
//
// AGENT iff any of:
//   1. The subtree contains an explicit agent-boundary span (strong signal —
//      adapter decides what that looks like via `isAgentSpan`).
//   2. ≥2 LLM descendants (iterative reasoning).
//   3. Any tool invocation (LLM dispatching to tools).
//
// Rules 2-3 are structural fallbacks that catch agentic behavior without an
// explicit marker. Rule 1 catches the case where an agent ran one-shot
// (single LLM, no tools) — common when the agent answers without iterating.
//
// Pattern: predicate injection. This function knows the algorithm; the
// adapter knows its framework's attributes. DO NOT add framework-specific
// branches (e.g. `if (kind === 'langsmith') …`) here — that breaks at N
// frameworks. New adapters define their own predicates and call in.
//
// Example for a new adapter (e.g. server/adapters/openai.js):
//
//   import { detectWorkflowNodeKind } from './shared.js';
//   import { getAttr } from '../loader.js';
//
//   const isLLM  = (s) => getAttr(s.attributes, 'gen_ai.operation.name') === 'chat';
//   const isTool = (s) => getAttr(s.attributes, 'gen_ai.operation.name') === 'execute_tool';
//   const isAgentSpan = (s) => getAttr(s.attributes, 'gen_ai.operation.name') === 'invoke_agent';
//   const kind = detectWorkflowNodeKind(child.spanId, childrenOf, isLLM, isTool, isAgentSpan);
//
// `isAgentSpan` is optional — defaults to never-match. See
// server/adapters/langchain.js for the working reference (it uses the
// LangSmith-specific `langsmith.metadata.langgraph_node` marker).

export function detectWorkflowNodeKind(
  spanId,
  childrenOf,
  isLLM,
  isTool,
  isAgentSpan = () => false,
) {
  let llmCount = 0;
  let hasTool = false;
  for (const d of getDescendants(spanId, childrenOf)) {
    if (isAgentSpan(d)) return 'AGENT'; // strong signal — short-circuit
    if (isLLM(d)) llmCount++;
    if (isTool(d)) { hasTool = true; }
  }
  return (llmCount >= 2 || hasTool) ? 'AGENT' : 'PIPELINE_MEMBER';
}

// ── AgentNode-internal classification (recursive depth) ─────────────────────
//
// Same algorithm and predicate-injection pattern as detectWorkflowNodeKind,
// but in the AgentNode vocabulary. Returns 'AGENT' when the subtree under
// `spanId` looks like a sub-agent invocation, or `null` to mean "no agent
// structure here — keep the leaf's existing classification (LLM_CALL / TOOL /
// HOOK)". Adapters call this only to *promote* a span to AGENT-kind; they
// never call it to decide a leaf's primary kind.
//
// Why a separate function from detectWorkflowNodeKind: the return vocabulary
// differs (no PIPELINE_MEMBER at the AgentStep level), and the call site is
// inside an already-classified AGENT subtree where the default isn't
// "pipeline" but "leaf". Sharing the predicate trio (isLLM/isTool/isAgentSpan)
// keeps the framework-agnostic posture — see the comment block above
// detectWorkflowNodeKind for the predicate pattern.

export function classifyAgentNodeKind(
  spanId,
  childrenOf,
  isLLM,
  isTool,
  isAgentSpan = () => false,
) {
  let llmCount = 0;
  let hasTool = false;
  for (const d of getDescendants(spanId, childrenOf)) {
    if (isAgentSpan(d)) return 'AGENT';
    if (isLLM(d)) llmCount++;
    if (isTool(d)) { hasTool = true; }
  }
  return (llmCount >= 2 || hasTool) ? 'AGENT' : null;
}

// ── Tool-call summary (called vs. available) ────────────────────────────────
//
// Counts TOOL-kind invocations among the DIRECT children of the supplied
// AgentNode[]. Does NOT recurse into AGENT-kind children — sub-agents own
// their own scope, and their tool calls surface only when the operator
// zooms into that sub-agent. Used to derive the "CALLED" vs "UNUSED"
// partition in the tools sidebar, scoped to the currently-selected agent
// level (L1 sees only L1 calls; entering L2 reveals L2's direct calls; etc).
//
// Pure and framework-agnostic — operates on the canonical AgentNode shape.

export function collectToolCallsFromAgentNodes(nodes) {
  const counts = {};
  for (const n of nodes || []) {
    if (n?.kind === 'TOOL' && n.toolName) {
      counts[n.toolName] = (counts[n.toolName] || 0) + 1;
    }
  }
  return counts;
}

// ── Parallel tool-call stamping (framework-agnostic) ────────────────────────
//
// The Anthropic API treats N tool_use blocks in ONE assistant response as a
// parallel batch — this is the model's first-class parallel-tool-calling
// mechanism. All three frameworks we support wrap that same content-block
// API, so the bulletproof signal is identical across frameworks:
//
//   one LLM response carrying >=2 tool_use blocks (and the matching ids)
//
// Each adapter extracts that list from its OWN raw OTEL data path:
//   - Claude Code CLI:  responseBodies[reqId].content
//   - Anthropic SDK:    responseBodies[reqId].content  (or capturedTurn blocks)
//   - LangChain:        gen_ai.completion → JSON.parse → kwargs.tool_calls
//
// Once the adapter has the list of tool_use ids for a batch, it calls
// `stampParallelGroup` to write the canonical fields. This file is the
// single source of truth for the four field shapes:
//
//   parallelGroup        — stable id shared by every member of the batch
//   parallelSize         — group cardinality (>=2)
//   parallelIndex        — 0..N-1 position within the group
//   parallelSiblingNames — display names of every member, in group order
//
// No timing knowledge. No OTEL knowledge. Pure stamp.

export function parallelGroupIdFor(toolUseIds) {
  return 'pg_' + (toolUseIds[0] || 'unknown');
}

function _displayName(node) {
  if (node.kind === 'TOOL') return node.toolName || 'tool';
  if (node.kind === 'AGENT') return node.agentName || 'subagent';
  return node.kind || '';
}

// Locate TOOL/AGENT agentNodes by their `toolUseId` (model-native id). If
// >=2 match, stamp the parallel fields. Returns the number of members
// stamped (so the caller can detect whether a batch landed or not).
export function stampParallelGroup(nodes, toolUseIds) {
  if (!Array.isArray(nodes) || !Array.isArray(toolUseIds)) return 0;
  if (toolUseIds.length < 2) return 0;

  const idSet = new Set(toolUseIds);
  const members = [];
  for (const n of nodes) {
    if (!n) continue;
    if ((n.kind === 'TOOL' || n.kind === 'AGENT') && n.toolUseId && idSet.has(n.toolUseId)) {
      members.push(n);
    }
  }
  if (members.length < 2) return 0;

  // Preserve the order in toolUseIds (the order the model emitted) — that's
  // the order the carousel walks. agentNodes might be in a different order
  // for late-arriving sub-agent promotion.
  members.sort((a, b) => toolUseIds.indexOf(a.toolUseId) - toolUseIds.indexOf(b.toolUseId));

  const gid = parallelGroupIdFor(toolUseIds);
  const siblingNames = members.map(_displayName);
  members.forEach((m, idx) => {
    m.parallelGroup = gid;
    m.parallelSize = members.length;
    m.parallelIndex = idx;
    m.parallelSiblingNames = siblingNames;
  });
  return members.length;
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

function inferProperty(value) {
  const t = inferType(value);
  if (t === 'object') {
    return { type: 'object', properties: inferObjectProperties([value]) };
  }
  if (t === 'array' && Array.isArray(value) && value.length > 0) {
    const objectItems = value.filter(
      (x) => x && typeof x === 'object' && !Array.isArray(x),
    );
    if (objectItems.length > 0) {
      return {
        type: 'array',
        items: { type: 'object', properties: inferObjectProperties(objectItems) },
      };
    }
    return { type: 'array', items: { type: inferType(value[0]) } };
  }
  return { type: t };
}

function inferObjectProperties(objects) {
  const properties = {};
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (!properties[key]) properties[key] = inferProperty(value);
    }
  }
  return properties;
}

function buildSchemaFromInputs(inputs) {
  return { type: 'object', properties: inferObjectProperties(inputs) };
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
