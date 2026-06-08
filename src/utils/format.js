// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
export function formatCost(usd) {
  if (usd === 0) return '$0.0000';
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m${s}s`;
}

export function truncateId(id, len = 8) {
  if (!id) return '';
  return id.slice(0, len) + '…';
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
