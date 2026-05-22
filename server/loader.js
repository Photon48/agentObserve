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

export function loadAllSessions(telemetryDir) {
  const rawBySession = {};
  const orphanSpans = [];

  function ensureSession(id) {
    if (!rawBySession[id]) {
      rawBySession[id] = { logs: [], spans: [], metrics: [], requestBodies: {}, responseBodies: {} };
    }
    return rawBySession[id];
  }

  // Pending body refs: collected during log pass, resolved after
  // { sessionId, requestId, filePath, kind: 'request'|'response' }
  const pendingBodyRefs = [];

  const folders = fs.readdirSync(telemetryDir);

  for (const folder of folders) {
    const folderPath = path.join(telemetryDir, folder);
    if (!fs.statSync(folderPath).isDirectory()) continue;
    // Skip the api_bodies directory — it holds raw JSON files, not OTEL exports
    if (folder === 'api_bodies') continue;

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
                if (bodyRef && requestId) {
                  pendingBodyRefs.push({
                    sessionId,
                    requestId,
                    filePath: bodyRef,
                    kind: body === 'claude_code.api_request_body' ? 'request' : 'response',
                  });
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
              if (!sessionId || sessionId === 'default') {
                if (span.name === 'anthropic.chat') { orphanSpans.push(span); continue; }
                // Fallback: use folder name as session ID (e.g. for LangChain data)
                ensureSession(folder).spans.push(span);
                continue;
              }
              ensureSession(sessionId).spans.push(span);
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
    const parsed = readJsonFile(filePath);
    if (!parsed) continue;
    const session = rawBySession[sessionId];
    if (!session) continue;
    if (kind === 'request') {
      session.requestBodies[requestId] = parsed;
    } else {
      session.responseBodies[requestId] = parsed;
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
