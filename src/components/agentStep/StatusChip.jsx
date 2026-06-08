// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { formatDuration } from '../../utils/format.js';

const MAX_ERR_PREVIEW = 40;

export function StatusChip({ success, durationMs, errorText, running, size = 'sm' }) {
  if (running) {
    return (
      <span className={`status-chip status-chip--pending status-chip--${size}`}>
        … running
      </span>
    );
  }
  if (success === false) {
    const full = errorText || 'error';
    const short = full.length > MAX_ERR_PREVIEW ? full.slice(0, MAX_ERR_PREVIEW - 1) + '…' : full;
    return (
      <span
        className={`status-chip status-chip--err status-chip--${size}`}
        title={full}
      >
        ✗ {short}
      </span>
    );
  }
  const dur = durationMs > 0 ? formatDuration(durationMs) : '';
  return (
    <span className={`status-chip status-chip--ok status-chip--${size}`}>
      ✓{dur ? ` ${dur}` : ''}
    </span>
  );
}
