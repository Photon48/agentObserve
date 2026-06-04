import * as anthropic from './anthropic.js';
import * as claudeCodeCli from './claude_code_cli.js';
import * as langchain from './langchain.js';

const adapters = [anthropic, claudeCodeCli, langchain];

export function buildSession(sessionId, rawData, orphanSpans = []) {
  for (const adapter of adapters) {
    if (adapter.canHandle(rawData)) {
      return adapter.buildSession(sessionId, rawData, orphanSpans);
    }
  }
  return null;
}
