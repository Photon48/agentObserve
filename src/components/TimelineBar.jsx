// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { formatTokens } from '../utils/format.js';

// Per-turn token figures the bars encode. A "message" is one turn (a user/agent
// interaction). contextIn = what the model saw (fresh + cache); out = generated.
function turnTokens(t) {
  const contextIn = t?.totalContextInputTokens ?? t?.totalInputTokens ?? 0;
  const out = t?.totalOutputTokens ?? 0;
  return { contextIn, out, total: contextIn + out };
}

// Token weight is encoded as a solid color-intensity ramp (not bar height).
//
// Ratio-aware: each turn is normalized on a LOG scale between the session's min
// and max non-empty turns, so the ramp reflects multiplicative (ratio)
// differences and stays meaningful whether a framework's turns run ~2K or ~16M
// tokens. A linear normalize crushes the mid-range (a turn 0.36 of the way up
// by raw count is perceptually much higher by ratio); the log scale keeps
// mid-weight turns visibly distinct from both the floor and the peak.
//
// MIN_INTENSITY floors every real turn at a faint-but-visible tint, distinct
// from a zero-token turn (which renders as the neutral --empty baseline).
const MIN_INTENSITY = 0.1;
function intensityFor(total, min, max) {
  if (total <= 0) return 0;
  if (max <= min) return 1; // single turn / all equal: full intensity
  const norm =
    (Math.log(total) - Math.log(min)) / (Math.log(max) - Math.log(min));
  const clamped = Math.min(1, Math.max(0, norm));
  return MIN_INTENSITY + (1 - MIN_INTENSITY) * clamped;
}

export function TimelineBar({ turns, turnIdx, onTurnSelect, detailMode }) {
  const before = turnIdx;
  const after = turns.length - turnIdx - 1;
  const currentTurn = turns[turnIdx] || null;
  const prompt = currentTurn?.userPrompt;

  const totals = turns.map((t) => turnTokens(t).total);
  const maxTotal = totals.reduce((m, v) => (v > m ? v : m), 0);
  // Floor over non-empty turns only, so a zero-token turn (e.g. /clear) doesn't
  // anchor the ramp's bottom — empty turns are styled separately.
  const minTotal = totals.reduce(
    (m, v) => (v > 0 && v < m ? v : m),
    maxTotal,
  );

  return (
    <div className="timeline-bar">
      <div className="timeline-bar__hints">
        {!detailMode ? (
          <>
            <span><span className="nav-hint__key">↑ ↓</span> groups</span>
            <span><span className="nav-hint__key">← →</span> parallel</span>
            <span><span className="nav-hint__key">Shift+← →</span> turns</span>
            <span><span className="nav-hint__key">Enter</span> inspect</span>
            <span><span className="nav-hint__key">ESC</span> sessions</span>
          </>
        ) : (
          <>
            <span><span className="nav-hint__key">↑ ↓</span> groups</span>
            <span><span className="nav-hint__key">← →</span> parallel</span>
            <span><span className="nav-hint__key">ESC</span> back to graph</span>
            <span><span className="nav-hint__key">Shift+← →</span> turns</span>
          </>
        )}
      </div>
      <div className="timeline-bar__track">
        <span className="timeline-bar__count">{before} before</span>
        <div className="timeline-bar__segments">
          {turns.map((t, i) => {
            const total = totals[i];
            const isEmpty = total <= 0;
            const intensity = intensityFor(total, minTotal, maxTotal);
            return (
              <button
                key={i}
                type="button"
                className={
                  'timeline-bar__segment' +
                  (isEmpty ? ' timeline-bar__segment--empty' : '') +
                  (i === turnIdx ? ' timeline-bar__segment--active' : '') +
                  (i < turnIdx ? ' timeline-bar__segment--past' : '')
                }
                style={{ '--intensity': intensity.toFixed(3) }}
                onClick={() => onTurnSelect(i)}
                aria-label={`Turn ${i + 1}: ${formatTokens(total)} tokens`}
                aria-current={i === turnIdx ? 'true' : undefined}
                title={`Turn ${i + 1}\n${formatTokens(total)} tokens${t.userPrompt ? `\n${t.userPrompt.slice(0, 120)}` : ''}`}
              />
            );
          })}
        </div>
        <span className="timeline-bar__count">{after} after</span>
      </div>
      <div className="timeline-bar__prompt">
        {prompt
          ? prompt.slice(0, 80) + (prompt.length > 80 ? '...' : '')
          : '(no prompt)'}
      </div>
    </div>
  );
}
