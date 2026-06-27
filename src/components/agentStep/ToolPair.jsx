// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useRef, useState } from 'react';
import { CollapsibleText } from './CollapsibleText.jsx';
import { StatusChip } from './StatusChip.jsx';
import { useToolOccurrence } from './ToolNavContext.jsx';
import { usePersistentToggle } from './ExpansionContext.jsx';
import { formatDuration, formatTokens } from '../../utils/format.js';
import { formatToolInput, prettifyMaybeJson } from '../../utils/prettyJson.js';

// Compact, fixed-height tool card. Collapsed, every card is the same height
// so a long cascade scans cleanly: three rows — name + status + duration,
// a one-line input preview, and OUT token count (+ error when failed).
// Click the summary to expand the full TOOL_USE / TOOL_RESULT detail inline.
//
// `orphan` = a TOOL_USE with no matching TOOL_RESULT. Same card geometry so
// the cascade stays uniform; the result side is marked missing.

export function ToolPair({ useBlock, resultBlock, toolNode, orphan = false }) {
  // Persist the card's open state (and each inner block's expanded state, via
  // the keys below) keyed on the stable toolUseId so it survives carousel
  // sibling swaps and MessageCall body collapse/re-expand. Falls back to local
  // state when there's no toolUseId or no ExpansionContext.
  const cardKey = useBlock?.id ? `tool:${useBlock.id}` : null;
  const [open, setOpen] = usePersistentToggle(cardKey, false);
  // Once opened, keep the detail mounted so the close transition has something
  // to animate. Local-only is fine: when `open` is restored true on remount the
  // detail renders regardless of this flag.
  const [hasOpened, setHasOpened] = useState(false);

  const inputText = formatToolInput(useBlock?.input);
  const resultText = prettifyMaybeJson(resultBlock?.text ?? '');
  const success = orphan
    ? (!toolNode?.error && toolNode?.success !== false)
    : (resultBlock?.success !== false && !resultBlock?.is_error);
  const durationMs = resultBlock?.durationMs || toolNode?.durationMs || 0;
  const errorText = resultBlock?.errorText || toolNode?.error || '';

  const toolName = toolNode?.toolName || useBlock?.name || 'tool';
  const toolUseId = useBlock?.id || '';

  // A tool has no token cost of its own. CALL = the model's output tokens that
  // wrote this tool_use (its share of the dispatching message's output). RESULT
  // = the result text tokens read by the NEXT message. null when unknown so we
  // render an em dash rather than a misleading "0".
  const callTokens = toolNode?.callTokens ?? useBlock?.tokens ?? null;
  const resultTokens = resultBlock?.tokens ?? toolNode?.resultTokens ?? null;

  const rootRef = useRef(null);
  useToolOccurrence(toolName, rootRef, { occurrenceId: toolUseId || undefined });

  const toggle = () => {
    setOpen((o) => !o);
    setHasOpened(true);
  };

  const tokLabel = (n) => (n == null ? '—' : `${formatTokens(n)} tok`);

  return (
    <div
      className={
        'tool-card'
        + (open ? ' tool-card--open' : '')
        + (!success ? ' tool-card--err' : '')
        + (orphan ? ' tool-card--orphan' : '')
      }
      role="group"
      aria-label={`Tool call: ${toolName}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="tool-card__summary"
        aria-expanded={open}
        onClick={toggle}
      >
        <div className="tool-card__head">
          <span className="tool-card__icon" aria-hidden="true">⚙</span>
          <span className="tool-card__name">{toolName}</span>
          <span className={`tool-card__status tool-card__status--${success ? 'ok' : 'err'}`}>
            {success ? '✓' : '✗'}
          </span>
          {durationMs > 0 && <span className="tool-card__dur">{formatDuration(durationMs)}</span>}
        </div>

        <div className="tool-card__meta">
          <span
            className="tool-card__tokens"
            title="A tool has no token cost of its own. CALL = the model output tokens that wrote this tool call; RESULT = the result text tokens read back on the next message. Both are derived from the LLM calls' exact token counts."
          >
            CALL {tokLabel(callTokens)}
            <span className="tool-card__tokens-sep"> · </span>
            RESULT {tokLabel(resultTokens)}
          </span>
          {!success && errorText && (
            <span className="tool-card__err-msg" title={errorText}>{errorText}</span>
          )}
          {orphan && <span className="tool-card__orphan-tag" title="no matching tool_result">no result</span>}
          <span className="tool-card__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      <div className="tool-card__detail" role="region" aria-hidden={!open}>
        <div className="tool-card__detail-inner">
          {(open || hasOpened) && (
            <div className="tool-pair" aria-label={`Tool call detail: ${toolName}`}>
              <div className="tool-pair__rail" aria-hidden="true" />

              <div className="tool-pair__use conv-block conv-block--tool-use">
                <div className="conv-block__header">
                  ⚙ TOOL_USE  {toolName}
                  {toolUseId && <span className="tool-pair__id" title={toolUseId}>{shortId(toolUseId)}</span>}
                  {callTokens != null && <span className="conv-block__badge"> · {formatTokens(callTokens)} tok</span>}
                </div>
                <CollapsibleText
                  text={inputText}
                  previewLines={8}
                  expandKey={cardKey ? `${cardKey}:input` : null}
                />
              </div>

              {orphan ? (
                <div className="tool-pair__bridge">
                  <StatusChip success={success} durationMs={durationMs} errorText={errorText} />
                  <span className="tool-card__orphan-note">no matching tool_result</span>
                </div>
              ) : (
                <>
                  <div className="tool-pair__bridge">
                    <StatusChip success={success} durationMs={durationMs} errorText={errorText} />
                  </div>

                  <div className="tool-pair__result conv-block conv-block--tool-result">
                    <div className="conv-block__header">
                      ↩ RESULT  {toolName}
                      {resultTokens != null && <span className="conv-block__badge"> · {formatTokens(resultTokens)} tok</span>}
                    </div>
                    <CollapsibleText
                      text={resultText}
                      previewLines={6}
                      emptyLabel="(no output)"
                      expandKey={cardKey ? `${cardKey}:result` : null}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function shortId(id) {
  if (!id) return '';
  if (id.length <= 12) return id;
  return id.slice(0, 10) + '…';
}
