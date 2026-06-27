// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useEffect, useRef } from 'react';
import { formatTokens, formatDuration, formatPct } from '../../utils/format.js';
import { useToolNav, NOOP_NAV } from './ToolNavContext.jsx';

// One LLM call rendered as a single collapsible block. The collapsed header is
// three stacked zones, all controlled by the parent so expand-all works:
//   row 1 — IDENTITY + METRICS. Left: chevron, #index, model, stop reason
//           (quiet; amber only when it's an anomaly like max_tokens). Right:
//           the combined duration, separated by a rule from an aligned in/out/
//           cache group. The duration is the call's wall-clock; the token group
//           is its cost. Columns line up block-to-block so a whole stack scans.
//   row 2 — PREVIEW. The call's own text / final response shown inline so the
//           operator reads the purpose of each step in the loop without
//           expanding. Falls back to reasoning when there's no output text.
//   row 3 — TOOLS the call dispatched, as compact pills.
// Expanding reveals an ADDITIVE breakdown (the latency split + the input
// composition the row-1 totals are made of, never restating them) then the
// full body: the thinking, text, and tool call(s) the call produced.

// Stop reasons that are the routine shape of an LLM-in-a-loop. Shown, but
// quiet — a real signal (max_tokens, refusal, …) gets flagged amber instead.
const ROUTINE_STOPS = new Set(['tool_use', 'end_turn', 'stop_sequence']);

// A tool the call dispatched, as a compact pill. `★` marks a sub-agent;
// `×N` collapses repeats.
function ToolPill({ name, count, isAgent }) {
  return (
    <span
      className={'msg-pill' + (isAgent ? ' msg-pill--agent' : '')}
      title={name}
    >
      {isAgent && <span className="msg-pill__icon" aria-hidden="true">★</span>}
      <span className="msg-pill__name">{name}</span>
      {count > 1 && <span className="msg-pill__count">×{count}</span>}
    </span>
  );
}

export function MessageCall({ stats, durations, manifest, preview, occurrences, open, onToggle, children }) {
  // Sidebar tool navigation: register an always-present block-fallback entry per
  // tool call site this LLM call contains, regardless of whether the call is
  // expanded (its body — and therefore the precise ToolPair occurrences — only
  // mounts when open). navigate() uses these to cycle through every site and,
  // when the call is collapsed, pulses this whole .msg-call block.
  const nav = useToolNav();
  const sectionRef = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (nav === NOOP_NAV || !occurrences?.length) return undefined;
    const unregisters = occurrences.map((o, i) =>
      nav.register({
        toolName: o.name,
        occurrenceId: o.id,
        blockFallback: true,
        memberIdx: i,
        getEl: () => sectionRef.current,
        isOpen: () => openRef.current,
      }),
    );
    return () => unregisters.forEach((un) => un());
  }, [nav, occurrences]);

  // Leading header-less group (orphan units before any call): render the body
  // bare so nothing is dropped, but without the call chrome.
  if (!stats) {
    return <div className="msg-call msg-call--lead">{children}</div>;
  }

  const { callIndex, model, contextIn, out, ttftMs, stopReason, cachePct, cacheRead, fresh, cacheCreation } = stats;
  const llmMs = durations?.llmMs ?? 0;
  const toolMs = durations?.toolMs ?? 0;
  const totalMs = durations?.totalMs ?? llmMs;

  const tools = manifest?.tools || [];
  const previewText = preview?.text || '';
  const previewThought = preview?.thought || '';
  const hasPreview = !!(previewText || previewThought);

  const stopFlag = stopReason && !ROUTINE_STOPS.has(stopReason);

  return (
    <section
      ref={sectionRef}
      className={`msg-call${open ? ' msg-call--open' : ''}`}
      data-call-index={callIndex}
      aria-label={`LLM call ${callIndex + 1}${model ? `, ${model}` : ''}`}
    >
      <button
        type="button"
        className="msg-call__header"
        aria-expanded={open}
        onClick={onToggle}
      >
        {/* Row 1 — identity + aligned metric columns */}
        <div className="msg-call__id">
          <span className="msg-call__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="msg-call__index">#{callIndex + 1}</span>
          <span className="msg-call__model" title={model}>{model || 'llm call'}</span>
          {stopReason && (
            <span className={`msg-call__stop${stopFlag ? ' msg-call__stop--flag' : ''}`}>
              {stopReason}
            </span>
          )}
          <div className="msg-call__metrics" aria-hidden="true">
            <span
              className="msg-metric--dur"
              title={
                toolMs > 0
                  ? `${formatDuration(totalMs)} total = model ${formatDuration(llmMs)} + tools ${formatDuration(toolMs)}`
                  : `model latency ${formatDuration(llmMs)}`
              }
            >
              {formatDuration(totalMs)}
            </span>
            <span className="msg-call__tokens">
              <span className="msg-metric"><span className="msg-metric__k">in</span><span className="msg-metric__v">{formatTokens(contextIn)}</span></span>
              <span className="msg-metric"><span className="msg-metric__k">out</span><span className="msg-metric__v">{formatTokens(out)}</span></span>
              <span className="msg-metric msg-metric--cache"><span className="msg-metric__k">cache</span><span className="msg-metric__v">{cacheRead > 0 ? formatPct(cachePct) : '—'}</span></span>
            </span>
          </div>
        </div>

        {/* Row 2 — inline preview: the call's text / response (collapsed only,
            since the full body shows it once expanded). */}
        {!open && hasPreview && (
          <div className={`msg-call__preview${previewText ? '' : ' msg-call__preview--thought'}`}>
            {previewText || previewThought}
          </div>
        )}

        {/* Row 3 — tools the call dispatched */}
        {tools.length > 0 && (
          <div className="msg-call__manifest">
            {tools.map((t) => (
              <ToolPill key={t.name} name={t.name} count={t.count} isAgent={t.isAgent} />
            ))}
          </div>
        )}

        {!open && !hasPreview && tools.length === 0 && (
          <div className="msg-call__manifest msg-call__manifest--empty">no output captured</div>
        )}
      </button>

      {open && (
        <div className="msg-call__body">
          {/* Additive breakdown: the split behind row-1's totals, never the
              totals themselves (those stay visible in the header above). */}
          <div className="msg-call__breakdown">
            <span className="msg-call__bd-group">
              <span className="msg-call__bd-item"><span className="msg-call__bd-k">llm</span> {formatDuration(llmMs)}</span>
              {toolMs > 0 && (
                <span className="msg-call__bd-item"><span className="msg-call__bd-k">tools</span> {formatDuration(toolMs)}</span>
              )}
              {ttftMs > 0 && (
                <span className="msg-call__bd-item"><span className="msg-call__bd-k">ttft</span> {formatDuration(ttftMs)}</span>
              )}
            </span>
            <span className="msg-call__bd-group msg-call__bd-group--tok">
              <span className="msg-call__bd-item"><span className="msg-call__bd-k">fresh</span> {formatTokens(fresh)}</span>
              {cacheRead > 0 && (
                <span className="msg-call__bd-item"><span className="msg-call__bd-k">cache-read</span> {formatTokens(cacheRead)}</span>
              )}
              {cacheCreation > 0 && (
                <span className="msg-call__bd-item"><span className="msg-call__bd-k">cache-write</span> {formatTokens(cacheCreation)}</span>
              )}
            </span>
          </div>
          {children}
        </div>
      )}
    </section>
  );
}
