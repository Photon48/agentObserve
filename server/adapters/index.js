// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
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
