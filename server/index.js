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
import { checkForUpdates } from './updates/checker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TELEMETRY_DIR = process.env.TELEMETRY_DIR ?? path.resolve(__dirname, '../telemetry');
const VERSION_PATH = path.resolve(__dirname, '../VERSION');
const CURRENT_VERSION = readCurrentVersion();

function readCurrentVersion() {
  // AGENTOBSERVE_VERSION_OVERRIDE lets us locally simulate "I'm running
  // an older build" without mutating the tracked VERSION file. Useful
  // while developing the update banner; harmless in production where
  // the env is unset and we fall back to the on-disk VERSION.
  const override = process.env.AGENTOBSERVE_VERSION_OVERRIDE;
  if (override) return override.trim();
  try { return fs.readFileSync(VERSION_PATH, 'utf8').trim() || '0.0.0'; }
  catch { return '0.0.0'; }
}

function defaultVersionInfo() {
  return {
    current: CURRENT_VERSION,
    latest: null,
    hasUpdate: false,
    urgency: 'recommended',
    upgradeCommand: 'docker compose pull && docker compose up -d',
    releaseNotesUrl: null,
    minSupportedVersion: null,
    flags: {},
  };
}

let versionInfo = defaultVersionInfo();

// Fire-and-forget on startup. The /api/version handler returns whatever
// versionInfo currently holds; until the check resolves it's the default
// (no update banner). Failure is silent — checker logs internally.
checkForUpdates(CURRENT_VERSION).then((result) => {
  if (!result) return;
  versionInfo = { ...defaultVersionInfo(), ...result };
  if (versionInfo.hasUpdate) {
    console.log('');
    console.log(`[agentObserve] UPDATE AVAILABLE: v${versionInfo.latest}`);
    console.log(`  Upgrade:  ${versionInfo.upgradeCommand}`);
    if (versionInfo.releaseNotesUrl) {
      console.log(`  Notes:    ${versionInfo.releaseNotesUrl}`);
    }
    if (versionInfo.urgency === 'critical') {
      console.log('  Urgency:  CRITICAL — dashboard banner is non-dismissible.');
    }
    console.log('');
  }
});

function loadSessions() {
  const { rawBySession, orphanSpans } = loadAllSessions(TELEMETRY_DIR);
  return buildSessions(rawBySession, orphanSpans);
}

console.log(`[agentObserve] v${CURRENT_VERSION} starting`);
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
app.use('/api', createRouter(() => sessions, () => versionInfo));

app.listen(3001, () => {
  console.log('[agentObserve] API server listening on http://localhost:3001');
});
