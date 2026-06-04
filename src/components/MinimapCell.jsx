export function MinimapCell({ item, isWorkflowSelected, isDim, onClick }) {
  const kindClass = 'wf-cell--' + (item.wfKind || 'unknown').toLowerCase();
  const cls =
    'wf-cell ' + kindClass +
    (isWorkflowSelected ? ' wf-cell--selected' : '') +
    (isDim ? ' wf-cell--dim' : '');
  const title = `${item.wfKind}: ${item.label}${item.durationMs ? ` · ${item.durationMs}ms` : ''}`;
  return (
    <div
      className={cls}
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick?.(item); }}
    />
  );
}
