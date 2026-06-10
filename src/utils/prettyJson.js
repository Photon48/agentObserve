// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.

// Pretty-print a string if it parses as a JSON object/array; otherwise
// return it unchanged. Guard on first char so plain prose never pays
// a JSON.parse attempt.
export function prettifyMaybeJson(text) {
  if (typeof text !== 'string') return text;
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return text;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return text; }
}

// Canonical tool-input formatter: objects stringify with 2-space indent,
// JSON-looking strings get parsed + prettified, other strings pass through.
export function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return prettifyMaybeJson(input);
  try { return JSON.stringify(input, null, 2); } catch { return ''; }
}
