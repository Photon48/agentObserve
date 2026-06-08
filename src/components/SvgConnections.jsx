// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
const KIND_COLORS = {
  UPSTREAM_LLM: 'var(--fg-cyan)',
  AGENT: 'var(--fg-green)',
  DOWNSTREAM_LLM: 'var(--fg-cyan)',
  PIPELINE_MEMBER: 'color-mix(in oklab, var(--fg-cyan) 55%, transparent)',
};

export function SvgConnections({ groups, positions, selectedGroupIdx, selectedNodeIdx, hoveredGroupIdx, hoveredNodeIdx }) {
  if (!groups || groups.length < 2 || positions.size === 0) return null;

  const dimLines = [];
  const hoverLines = [];
  const activeLines = [];

  const selectedKey = `g${selectedGroupIdx}-n${selectedNodeIdx}`;
  const hoveredKey = hoveredGroupIdx != null ? `g${hoveredGroupIdx}-n${hoveredNodeIdx}` : null;

  const selectedNode = groups[selectedGroupIdx]?.nodes[selectedNodeIdx];
  const hoveredNode = hoveredGroupIdx != null ? groups[hoveredGroupIdx]?.nodes[hoveredNodeIdx] : null;
  const activeColor = selectedNode ? (KIND_COLORS[selectedNode.kind] || 'var(--fg-dim)') : 'var(--fg-dim)';
  const hoverColor = hoveredNode ? (KIND_COLORS[hoveredNode.kind] || 'var(--fg-dim)') : 'var(--fg-dim)';

  for (let gIdx = 0; gIdx < groups.length - 1; gIdx++) {
    const curGroup = groups[gIdx];
    const nextGroup = groups[gIdx + 1];

    for (let nIdx = 0; nIdx < curGroup.nodes.length; nIdx++) {
      const fromKey = `g${gIdx}-n${nIdx}`;
      const fromPos = positions.get(fromKey);
      if (!fromPos) continue;

      for (let nIdx2 = 0; nIdx2 < nextGroup.nodes.length; nIdx2++) {
        const toKey = `g${gIdx + 1}-n${nIdx2}`;
        const toPos = positions.get(toKey);
        if (!toPos) continue;

        const isActive = fromKey === selectedKey || toKey === selectedKey;
        const isHovered = !isActive && hoveredKey && (fromKey === hoveredKey || toKey === hoveredKey);

        const line = {
          key: `${fromKey}-${toKey}`,
          x1: fromPos.bottomCenterX,
          y1: fromPos.bottomCenterY,
          x2: toPos.topCenterX,
          y2: toPos.topCenterY,
        };

        if (isActive) {
          activeLines.push(line);
        } else if (isHovered) {
          hoverLines.push(line);
        } else {
          dimLines.push(line);
        }
      }
    }
  }

  return (
    <svg className="workflow-svg-overlay">
      <defs>
        <marker id="wf-arrow-dim" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6" fill="var(--fg-dim)" />
        </marker>
        <marker id="wf-arrow-hover" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6" fill={hoverColor} />
        </marker>
        <marker id="wf-arrow-active" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6" fill={activeColor} />
        </marker>
      </defs>
      {dimLines.map((l) => (
        <line
          key={l.key}
          x1={l.x1} y1={l.y1}
          x2={l.x2} y2={l.y2}
          stroke="var(--fg-dim)"
          strokeWidth="1"
          opacity="0.3"
          markerEnd="url(#wf-arrow-dim)"
        />
      ))}
      {hoverLines.map((l) => (
        <line
          key={l.key}
          x1={l.x1} y1={l.y1}
          x2={l.x2} y2={l.y2}
          stroke={hoverColor}
          strokeWidth="1.5"
          opacity="0.6"
          markerEnd="url(#wf-arrow-hover)"
        />
      ))}
      {activeLines.map((l) => (
        <line
          key={l.key}
          x1={l.x1} y1={l.y1}
          x2={l.x2} y2={l.y2}
          stroke={activeColor}
          strokeWidth="2"
          opacity="0.8"
          markerEnd="url(#wf-arrow-active)"
        />
      ))}
    </svg>
  );
}
