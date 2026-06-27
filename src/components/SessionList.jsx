// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSessions } from '../hooks/useSessions.js';
import { formatCost, formatTokens, formatDate, truncateId, formatPct } from '../utils/format.js';
import { FRAMEWORK_ORDER } from '../utils/framework.js';
import { SessionTabs } from './SessionTabs.jsx';

const FILTER_OPTIONS = ['1h', '4h', '12h', '24h', '2d', '7d', '14d', 'all', 'custom'];
const FILTER_MS = {
  '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000,
  '24h': 86_400_000, '2d': 172_800_000, '7d': 604_800_000,
  '14d': 1_209_600_000,
};

export function SessionList({ onSelect }) {
  const { sessions, loading, error } = useSessions();
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('all');
  const [selectedFramework, setSelectedFramework] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownIdx, setDropdownIdx] = useState(0);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const rowRefs = useRef([]);
  const dropdownRef = useRef(null);

  // Lazy-init framework tab: pick the framework with the most sessions, with
  // FRAMEWORK_ORDER as the tiebreaker. Fires once when sessions first arrive.
  useEffect(() => {
    if (selectedFramework !== null || sessions.length === 0) return;
    const counts = {};
    for (const s of sessions) {
      const f = s.framework || 'unknown';
      counts[f] = (counts[f] || 0) + 1;
    }
    const ranked = Object.keys(counts).sort((a, b) => {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      const ai = FRAMEWORK_ORDER.indexOf(a);
      const bi = FRAMEWORK_ORDER.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    setSelectedFramework(ranked[0]);
  }, [sessions, selectedFramework]);

  const now = Date.now();
  const filtered = sessions.filter((s) => {
    if (selectedFramework && s.framework !== selectedFramework) return false;
    if (search && !s.id.toLowerCase().includes(search.toLowerCase())) return false;
    if (dateFilter === 'all') return true;
    if (dateFilter === 'custom') {
      const t = new Date(s.startTime).getTime();
      const from = customFrom ? new Date(customFrom).getTime() : 0;
      const to = customTo ? new Date(customTo + 'T23:59:59').getTime() : Infinity;
      return t >= from && t <= to;
    }
    const ms = FILTER_MS[dateFilter];
    return ms ? now - new Date(s.startTime).getTime() < ms : true;
  });

  // Reset selectedIdx when filters change
  useEffect(() => { setSelectedIdx(0); }, [search, dateFilter, customFrom, customTo, selectedFramework]);

  // Clamp selectedIdx
  useEffect(() => {
    if (filtered.length > 0 && selectedIdx >= filtered.length) {
      setSelectedIdx(filtered.length - 1);
    }
  }, [filtered.length, selectedIdx]);

  // Scroll selected row into view
  useEffect(() => {
    rowRefs.current[selectedIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIdx]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // Keyboard handler
  useEffect(() => {
    const handleKey = (e) => {
      // Let native date inputs keep their arrow behavior
      if (document.activeElement?.type === 'date') return;

      if (dropdownOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setDropdownIdx((prev) => Math.min(prev + 1, FILTER_OPTIONS.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setDropdownIdx((prev) => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          setDateFilter(FILTER_OPTIONS[dropdownIdx]);
          setDropdownOpen(false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDropdownOpen(false);
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && filtered.length > 0) {
        // Don't hijack Enter when typing in search
        if (document.activeElement?.classList.contains('session-filter__search')) return;
        e.preventDefault();
        onSelect(filtered[selectedIdx].id);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [dropdownOpen, dropdownIdx, filtered, selectedIdx, onSelect]);

  if (loading) return (
    <div className="session-list">
      <div className="session-list__header">agentObserve</div>
      <div className="session-list__table-wrap">
        {[0,1,2,3,4,5].map((i) => (
          <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 0.1}s` }}>
            <div className="skeleton-cell skeleton-cell--id" />
            <div className="skeleton-cell skeleton-cell--date" />
            <div className="skeleton-cell skeleton-cell--sm" />
            <div className="skeleton-cell skeleton-cell--md" />
            <div className="skeleton-cell skeleton-cell--lg" />
            <div className="skeleton-cell skeleton-cell--lg" />
          </div>
        ))}
      </div>
    </div>
  );
  if (error) return (
    <div className="error-state">
      <div className="error-state__icon">!</div>
      <div className="error-state__message">Failed to load sessions</div>
      <div className="error-state__hint">{error}. Is the Express server running on :3001?</div>
    </div>
  );
  if (sessions.length === 0) return (
    <div className="empty-state">
      <div className="empty-state__icon">~</div>
      <div className="empty-state__title">No sessions found</div>
      <div className="empty-state__desc">No telemetry data detected.<br/>Run an agent with OTEL export to :4318 to start.</div>
    </div>
  );

  const filterLabel = dateFilter === 'custom' ? 'custom' : dateFilter;

  return (
    <div className="session-list">
      <div className="session-list__header">
        agentObserve
        <span>{sessions.length} sessions · arrows to navigate, ENTER to inspect</span>
      </div>
      <div className="session-filter-bar">
        <input
          className="session-filter__search"
          placeholder="search session id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="session-filter__dates" ref={dropdownRef}>
          <button
            className="session-filter__trigger"
            onClick={() => {
              setDropdownOpen((prev) => !prev);
              setDropdownIdx(FILTER_OPTIONS.indexOf(dateFilter));
            }}
          >
            {filterLabel}
            <span className="session-filter__chevron">{dropdownOpen ? '\u25B4' : '\u25BE'}</span>
          </button>
          {dropdownOpen && (
            <div className="session-filter__dropdown">
              {FILTER_OPTIONS.map((opt, i) => (
                <button
                  key={opt}
                  type="button"
                  className={
                    'session-filter__option'
                    + (dateFilter === opt ? ' session-filter__option--active' : '')
                    + (dropdownIdx === i ? ' session-filter__option--focused' : '')
                  }
                  onClick={() => { setDateFilter(opt); setDropdownOpen(false); }}
                  onMouseEnter={() => setDropdownIdx(i)}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>
        {dateFilter === 'custom' && (
          <div className="session-filter__custom-range">
            <input
              type="date"
              className="session-filter__date-input"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span className="session-filter__range-sep">–</span>
            <input
              type="date"
              className="session-filter__date-input"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </div>
        )}
        <span className="session-filter__count">{filtered.length}/{sessions.length}</span>
      </div>
      <SessionTabs
        sessions={sessions}
        selected={selectedFramework}
        onSelect={setSelectedFramework}
      />
      <div className="session-list__table-wrap">
        <table className="session-list__table">
          <thead>
            <tr>
              <th className="col-id">SESSION ID</th>
              <th className="col-date">STARTED</th>
              <th className="col-turns">TURNS</th>
              <th className="col-cost">COST</th>
              <th className="col-tokens">IN TOKENS</th>
              <th className="col-tokens">OUT TOKENS</th>
              <th className="col-tokens">CACHE</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => (
              <tr
                key={s.id}
                ref={(el) => { rowRefs.current[i] = el; }}
                className={i === selectedIdx ? 'session-row--selected' : ''}
                onClick={() => onSelect(s.id)}
              >
                <td className="col-id">{s.id}</td>
                <td className="col-date">{formatDate(s.startTime)}</td>
                <td className="col-turns">{s.turnCount}</td>
                <td className="col-cost">{formatCost(s.totalCost)}</td>
                <td className="col-tokens">{formatTokens(s.totalContextInputTokens ?? s.totalInputTokens)}</td>
                <td className="col-tokens">{formatTokens(s.totalOutputTokens)}</td>
                <td className="col-tokens">{s.totalCacheReadTokens > 0 ? formatPct(s.cachePct) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="session-list__empty-filter">
            No sessions match the current filter.
          </div>
        )}
      </div>
    </div>
  );
}
