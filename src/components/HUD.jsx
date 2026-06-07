import { useState } from 'react';
import { truncateId, formatTokens, formatDuration } from '../utils/format.js';

export function HUD({ sessionId, turnIdx, turnCount, turn }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!sessionId) return;
    navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="hud">
      <div className="hud__cell">
        <span className="hud__label">SESSION</span>
        <span
          className={`hud__value hud__value--copyable${copied ? ' hud__value--copied' : ''}`}
          onClick={handleCopy}
        >
          {copied ? 'copied' : sessionId ? truncateId(sessionId, 16) : '...'}
        </span>
      </div>
      <div className="hud__cell">
        <span className="hud__label">TURN</span>
        <span className="hud__counter">
          {turnCount > 0 ? `${turnIdx + 1}/${turnCount}` : '...'}
        </span>
      </div>
      {turn && (
        <>
          <div className="hud__cell">
            <span className="hud__label">TOKENS</span>
            <span className="hud__value">
              ↓{formatTokens(turn.totalInputTokens)} ↑{formatTokens(turn.totalOutputTokens)}
            </span>
          </div>
          <div className="hud__cell">
            <span className="hud__label">DURATION</span>
            <span className="hud__value">{formatDuration(turn.durationMs)}</span>
          </div>
        </>
      )}
    </div>
  );
}
