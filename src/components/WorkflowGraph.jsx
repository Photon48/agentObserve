// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useState, useEffect } from 'react';
import { formatTokens, formatDuration } from '../utils/format.js';
import { useNodePositions } from '../hooks/useNodePositions.js';
import { SvgConnections } from './SvgConnections.jsx';

const KIND_ICONS = {
  UPSTREAM_LLM: '\u2191',
  AGENT: '\u2605',
  DOWNSTREAM_LLM: '\u2193',
  PIPELINE_MEMBER: '\u00B7',
};

function WorkflowNode({ node, selected, onClick, nodeRef, onMouseEnter, onMouseLeave }) {
  const kindKey = node.kind.toLowerCase();
  const selectedClass = selected ? 'workflow-node--selected' : '';
  const modelShort = node.model ? node.model.split('/').pop() : '';

  return (
    <div
      ref={nodeRef}
      className={`workflow-node workflow-node--${kindKey} ${selectedClass}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="workflow-node__header">
        <span className="workflow-node__icon">{KIND_ICONS[node.kind] || '\u00B7'}</span>
        <span>{node.label.toUpperCase()}</span>
        <span className="workflow-node__span-name">{node.spanName}</span>
      </div>
      <div className="workflow-node__meta">
        {modelShort && <span className="workflow-node__model">{modelShort}</span>}
        {node.durationMs > 0 && <span className="workflow-node__dur">{formatDuration(node.durationMs)}</span>}
        {node.inputTokens > 0 && <span className="workflow-node__tokens">in:{formatTokens(node.inputTokens)}</span>}
      </div>
    </div>
  );
}

export function WorkflowGraph({ graph, groupIdx, nodeIdx, onNodeClick }) {
  const { containerRef, positions, registerNodeRef, measure } = useNodePositions();
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    measure();
  }, [graph, measure]);

  if (!graph) {
    return <div className="workflow-graph text-dim">No workflow data.</div>;
  }

  return (
    <div className="workflow-graph" ref={containerRef}>
      <SvgConnections
        groups={graph.groups}
        positions={positions}
        selectedGroupIdx={groupIdx}
        selectedNodeIdx={nodeIdx}
        hoveredGroupIdx={hovered?.gIdx ?? null}
        hoveredNodeIdx={hovered?.nIdx ?? null}
      />
      {graph.groups.map((group, gIdx) => (
        <div key={gIdx} className="workflow-group">
          {group.nodes.map((node, nIdx) => (
            <WorkflowNode
              key={node.nodeId}
              node={node}
              selected={gIdx === groupIdx && nIdx === nodeIdx}
              onClick={() => onNodeClick(gIdx, nIdx)}
              nodeRef={registerNodeRef(gIdx, nIdx)}
              onMouseEnter={() => setHovered({ gIdx, nIdx })}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
