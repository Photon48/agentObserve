// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
export function TimelineBar({ turns, turnIdx, onTurnSelect, detailMode }) {
  const before = turnIdx;
  const after = turns.length - turnIdx - 1;
  const currentTurn = turns[turnIdx] || null;
  const prompt = currentTurn?.userPrompt;

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
          {turns.map((t, i) => (
            <div
              key={i}
              className={
                'timeline-bar__segment' +
                (i === turnIdx ? ' timeline-bar__segment--active' : '') +
                (i < turnIdx ? ' timeline-bar__segment--past' : '')
              }
              onClick={() => onTurnSelect(i)}
              title={t.userPrompt ? t.userPrompt.slice(0, 120) : `Turn ${i + 1}`}
            />
          ))}
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
