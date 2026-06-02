import { FRAMEWORK_ORDER, frameworkLabel } from '../utils/framework.js';

// Horizontal tab strip — one button per framework present in `sessions`.
// Hides itself when only one framework exists (single-tab UI is noise).
export function SessionTabs({ sessions, selected, onSelect }) {
  const counts = {};
  for (const s of sessions || []) {
    const f = s.framework || 'unknown';
    counts[f] = (counts[f] || 0) + 1;
  }

  // Canonical order first, then any unrecognized frameworks appended.
  const frameworks = FRAMEWORK_ORDER.filter((f) => counts[f] > 0);
  for (const f of Object.keys(counts)) {
    if (!frameworks.includes(f)) frameworks.push(f);
  }

  if (frameworks.length <= 1) return null;

  return (
    <div className="session-tabs" role="tablist">
      {frameworks.map((f) => (
        <button
          key={f}
          role="tab"
          type="button"
          aria-selected={selected === f}
          className={`session-tabs__tab${selected === f ? ' session-tabs__tab--active' : ''}`}
          onClick={() => onSelect(f)}
        >
          <span className="session-tabs__label">{frameworkLabel(f)}</span>
          <span className="session-tabs__count">{counts[f]}</span>
        </button>
      ))}
    </div>
  );
}
