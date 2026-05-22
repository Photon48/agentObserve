import * as anthropic from './anthropic.js';
import * as langchain from './langchain.js';

const adapters = [anthropic, langchain];

export function buildSession(sessionId, rawData, orphanSpans = []) {
  for (const adapter of adapters) {
    if (adapter.canHandle(rawData)) {
      return adapter.buildSession(sessionId, rawData, orphanSpans);
    }
  }
  return null;
}
