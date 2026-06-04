import { AgentSlab } from './AgentSlab.jsx';
import { MinimapCell } from './MinimapCell.jsx';

// Outermost slab. Renders the workflow pipeline as a wrapping row of cells
// (LLMs, pipeline members) and agent slabs (which nest their own sub-agents).
export function WorkflowFrame({
  workflowItems,
  focusedSlabId,
  ancestorIds,
  deepSelectedId,
  workflowSelectedId,
  hasFocus,
  onClickItem,
}) {
  return (
    <div className={'wf-frame' + (hasFocus ? '' : ' wf-frame--root-focus')}>
      <div className="wf-frame__body">
        {workflowItems.map((item) => {
          if (item.kind === 'CELL') {
            const isSel = workflowSelectedId === item.id;
            return (
              <MinimapCell
                key={item.id}
                item={item}
                isWorkflowSelected={isSel}
                isDim={hasFocus && !isSel}
                onClick={onClickItem}
              />
            );
          }
          return (
            <AgentSlab
              key={item.id}
              slab={item}
              depth={0}
              focusedSlabId={focusedSlabId}
              ancestorIds={ancestorIds}
              descendantOfFocus={false}
              deepSelectedId={deepSelectedId}
              workflowSelectedId={workflowSelectedId}
              hasFocus={hasFocus}
              onClick={onClickItem}
            />
          );
        })}
      </div>
    </div>
  );
}
