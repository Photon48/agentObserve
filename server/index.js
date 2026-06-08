// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadAllSessions } from './loader.js';
import { buildSessions } from './parser.js';
import { createRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TELEMETRY_DIR = process.env.TELEMETRY_DIR ?? path.resolve(__dirname, '../telemetry');

function loadSessions() {
  const { rawBySession, orphanSpans } = loadAllSessions(TELEMETRY_DIR);
  return buildSessions(rawBySession, orphanSpans);
}

console.log('[agentObserve] Loading telemetry from:', TELEMETRY_DIR);
let sessions = loadSessions();
console.log(`[agentObserve] Loaded ${sessions.length} sessions, ${sessions.reduce((s, ses) => s + ses.turnCount, 0)} turns`);

// Watch telemetry dir; debounce reloads so burst writes (end of session) trigger once
let reloadTimer = null;
fs.watch(TELEMETRY_DIR, { recursive: true }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      const next = loadSessions();
      sessions = next;
      console.log(`[agentObserve] Reloaded: ${sessions.length} sessions`);
    } catch (e) {
      console.error('[agentObserve] Reload error:', e.message);
    }
  }, 800);
});

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', createRouter(() => sessions));

app.listen(3001, () => {
  console.log('[agentObserve] API server listening on http://localhost:3001');
});
