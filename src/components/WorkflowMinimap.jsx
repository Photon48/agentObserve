import { useMemo, useState, useEffect } from 'react';
import { buildAgentTree, findFocusedSlabId, collectAncestorIds } from '../utils/agentHierarchy.js';
import { WorkflowFrame } from './WorkflowFrame.jsx';

// Nested-treemap minimap. Slabs are agents; sub-agents are literally nested
// inside their parent. Workflow level is the outermost frame.
//
// Click on a workflow item (path.length === 2) → updates graphState via
// onNodeSelect. Click on a deeper slab → local highlight only (no auto-zoom).
// Focus glow follows (detailMode, subAgentStack); deep-click outline is
// distinct (amber dashed) so the two states never get confused.
export function WorkflowMinimap({
  turn,
  groupIdx,
  nodeIdx,
  detailMode,
  subAgentStack,
  onNodeSelect,
}) {
  const { workflowItems } = useMemo(() => buildAgentTree(turn), [turn]);

  const focusedSlabId = useMemo(() => {
    if (!detailMode) return null;
    return findFocusedSlabId(workflowItems, groupIdx, nodeIdx, subAgentStack || []);
  }, [workflowItems, groupIdx, nodeIdx, subAgentStack, detailMode]);

  const ancestorIds = useMemo(
    () => collectAncestorIds(workflowItems, focusedSlabId),
    [workflowItems, focusedSlabId],
  );

  const workflowSelectedId = `${groupIdx}.${nodeIdx}`;

  const [deepSelectedId, setDeepSelectedId] = useState(null);
  useEffect(() => {
    setDeepSelectedId(null);
  }, [groupIdx, nodeIdx, subAgentStack?.length]);

  if (!workflowItems.length) return null;

  function onClickItem(item) {
    if (item.path.length === 2) {
      onNodeSelect?.(item.path[0], item.path[1]);
      setDeepSelectedId(null);
    } else {
      setDeepSelectedId(item.id);
    }
  }

  const hasFocus = !!focusedSlabId;
  const depthLabel = hasFocus
    ? `L${(subAgentStack || []).length + 1}`
    : 'WORKFLOW';

  return (
    <div className="wf-minimap wf-minimap--treemap">
      <div className="wf-minimap__header">
        <span>MINIMAP</span>
        <span className="wf-minimap__header-depth">{depthLabel}</span>
      </div>
      <WorkflowFrame
        workflowItems={workflowItems}
        focusedSlabId={focusedSlabId}
        ancestorIds={ancestorIds}
        deepSelectedId={deepSelectedId}
        workflowSelectedId={workflowSelectedId}
        hasFocus={hasFocus}
        onClickItem={onClickItem}
      />
    </div>
  );
}
