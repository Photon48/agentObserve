// Recursive nested agent slab.
//
// Renders a labeled box containing columns of child slabs. A column = a
// parallel cluster of siblings (overlapping in time); siblings inside a
// column stack vertically. Sequential columns flow left-to-right.
//
// Leaf agents (no AGENT children) render as a solid filled tile.
//
// Class set is driven by focus state passed in by the orchestrator:
//   - is-focused          → current zoom target
//   - is-ancestor         → a parent in the focus chain (dimmed slightly)
//   - is-deep-selected    → user clicked it on the minimap (local highlight)
//   - is-workflow-selected → matches graphState's [g, n]
//   - is-dim              → unrelated branch; faded
//
// `descendantOfFocus` propagates down once a focused parent renders so the
// focused slab's children stay at full opacity (you should still see inside
// the agent you're looking at).

function depthAttr(depth) {
  return Math.min(depth, 3);
}

export function AgentSlab({
  slab,
  depth,
  focusedSlabId,
  ancestorIds,
  descendantOfFocus,
  deepSelectedId,
  workflowSelectedId,
  hasFocus,
  onClick,
}) {
  const isFocused = !!focusedSlabId && slab.id === focusedSlabId;
  const isAncestor = !isFocused && ancestorIds?.has(slab.id);
  const isWorkflowSelected = workflowSelectedId === slab.id;
  const isDeepSelected = deepSelectedId === slab.id;
  const isDim = hasFocus && !isFocused && !isAncestor && !descendantOfFocus && !isWorkflowSelected;

  const cls =
    'agent-slab' +
    (slab.isLeaf ? ' agent-slab--leaf' : '') +
    (isFocused ? ' agent-slab--focused' : '') +
    (isAncestor ? ' agent-slab--ancestor' : '') +
    (isWorkflowSelected ? ' agent-slab--workflow-selected' : '') +
    (isDeepSelected ? ' agent-slab--deep-selected' : '') +
    (isDim ? ' agent-slab--dim' : '');

  const title = `${slab.label}${slab.durationMs ? ` · ${slab.durationMs}ms` : ''}`;
  const childDescendantOfFocus = descendantOfFocus || isFocused;

  return (
    <div
      className={cls}
      data-depth={depthAttr(depth)}
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick?.(slab); }}
    >
      <div className="agent-slab__header">{slab.label}</div>
      {!slab.isLeaf && (
        <div className="agent-slab__body">
          {slab.columns.map((col, cIdx) => (
            <div key={cIdx} className="agent-slab__col">
              {col.map((child) => (
                <AgentSlab
                  key={child.id}
                  slab={child}
                  depth={depth + 1}
                  focusedSlabId={focusedSlabId}
                  ancestorIds={ancestorIds}
                  descendantOfFocus={childDescendantOfFocus}
                  deepSelectedId={deepSelectedId}
                  workflowSelectedId={workflowSelectedId}
                  hasFocus={hasFocus}
                  onClick={onClick}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
