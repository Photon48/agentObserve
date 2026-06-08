// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { CollapsibleText } from './CollapsibleText.jsx';
import { StatusChip } from './StatusChip.jsx';
import { formatDuration } from '../../utils/format.js';

// Sub-agent (Task tool call) rendered as a unified bracket-rail pair just
// like a regular tool — input on top, status chip in the middle, output on
// the bottom. The output is the sub-agent's *final response* derived from
// its own block tree; the nested cascade is never inlined. Click the card
// to push the sub-agent onto the existing StackedDetail modal stack.

function formatToolInput(input) {
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2); } catch { return ''; }
}

// Walk the sub-agent's nodes in reverse to find the last assistant-side
// text. Order of preference: last AGENT_RESPONSE > last TEXT in the last
// LLM_CALL > last LLM_CALL.blocks join. Stops short of TOOL_USE/TOOL_RESULT.
function deriveFinalResponse(agentNode) {
  const nodes = Array.isArray(agentNode?.nodes) ? agentNode.nodes : [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind !== 'LLM_CALL') continue;
    const blocks = Array.isArray(n.blocks) ? n.blocks : [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === 'AGENT_RESPONSE' || b.type === 'TEXT') {
        return b.text || '';
      }
      if (b.type === 'TOOL_USE' || b.type === 'TOOL_RESULT') break;
    }
  }
  return '';
}

function summarizeChildren(agentNode) {
  const nodes = Array.isArray(agentNode?.nodes) ? agentNode.nodes : [];
  const llm = nodes.filter((n) => n.kind === 'LLM_CALL').length;
  const tool = nodes.filter((n) => n.kind === 'TOOL').length;
  const nested = nodes.filter((n) => n.kind === 'AGENT').length;
  const parts = [];
  parts.push(`${nodes.length} step${nodes.length === 1 ? '' : 's'}`);
  if (llm) parts.push(`${llm} llm`);
  if (tool) parts.push(`${tool} tool`);
  if (nested) parts.push(`${nested} sub-agent`);
  return parts.join(' · ');
}

export function SubAgentPair({ useBlock, agentNode, onZoom }) {
  const agentName = agentNode?.agentName || 'subagent';
  const inputText = formatToolInput(useBlock?.input);
  const outputText = deriveFinalResponse(agentNode);
  const durationMs = agentNode?.durationMs || 0;
  const summary = summarizeChildren(agentNode);

  return (
    <div
      className="tool-pair sub-agent-pair"
      role="group"
      aria-label={`Sub-agent: ${agentName}`}
      onClick={() => onZoom?.(agentNode)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onZoom?.(agentNode); }
      }}
      tabIndex={0}
    >
      <div className="tool-pair__rail" aria-hidden="true" />

      <div className="tool-pair__use conv-block conv-block--tool-use">
        <div className="conv-block__header">
          ★ SUB-AGENT  {agentName}
          <span className="sub-agent-pair__zoom-hint">zoom in ▸</span>
        </div>
        <CollapsibleText text={inputText} previewLines={6} emptyLabel="(no prompt captured)" />
      </div>

      <div className="tool-pair__bridge">
        <StatusChip success={true} durationMs={durationMs} />
        <span className="sub-agent-pair__summary">{summary}</span>
      </div>

      <div className="tool-pair__result conv-block conv-block--tool-result">
        <div className="conv-block__header">↩ RESULT  {agentName}</div>
        <CollapsibleText text={outputText} previewLines={6} emptyLabel="(no response captured)" />
      </div>
    </div>
  );
}
