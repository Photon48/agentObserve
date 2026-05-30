import { useEffect, useRef, memo } from 'react';
import { NodeDetailView } from './NodeDetailView.jsx';

// ── Modal stack of detail/sub-agent panels ─────────────────────────────────
//
// Each entry in `stack` is one zoom level. The topmost entry renders at full
// scale and opacity; entries beneath it recede with a compounding scale and
// translateY plus dimming, suggesting depth without occupying extra layout
// space. All animation is transform-only (no width/height/top/left) to keep
// the GPU compositor in charge — see CLAUDE.md performance guardrails.
//
// Stacking math (per level back from top):
//   scale     -= 0.03
//   translateY = -10px * depthFromTop
//   opacity    = max(0.18, 1 - 0.42 * depthFromTop)
//   blur       = 1px * depthFromTop (cap at 4px)
//
// At max practical depth (4 panels), the bottom panel is at scale 0.91,
// y=-30, opacity 0.18 — visible as a recessed layer but not competing for
// attention.

const TRANSITION = '220ms cubic-bezier(0.16, 1, 0.3, 1)';
const PANEL_BG = 'var(--bg)';

function depthStyle(depthFromTop) {
  if (depthFromTop === 0) {
    return {
      transform: 'translateY(0) scale(1)',
      opacity: 1,
      filter: 'none',
      pointerEvents: 'auto',
      zIndex: 10,
    };
  }
  const scale = Math.max(0.88, 1 - 0.03 * depthFromTop);
  const ty = -10 * depthFromTop;
  const opacity = Math.max(0.18, 1 - 0.42 * depthFromTop);
  const blurPx = Math.min(4, depthFromTop);
  return {
    transform: `translateY(${ty}px) scale(${scale})`,
    opacity,
    filter: `blur(${blurPx}px)`,
    pointerEvents: 'none',
    zIndex: 10 - depthFromTop,
  };
}

// A single panel layer. Memoized on its own props so pushing a new top
// layer doesn't re-render every ancestor — only their wrapper style updates
// via the recomputed depth, but the inner content stays cached.
const PanelLayer = memo(function PanelLayer({ entry, depthFromTop, onZoomIntoSubAgent }) {
  const style = depthStyle(depthFromTop);
  return (
    <div
      className={`stacked-panel${depthFromTop === 0 ? ' stacked-panel--top' : ''}`}
      style={{
        ...style,
        transition: `transform ${TRANSITION}, opacity ${TRANSITION}, filter ${TRANSITION}`,
        background: PANEL_BG,
      }}
    >
      <div className="stacked-panel__scroll">
        <NodeDetailView
          node={entry.kind === 'detail' ? entry.workflowNode : null}
          agentStep={entry.kind === 'subagent' ? entry.agentStep : null}
          label={entry.label}
          onZoomIntoSubAgent={depthFromTop === 0 ? onZoomIntoSubAgent : undefined}
        />
      </div>
    </div>
  );
});

function DepthIndicator({ total }) {
  if (total <= 1) return null;
  const dots = Array.from({ length: total }, (_, i) => i);
  return (
    <div className="stacked-depth">
      {dots.map((i) => (
        <span
          key={i}
          className={`stacked-depth__dot${i === total - 1 ? ' stacked-depth__dot--active' : ''}`}
        />
      ))}
      <span className="stacked-depth__label">DEPTH {total}</span>
    </div>
  );
}

function EscHint({ onPop }) {
  return (
    <button
      type="button"
      className="stacked-esc-hint"
      onClick={onPop}
      title="Pop one level (Esc)"
    >
      ESC <span className="stacked-esc-hint__arrow">↩</span>
    </button>
  );
}

export function StackedDetail({ stack, onZoomIntoSubAgent, onPop }) {
  const containerRef = useRef(null);

  // Scroll the top panel into view when stack grows or shrinks. This keeps
  // long agent cascades from staying scrolled down when the user pops back.
  useEffect(() => {
    const el = containerRef.current?.querySelector('.stacked-panel--top .stacked-panel__scroll');
    if (el) el.scrollTop = 0;
  }, [stack.length]);

  if (!stack?.length) return null;

  return (
    <div className="stacked-detail" ref={containerRef}>
      {stack.map((entry, idx) => {
        const depthFromTop = stack.length - 1 - idx;
        return (
          <PanelLayer
            key={idx}
            entry={entry}
            depthFromTop={depthFromTop}
            onZoomIntoSubAgent={onZoomIntoSubAgent}
          />
        );
      })}
      <DepthIndicator total={stack.length} />
      <EscHint onPop={onPop} />
    </div>
  );
}
