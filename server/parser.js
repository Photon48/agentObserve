import { buildSession } from './adapters/index.js';

export function buildSessions(rawBySession, orphanSpans = []) {
  const sessions = [];

  for (const [sessionId, raw] of Object.entries(rawBySession)) {
    const session = buildSession(sessionId, raw, orphanSpans);
    if (session) sessions.push(session);
  }

  return sessions;
}
