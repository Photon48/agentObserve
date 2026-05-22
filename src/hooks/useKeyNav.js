import { useEffect, useCallback } from 'react';

export function useKeyNav({
  groups, groupIdx, nodeIdx, setGraphState,
  onTurnChange,
  detailMode, onEnterDetail, onExitDetail, onExitSession,
}) {
  const handleKey = useCallback(
    (e) => {
      if (e.key === 'ArrowUp' && !e.shiftKey) {
        e.preventDefault();
        if (groupIdx > 0) {
          const newGroupIdx = groupIdx - 1;
          const maxNodeIdx = Math.max(0, (groups[newGroupIdx]?.nodes.length ?? 1) - 1);
          setGraphState({ groupIdx: newGroupIdx, nodeIdx: Math.min(nodeIdx, maxNodeIdx) });
        }
      } else if (e.key === 'ArrowDown' && !e.shiftKey) {
        e.preventDefault();
        if (groupIdx < groups.length - 1) {
          const newGroupIdx = groupIdx + 1;
          const maxNodeIdx = Math.max(0, (groups[newGroupIdx]?.nodes.length ?? 1) - 1);
          setGraphState({ groupIdx: newGroupIdx, nodeIdx: Math.min(nodeIdx, maxNodeIdx) });
        }
      } else if (e.key === 'ArrowLeft' && !e.shiftKey) {
        e.preventDefault();
        if (nodeIdx > 0) setGraphState({ groupIdx, nodeIdx: nodeIdx - 1 });
      } else if (e.key === 'ArrowRight' && !e.shiftKey) {
        e.preventDefault();
        const maxNodeIdx = Math.max(0, (groups[groupIdx]?.nodes.length ?? 1) - 1);
        if (nodeIdx < maxNodeIdx) setGraphState({ groupIdx, nodeIdx: nodeIdx + 1 });
      } else if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault();
        onTurnChange(-1);
      } else if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        onTurnChange(1);
      } else if (e.key === 'Enter') {
        if (!detailMode) {
          e.preventDefault();
          onEnterDetail();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (detailMode) {
          onExitDetail();
        } else {
          onExitSession();
        }
      }
    },
    [groups, groupIdx, nodeIdx, setGraphState, onTurnChange,
     detailMode, onEnterDetail, onExitDetail, onExitSession],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);
}
