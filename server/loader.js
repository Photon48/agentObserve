// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import fs from 'fs';
import path from 'path';

export function getAttr(attrs, key) {
  if (!attrs) return undefined;
  const entry = attrs.find((a) => a.key === key);
  if (!entry) return undefined;
  const v = entry.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// body_ref paths are absolute paths written by whichever receiver process
// handled the log — the host (native uvicorn) or a container (where the
// telemetry dir is /data). Either prefix may not exist in THIS process, so
// resolve against the file's canonical home, telemetry/<session>/api_bodies/
// <basename>, before falling back to the literal path.
function readBodyRefFile(telemetryDir, sessionId, refPath) {
  const local = path.join(telemetryDir, sessionId, 'api_bodies', path.basename(refPath));
  return readJsonFile(local) ?? readJsonFile(refPath);
}

// OTEL_LOG_RAW_API_BODIES inline bodies may contain unescaped control characters
// (literal newlines/tabs inside JSON string values). Sanitize before parsing.
function safeParseBody(str) {
  try { return JSON.parse(str); } catch {}
  try {
    const sanitized = str.replace(/[\x00-\x1f]/g, (ch) => {
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '\\r';
      if (ch === '\t') return '\\t';
      return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    });
    return JSON.parse(sanitized);
  } catch { return null; }
}

export function loadAllSessions(telemetryDir) {
  const rawBySession = {};
  const orphanSpans = [];

  function ensureSession(id) {
    if (!rawBySession[id]) {
      rawBySession[id] = { logs: [], spans: [], metrics: [], requestBodies: {}, responseBodies: {}, toolOutputEvents: {} };
    }
    return rawBySession[id];
  }

  // Pending body refs: collected during log pass, resolved after
  // { sessionId, requestId, filePath, kind: 'request'|'response' }
  const pendingBodyRefs = [];
  // Request body logs without request_id — paired with response bodies after loading
  const pendingReqBodies = [];

  const folders = fs.readdirSync(telemetryDir);

  for (const folder of folders) {
    const folderPath = path.join(telemetryDir, folder);
    if (!fs.statSync(folderPath).isDirectory()) continue;

    const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(folderPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }

      const isLogs = file.startsWith('logs');
      const isTraces = file.startsWith('traces');
      const isMetrics = file.startsWith('metrics');

      if (isLogs) {
        for (const rl of data.resourceLogs || []) {
          for (const sl of rl.scopeLogs || []) {
            for (const rec of sl.logRecords || []) {
              const sessionId = getAttr(rec.attributes, 'session.id');
              if (!sessionId) continue;
              ensureSession(sessionId).logs.push(rec);

              // Collect body_ref pointers for API body files
              const body = rec.body?.stringValue || '';
              if (body === 'claude_code.api_request_body' || body === 'claude_code.api_response_body') {
                const bodyRef = getAttr(rec.attributes, 'body_ref');
                const requestId =
                  getAttr(rec.attributes, 'request_id') ||
                  getAttr(rec.attributes, 'client_request_id');
                const kind = body === 'claude_code.api_request_body' ? 'request' : 'response';
                if (bodyRef && requestId) {
                  pendingBodyRefs.push({
                    sessionId,
                    requestId,
                    filePath: bodyRef,
                    kind,
                  });
                } else if (bodyRef && !requestId && kind === 'request') {
                  // File-mode request body — no request_id yet, pair later
                  pendingReqBodies.push({
                    sessionId,
                    promptId: getAttr(rec.attributes, 'prompt.id'),
                    time: rec.timeUnixNano,
                    bodyRef,
                  });
                } else if (!bodyRef) {
                  // Inline mode: OTEL_LOG_RAW_API_BODIES=1 embeds JSON in an attribute
                  const inlineBody = getAttr(rec.attributes, 'body');
                  if (inlineBody && requestId) {
                    const parsed = safeParseBody(inlineBody);
                    if (parsed) {
                      const session = ensureSession(sessionId);
                      if (kind === 'request') {
                        session.requestBodies[requestId] = parsed;
                      } else {
                        session.responseBodies[requestId] = parsed;
                      }
                    }
                  } else if (inlineBody && !requestId && kind === 'request') {
                    // Request body logs lack request_id (only known after API responds).
                    // Collect for pairing with response body logs later.
                    pendingReqBodies.push({
                      sessionId,
                      promptId: getAttr(rec.attributes, 'prompt.id'),
                      time: rec.timeUnixNano,
                      body: inlineBody,
                    });
                  }
                }
              }
            }
          }
        }
      } else if (isTraces) {
        for (const rs of data.resourceSpans || []) {
          for (const ss of rs.scopeSpans || []) {
            for (const span of ss.spans || []) {
              const sessionId = getAttr(span.attributes, 'session.id')
                || getAttr(span.attributes, 'langsmith.trace.session_name');
              const resolvedSid = (sessionId && sessionId !== 'default') ? sessionId : folder;
              if (!sessionId || sessionId === 'default') {
                if (span.name === 'anthropic.chat') { orphanSpans.push(span); continue; }
                // Fallback: use folder name as session ID (e.g. for LangChain data)
                ensureSession(folder).spans.push(span);
              } else {
                ensureSession(sessionId).spans.push(span);
              }

              // Extract tool.output events from spans
              if (span.events) {
                for (const ev of span.events) {
                  if (ev.name === 'tool.output') {
                    if (rawBySession[resolvedSid]) {
                      rawBySession[resolvedSid].toolOutputEvents[span.spanId] = ev;
                    }
                  }
                }
              }
            }
          }
        }
      } else if (isMetrics) {
        for (const rm of data.resourceMetrics || []) {
          for (const sm of rm.scopeMetrics || []) {
            const sessionId = getAttr(rm.resource?.attributes, 'session.id');
            if (!sessionId) continue;
            ensureSession(sessionId).metrics.push(...(sm.metrics || []));
          }
        }
      }
    }
  }

  // Resolve body refs: read each file and store in the session map
  for (const { sessionId, requestId, filePath, kind } of pendingBodyRefs) {
    const parsed = readBodyRefFile(telemetryDir, sessionId, filePath);
    if (!parsed) continue;
    const session = rawBySession[sessionId];
    if (!session) continue;
    if (kind === 'request') {
      session.requestBodies[requestId] = parsed;
    } else {
      session.responseBodies[requestId] = parsed;
    }
  }

  // Pair request body logs (no request_id) with response body logs by prompt.id + temporal order.
  // Within a prompt.id, request/response bodies alternate: req₁, resp₁, req₂, resp₂, ...
  // Response body logs have request_id; we assign the same to the preceding request body.
  if (pendingReqBodies.length > 0) {
    // Group response body logs by sessionId + promptId for lookup
    const respIndex = {}; // "sessionId:promptId" -> [{requestId, time}] sorted by time
    for (const session of Object.values(rawBySession)) {
      for (const log of session.logs) {
        if ((log.body?.stringValue || '') !== 'claude_code.api_response_body') continue;
        const sid = getAttr(log.attributes, 'session.id');
        const pid = getAttr(log.attributes, 'prompt.id');
        const rid = getAttr(log.attributes, 'request_id');
        if (!sid || !pid || !rid) continue;
        const key = `${sid}:${pid}`;
        if (!respIndex[key]) respIndex[key] = [];
        respIndex[key].push({ requestId: rid, time: log.timeUnixNano });
      }
    }
    for (const arr of Object.values(respIndex)) {
      arr.sort((a, b) => (BigInt(a.time) < BigInt(b.time) ? -1 : 1));
    }

    // Sort pending request bodies by sessionId + promptId + time
    pendingReqBodies.sort((a, b) => {
      if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
      if (a.promptId !== b.promptId) return a.promptId < b.promptId ? -1 : 1;
      return BigInt(a.time) < BigInt(b.time) ? -1 : 1;
    });

    // Pair: for each prompt.id group, the Nth request body matches the Nth response body
    const reqCounters = {}; // "sessionId:promptId" -> index
    for (const pending of pendingReqBodies) {
      const key = `${pending.sessionId}:${pending.promptId}`;
      const idx = reqCounters[key] || 0;
      reqCounters[key] = idx + 1;
      const respArr = respIndex[key];
      if (!respArr || idx >= respArr.length) continue;
      const requestId = respArr[idx].requestId;
      const parsed = pending.bodyRef
        ? readBodyRefFile(telemetryDir, pending.sessionId, pending.bodyRef)
        : safeParseBody(pending.body);
      if (parsed) {
        const session = rawBySession[pending.sessionId];
        if (session) session.requestBodies[requestId] = parsed;
      }
    }
  }

  // Load SDK captures: telemetry/sdk_captures/<session_id>.json
  const sdkCapturesDir = path.join(telemetryDir, 'sdk_captures');
  if (fs.existsSync(sdkCapturesDir)) {
    for (const file of fs.readdirSync(sdkCapturesDir)) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.slice(0, -5); // strip .json
      const capture = readJsonFile(path.join(sdkCapturesDir, file));
      if (!capture) continue;
      if (!rawBySession[sessionId]) continue; // only attach if OTEL session exists
      rawBySession[sessionId].sdkCapture = capture;
    }
  }

  return { rawBySession, orphanSpans };
}
