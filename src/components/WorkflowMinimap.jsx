// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
export function WorkflowMinimap({ graph, groupIdx, nodeIdx, onNodeSelect }) {
  if (!graph?.groups?.length) return null;

  return (
    <div className="wf-minimap">
      <div className="wf-minimap__header">MINIMAP</div>
      <div className="wf-minimap__body">
        {graph.groups.map((group) => (
          <div key={group.groupIdx} className="wf-minimap__row">
            {group.nodes.map((node, nIdx) => {
              const kindClass = 'wf-minimap__node--' + node.kind.toLowerCase();
              const isSelected = group.groupIdx === groupIdx && nIdx === nodeIdx;
              return (
                <div
                  key={nIdx}
                  className={
                    'wf-minimap__node ' + kindClass +
                    (isSelected ? ' wf-minimap__node--selected' : '')
                  }
                  title={`${node.kind}: ${node.label}`}
                  onClick={() => onNodeSelect(group.groupIdx, nIdx)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
