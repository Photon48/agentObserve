// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useRef } from 'react';
import { CollapsibleText } from './CollapsibleText.jsx';
import { StatusChip } from './StatusChip.jsx';
import { useToolOccurrence } from './ToolNavContext.jsx';
import { formatToolInput, prettifyMaybeJson } from '../../utils/prettyJson.js';

// Paired TOOL_USE + TOOL_RESULT card. The colored left rail (cyan→amber)
// gives a continuous bracket so input and output read as one unit.

export function ToolPair({ useBlock, resultBlock, toolNode }) {
  const inputText = formatToolInput(useBlock?.input);
  const resultText = prettifyMaybeJson(resultBlock?.text ?? '');
  const success = resultBlock?.success !== false && !resultBlock?.is_error;
  const durationMs = resultBlock?.durationMs || toolNode?.durationMs || 0;
  const errorText = resultBlock?.errorText || toolNode?.error || '';

  const toolName = toolNode?.toolName || useBlock?.name || 'tool';
  const toolUseId = useBlock?.id || '';

  const rootRef = useRef(null);
  useToolOccurrence(toolName, rootRef);

  return (
    <div className="tool-pair" role="group" aria-label={`Tool call: ${toolName}`} ref={rootRef}>
      <div className="tool-pair__rail" aria-hidden="true" />

      <div className="tool-pair__use conv-block conv-block--tool-use">
        <div className="conv-block__header">
          ⚙ TOOL_USE  {toolName}
          {toolUseId && <span className="tool-pair__id" title={toolUseId}>{shortId(toolUseId)}</span>}
        </div>
        <CollapsibleText text={inputText} previewLines={8} />
      </div>

      <div className="tool-pair__bridge">
        <StatusChip
          success={success}
          durationMs={durationMs}
          errorText={errorText}
        />
      </div>

      <div className="tool-pair__result conv-block conv-block--tool-result">
        <div className="conv-block__header">↩ RESULT  {toolName}</div>
        <CollapsibleText text={resultText} previewLines={6} emptyLabel="(no output)" />
      </div>
    </div>
  );
}

function shortId(id) {
  if (!id) return '';
  if (id.length <= 12) return id;
  return id.slice(0, 10) + '…';
}
