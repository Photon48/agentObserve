// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ToolPair } from './ToolPair.jsx';
import { SubAgentPair } from './SubAgentPair.jsx';
import { ToolNavContext, NOOP_NAV, useToolNav } from './ToolNavContext.jsx';

// Single-frame carousel for N parallel tool calls. One pair visible at a
// time. Tabs name each sibling so engineers can jump directly to the call
// they want to inspect (the debug case). When N > MAX_TABS the tabs
// collapse into dots so the header doesn't overflow.
//
// Keyboard: ←/→ steps when the frame is focused; Home/End jump to ends.

const SWIPE_THRESHOLD = 40;
const MAX_TABS = 6;
const MAX_TAB_LABEL = 12;

export function ParallelCarousel({ members, siblings, onZoomIntoSubAgent }) {
  const safeMembers = Array.isArray(members) ? members : [];
  const N = safeMembers.length;
  const [idx, setIdx] = useState(0);
  const touchStartX = useRef(null);
  const rootRef = useRef(null);

  // Sidebar tool navigation: register one occurrence per tool-pair member
  // (sub-agents don't contribute to the sidebar's call counts). Only the
  // member at `idx` is mounted, so each entry carries a reveal() that
  // switches the frame before the scroll happens. goRef keeps the mount-time
  // closures pointing at the latest clamp/setIdx.
  const toolNav = useToolNav();
  const goRef = useRef(() => {});
  useEffect(() => {
    const unregisters = safeMembers.map((m, i) =>
      m?.type === 'tool-pair'
        ? toolNav.register({
            toolName: m.toolNode?.toolName || m.useBlock?.name || 'tool',
            occurrenceId: m.useBlock?.id || m.toolNode?.toolUseId,
            getEl: () => rootRef.current,
            reveal: () => goRef.current(i),
            memberIdx: i,
          })
        : null,
    );
    return () => unregisters.forEach((un) => un?.());
    // Member composition is static for a mounted carousel (units are built
    // from immutable session data), so registration happens once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock the frame to the max of each member's *natural collapsed* height
  // so swapping siblings doesn't make the nav row jump as content size
  // differs. Each idx is measured only on its FIRST mount — when expansion
  // state is persistent (see ExpansionContext), a revisited sibling can mount
  // already expanded, and re-measuring then would inflate the floor with the
  // expanded height. Recording once captures the natural (collapsed) height
  // the first time the sibling is seen; content grows/shrinks freely above
  // that floor afterward.
  const innerRef = useRef(null);
  const naturalHeights = useRef(new Map());
  const [lockHeight, setLockHeight] = useState(0);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || naturalHeights.current.has(idx)) return;
    // Defer one frame so any inner layout (mono fallback, status-chip
    // measurement) has settled before we record the natural height.
    const rafId = requestAnimationFrame(() => {
      const h = el.getBoundingClientRect().height;
      if (h <= 0) return;
      naturalHeights.current.set(idx, h);
      let max = 0;
      for (const v of naturalHeights.current.values()) {
        if (v > max) max = v;
      }
      setLockHeight(max);
    });
    return () => cancelAnimationFrame(rafId);
  }, [idx]);

  if (N === 0) return null;

  const clamp = (i) => Math.max(0, Math.min(N - 1, i));
  const go = (i) => setIdx(clamp(i));
  goRef.current = go;

  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); go(idx - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
    if (e.key === 'Home')       { e.preventDefault(); go(0); }
    if (e.key === 'End')        { e.preventDefault(); go(N - 1); }
  };
  const onTouchStart = (e) => {
    touchStartX.current = e.touches?.[0]?.clientX ?? null;
  };
  const onTouchEnd = (e) => {
    if (touchStartX.current == null) return;
    const endX = e.changedTouches?.[0]?.clientX ?? touchStartX.current;
    const delta = endX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) < SWIPE_THRESHOLD) return;
    go(idx + (delta < 0 ? 1 : -1));
  };

  const current = safeMembers[idx];
  const rawNames = Array.isArray(siblings) && siblings.length === N
    ? siblings
    : safeMembers.map(memberName);
  const labels = disambiguate(rawNames);
  const useDots = N > MAX_TABS;

  return (
    <div
      className="parallel-carousel"
      role="region"
      aria-roledescription="carousel"
      aria-label={`Parallel tool calls (${N})`}
      ref={rootRef}
    >
      <div className="parallel-carousel__header">
        <span className="parallel-carousel__title">
          <span className="parallel-carousel__glyph" aria-hidden="true">⇶</span>
          PARALLEL
          <span className="parallel-carousel__count">{idx + 1}/{N}</span>
        </span>
        <span className="parallel-carousel__hint" aria-hidden="true">← →</span>
      </div>

      {useDots ? null : (
        <div className="parallel-carousel__tabs" role="tablist" aria-label="Parallel call selector">
          {labels.map((name, i) => {
            const active = i === idx;
            const kind = safeMembers[i]?.type === 'sub-agent' ? 'subagent' : 'tool';
            const fullName = rawNames[i] || name;
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={`Show ${fullName}`}
                title={fullName}
                className={
                  'parallel-carousel__tab'
                  + (active ? ' parallel-carousel__tab--active' : '')
                  + ` parallel-carousel__tab--${kind}`
                }
                onClick={() => go(i)}
              >
                <span className="parallel-carousel__tab-index">{i + 1}</span>
                <span className="parallel-carousel__tab-label">{truncate(name, MAX_TAB_LABEL)}</span>
              </button>
            );
          })}
        </div>
      )}

      <div
        className="parallel-carousel__frame"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        aria-live="polite"
        aria-atomic="true"
        style={lockHeight ? { minHeight: `${lockHeight}px` } : undefined}
      >
        <div className="parallel-carousel__inner" ref={innerRef} key={idx}>
          {/* NOOP provider: the carousel registered every member above, so
              the mounted inner ToolPair must not register a duplicate. */}
          <ToolNavContext.Provider value={NOOP_NAV}>
            {current?.type === 'sub-agent' ? (
              <SubAgentPair
                useBlock={current.useBlock}
                agentNode={current.agentNode}
                onZoom={onZoomIntoSubAgent}
              />
            ) : current?.type === 'tool-pair' ? (
              <ToolPair
                useBlock={current.useBlock}
                resultBlock={current.resultBlock}
                toolNode={current.toolNode}
              />
            ) : null}
          </ToolNavContext.Provider>
        </div>
      </div>

      <div className="parallel-carousel__nav">
        <button
          type="button"
          className="parallel-carousel__step"
          aria-label="Previous parallel call"
          onClick={() => go(idx - 1)}
          disabled={idx === 0}
        >
          ←
        </button>

        {useDots && (
          <div className="parallel-carousel__dots" role="tablist" aria-label="Parallel call selector">
            {safeMembers.map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === idx}
                aria-label={`Show ${rawNames[i] || `item ${i + 1}`}`}
                title={rawNames[i] || `item ${i + 1}`}
                className={`parallel-carousel__dot ${i === idx ? 'parallel-carousel__dot--active' : ''}`}
                onClick={() => go(i)}
              />
            ))}
          </div>
        )}

        <button
          type="button"
          className="parallel-carousel__step"
          aria-label="Next parallel call"
          onClick={() => go(idx + 1)}
          disabled={idx === N - 1}
        >
          →
        </button>
      </div>
    </div>
  );
}

function memberName(m) {
  if (m?.type === 'tool-pair') return m.toolNode?.toolName || m.useBlock?.name || 'tool';
  if (m?.type === 'sub-agent') return m.agentNode?.agentName || 'subagent';
  return '';
}

function truncate(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// When two members share a name (e.g. three Bash calls in one batch), append
// a 1-based occurrence index so the tabs remain individually addressable.
function disambiguate(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const running = new Map();
  return names.map((n) => {
    if ((counts.get(n) || 0) <= 1) return n;
    const k = (running.get(n) || 0) + 1;
    running.set(n, k);
    return `${n} ${k}`;
  });
}
