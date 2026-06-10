// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useRef, useState } from 'react';

// Long-form preview with click-to-toggle. The whole body is the toggle
// target so a user reading a 500-line dump doesn't have to scroll back to
// the bottom button to close it — clicking anywhere visible collapses it.
//
// Guards:
//  - text selection: clicking after selecting text shouldn't collapse the
//    block out from under the user. `getSelection().toString()` check.
//  - event bubbling: outer containers (e.g. SubAgentPair) listen for click
//    to trigger zoom. We stopPropagation so toggle wins over zoom.
//
// onToggle(expanded: boolean) lets containers (carousel) react to height
// changes if they care.

// The body renders with `white-space: pre-wrap`, so a single newline-free
// line (minified JSON, big tool dumps) can occupy hundreds of visual rows.
// Collapse decisions therefore count estimated *wrapped* rows, not newlines.
// CHARS_PER_ROW approximates mono chars per row at typical panel width —
// being off by ±20% only shifts where the fold lands.
const CHARS_PER_ROW = 90;

function rowsForLine(line) {
  return Math.max(1, Math.ceil(line.length / CHARS_PER_ROW));
}

// → { rows, wrapped } — total estimated visual rows, and whether any line
// wrapped (i.e. the count is an estimate rather than exact).
export function countVisualRows(text) {
  let rows = 0;
  let wrapped = false;
  for (const line of (text || '').split('\n')) {
    const r = rowsForLine(line);
    if (r > 1) wrapped = true;
    rows += r;
  }
  return { rows, wrapped };
}

// First `maxRows` estimated visual rows of `text`. A line that overflows the
// remaining budget is hard-sliced at the char boundary with an ellipsis.
export function sliceVisualRows(text, maxRows) {
  const out = [];
  let budget = maxRows;
  for (const line of (text || '').split('\n')) {
    const r = rowsForLine(line);
    if (r > budget) {
      out.push(line.slice(0, budget * CHARS_PER_ROW) + '…');
      break;
    }
    out.push(line);
    budget -= r;
    if (budget === 0) break;
  }
  return out.join('\n');
}

export function CollapsibleText({
  text,
  previewLines = 6,
  emptyLabel = '(empty)',
  onToggle,
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef(null);
  const { rows: totalRows, wrapped } = countVisualRows(text);
  const needsCollapse = totalRows > previewLines;
  const hiddenCount = totalRows - previewLines;
  const displayed = (!needsCollapse || expanded)
    ? (text || '')
    : sliceVisualRows(text, previewLines);

  if (!needsCollapse) {
    return (
      <div className="conv-block__body">
        {displayed || <span className="text-empty">{emptyLabel}</span>}
      </div>
    );
  }

  const toggle = (e) => {
    if (typeof window !== 'undefined') {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
    }
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    const next = !expanded;
    setExpanded(next);
    if (onToggle) onToggle(next);
    // When collapsing a long block, the user may have scrolled deep into
    // it; after the shrink, their viewport would land somewhere far past
    // the block. Pull the block back into view (no-op when already in
    // view, thanks to `block: 'nearest'`).
    if (!next) {
      const prefersReduced = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      requestAnimationFrame(() => {
        bodyRef.current?.scrollIntoView({
          block: 'nearest',
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
      });
    }
  };

  const linesLabel = hiddenCount === 1 ? 'line' : 'lines';
  const collapsedLabel = `▸ show ${wrapped ? '~' : ''}${hiddenCount} more ${linesLabel}`;
  const expandedLabel = '▾ collapse';

  return (
    <div
      ref={bodyRef}
      className={
        'conv-block__body conv-block__body--collapsible '
        + (expanded ? 'is-expanded' : 'is-collapsed')
      }
      onClick={toggle}
      title={expanded ? 'click to collapse' : 'click to expand'}
    >
      {expanded && (
        <div className="conv-block__sticky-rail">
          <button
            type="button"
            className="conv-block__collapse-chip"
            aria-expanded="true"
            onClick={toggle}
            title="click to collapse"
          >
            {expandedLabel}
          </button>
        </div>
      )}
      {displayed}
      {!expanded && (
        <div className="conv-block__fade">
          <button
            type="button"
            className="conv-block__fade-chip"
            aria-expanded="false"
            onClick={toggle}
            title="click to expand"
          >
            {collapsedLabel}
          </button>
        </div>
      )}
    </div>
  );
}
