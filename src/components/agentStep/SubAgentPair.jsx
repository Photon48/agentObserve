// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { formatDuration, formatTokens, formatPct } from '../../utils/format.js';

// Sub-agent (Task tool call) rendered with the same compact, fixed-height
// card geometry as ToolPair, so every unit in a cascade — and every frame in
// a parallel carousel — lines up at the same collapsed height. The whole card
// is the click target: it pushes the sub-agent onto the StackedDetail modal
// stack, where the full nested cascade is shown. No inline expand here — zoom
// owns the detail, which keeps the click semantics unambiguous.

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
  const durationMs = agentNode?.durationMs || 0;
  const summary = summarizeChildren(agentNode);

  return (
    <div className="tool-card tool-card--subagent" role="group" aria-label={`Sub-agent: ${agentName}`}>
      <button
        type="button"
        className="tool-card__summary"
        onClick={() => onZoom?.(agentNode)}
        aria-label={`Zoom into sub-agent ${agentName}`}
      >
        <div className="tool-card__head">
          <span className="tool-card__icon" aria-hidden="true">★</span>
          <span className="tool-card__name">{agentName}</span>
          <span className="tool-card__status tool-card__status--ok">✓</span>
          {durationMs > 0 && <span className="tool-card__dur">{formatDuration(durationMs)}</span>}
        </div>

        <div className="tool-card__meta">
          <span className="tool-card__subagent-summary">{summary}</span>
          <span className="tool-card__chevron tool-card__chevron--zoom" aria-hidden="true">zoom ▸</span>
        </div>

        {agentNode?.aggTotalInputTokens > 0 && (
          <div className="tool-card__meta">
            <span className="tool-card__tokens">
              IN {formatTokens(agentNode.aggTotalInputTokens)}
              <span className="tool-card__tokens-sep"> · </span>
              OUT {formatTokens(agentNode.aggOutputTokens)}
              {agentNode.aggCacheReadTokens > 0 && (
                <>
                  <span className="tool-card__tokens-sep"> · </span>
                  cache {formatPct(agentNode.cachePct)}
                </>
              )}
            </span>
          </div>
        )}
      </button>
    </div>
  );
}
