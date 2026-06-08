// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { buildSession } from './adapters/index.js';

export function buildSessions(rawBySession, orphanSpans = []) {
  const sessions = [];

  for (const [sessionId, raw] of Object.entries(rawBySession)) {
    const session = buildSession(sessionId, raw, orphanSpans);
    if (session) sessions.push(session);
  }

  return sessions;
}
