// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useState, useMemo, useRef, useCallback } from 'react';
import { formatCost, formatTokens, formatDuration, formatPct } from '../utils/format.js';
import { CollapsibleText } from './agentStep/CollapsibleText.jsx';
import { ToolPair } from './agentStep/ToolPair.jsx';
import { SubAgentPair } from './agentStep/SubAgentPair.jsx';
import { ParallelCarousel } from './agentStep/ParallelCarousel.jsx';
import { buildRenderUnits, buildRenderUnitsFromNodes } from './agentStep/renderUnits.js';
import { groupRenderUnits, callStats, callDurations, callManifest, callPreview } from './agentStep/callGroups.js';
import { MessageCall } from './agentStep/MessageCall.jsx';
import { prettifyMaybeJson } from '../utils/prettyJson.js';

function PromptStep({ step }) {
  return (
    <div className="step-prompt">
      <div className="step-title">▶ USER PROMPT</div>
      <CollapsibleText text={step.text} previewLines={10} />
    </div>
  );
}

// ── Conversation blocks ──────────────────────────────────────────────────────

function ThoughtBlock({ block }) {
  // Anthropic's extended-thinking is privacy-redacted upstream — the model
  // emitted reasoning but content is withheld. Show a labeled badge instead
  // of an "(empty)" CollapsibleText so the operator understands what's going
  // on. Unredacted reasoning (rare but possible) renders normally.
  if (block.redacted) {
    return (
      <div className="conv-block conv-block--thought conv-block--redacted">
        <div className="conv-block__header">
          ◈ THINKING
          <span className="conv-block__badge"> · redacted by anthropic</span>
          {block.tokens != null && <span className="conv-block__badge"> · {formatTokens(block.tokens)} tok</span>}
        </div>
        <div className="conv-block__body conv-block__body--dim">
          (model emitted reasoning, content withheld upstream)
        </div>
      </div>
    );
  }
  return (
    <div className="conv-block conv-block--thought">
      <div className="conv-block__header">
        ◈ THINKING
        {block.tokens != null && <span className="conv-block__badge"> · {formatTokens(block.tokens)} tok</span>}
      </div>
      <CollapsibleText text={block.text} previewLines={8} />
    </div>
  );
}

function TextBlock({ block, model }) {
  const label = model || 'ASSISTANT';
  return (
    <div className="conv-block conv-block--text">
      <div className="conv-block__header">
        ◆ {label}
        {block.tokens != null && <span className="conv-block__badge"> · {formatTokens(block.tokens)} tok</span>}
      </div>
      <CollapsibleText text={block.text} previewLines={10} />
    </div>
  );
}

function LLMTimingRow({ node }) {
  if (!node) return null;
  // The exact per-message (per-LLM-call) token figures, straight from the API.
  // Input the model saw = fresh + cache-read + cache-write; cache% = share served
  // from cache. Shown so an operator can see where tokens go message by message.
  const cacheRead = node.cacheReadTokens || 0;
  const cacheCreation = node.cacheCreationTokens || 0;
  const totalIn = (node.inputTokens || 0) + cacheRead + cacheCreation;
  const pct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
  return (
    <div className="llm-timing-row">
      <span className="llm-timing__label">◆ LLM</span>
      <span className="llm-timing__model">{node.model}</span>
      {totalIn > 0 && (
        <span className="llm-timing__tokens">in {formatTokens(totalIn)}</span>
      )}
      {cacheRead > 0 && (
        <span className="llm-timing__cache">cache {formatPct(pct)}</span>
      )}
      {node.outputTokens > 0 && (
        <span className="llm-timing__tokens">out {formatTokens(node.outputTokens)}</span>
      )}
      <span className="llm-timing__dur">{formatDuration(node.durationMs)}</span>
      {node.ttftMs > 0 && (
        <span className="llm-timing__ttft">ttft {formatDuration(node.ttftMs)}</span>
      )}
    </div>
  );
}

function AgentResponseBlock({ block }) {
  return (
    <div className="conv-block conv-block--agent-response">
      <div className="conv-block__header">
        ★ RESPONSE
        {block.tokens != null && <span className="conv-block__badge"> · {formatTokens(block.tokens)} tok</span>}
      </div>
      <CollapsibleText text={block.text} previewLines={10} />
    </div>
  );
}

function TextUnitBlock({ block, model }) {
  switch (block.type) {
    case 'THOUGHT':        return <ThoughtBlock block={block} />;
    case 'TEXT':           return <TextBlock block={block} model={model} />;
    case 'AGENT_RESPONSE': return <AgentResponseBlock block={block} />;
    default: return null;
  }
}

function OrphanToolResultBlock({ block }) {
  return (
    <div className="conv-block conv-block--tool-result conv-block--orphan">
      <div className="conv-block__header">
        ↩ RESULT  {block?.name}
        <span className="conv-block__orphan-tag" title="no matching tool_use">(unmatched)</span>
      </div>
      <CollapsibleText text={prettifyMaybeJson(block?.text || '')} previewLines={6} />
    </div>
  );
}

function renderUnit(u, onZoomIntoSubAgent) {
  switch (u.type) {
    case 'llm-timing':
      return <LLMTimingRow key={u.key} node={u.node} />;
    case 'text':
      return <TextUnitBlock key={u.key} block={u.block} model={u.model} />;
    case 'tool-pair':
      return (
        <ToolPair
          key={u.key}
          useBlock={u.useBlock}
          resultBlock={u.resultBlock}
          toolNode={u.toolNode}
        />
      );
    case 'sub-agent':
      return (
        <SubAgentPair
          key={u.key}
          useBlock={u.useBlock}
          agentNode={u.agentNode}
          onZoom={onZoomIntoSubAgent}
        />
      );
    case 'parallel':
      return (
        <ParallelCarousel
          key={u.key}
          members={u.members}
          siblings={u.siblings}
          onZoomIntoSubAgent={onZoomIntoSubAgent}
        />
      );
    case 'orphan-tool-use':
      return (
        <ToolPair
          key={u.key}
          useBlock={u.useBlock}
          resultBlock={null}
          toolNode={u.toolNode}
          orphan
        />
      );
    case 'orphan-tool-result':
      return <OrphanToolResultBlock key={u.key} block={u.block} />;
    case 'cascade-llm':
      return <LLMNode key={u.key} node={u.node} />;
    case 'cascade-hook':
      return <HookNode key={u.key} node={u.node} />;
    default: return null;
  }
}

// Groups a flat render-unit stream into per-LLM-call blocks (MessageCall),
// each collapsed by default. The compact block shows in / cache / out / time /
// ttft with mini bars; expanding reveals the thinking / text / tool-use blocks.
// Open state is held here (a Set of callIndex) so the expand-all / collapse-all
// toggle can drive every block at once. Token magnitude across the whole
// session is shown on the turn timeline (TimelineBar), not here.
function AgentConversation({ units, onZoomIntoSubAgent }) {
  const groups = useMemo(() => groupRenderUnits(units), [units]);
  const callIndices = useMemo(
    () => groups.filter((g) => g.llm).map((g) => g.callIndex),
    [groups],
  );
  // Sum of each call's combined (llm + tool) duration. Within one agent the
  // calls are sequential, so this tiles the agent's own total — the figure the
  // collapsed block durations add up to.
  const totalMs = useMemo(
    () => groups.reduce((sum, g) => (g.llm ? sum + callDurations(g).totalMs : sum), 0),
    [groups],
  );
  // Collapsed by default — start with an empty open set.
  const [openSet, setOpenSet] = useState(() => new Set());

  // Reset open state when the underlying calls change (new agent / turn).
  const groupsRef = useRef(groups);
  if (groupsRef.current !== groups) {
    groupsRef.current = groups;
    if (openSet.size) setOpenSet(new Set());
  }

  const toggle = useCallback((idx) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const allOpen = callIndices.length > 0 && openSet.size >= callIndices.length;
  const toggleAll = useCallback(() => {
    setOpenSet(allOpen ? new Set() : new Set(callIndices));
  }, [allOpen, callIndices]);

  return (
    <div className="agent-conv">
      {callIndices.length >= 1 && (
        <div className="agent-conv__controls">
          <span className="agent-conv__count">
            {callIndices.length} llm call{callIndices.length === 1 ? '' : 's'}
            {totalMs > 0 && <span className="agent-conv__total"> · Σ {formatDuration(totalMs)}</span>}
          </span>
          {callIndices.length > 1 && (
            <button type="button" className="agent-conv__toggle-all" onClick={toggleAll} aria-pressed={allOpen}>
              {allOpen ? 'collapse all' : 'expand all'}
            </button>
          )}
        </div>
      )}
      <div className="agent-conv__calls">
        {groups.map((g) => (
          <MessageCall
            key={g.key}
            stats={callStats(g)}
            durations={g.llm ? callDurations(g) : null}
            manifest={g.llm ? callManifest(g) : null}
            preview={g.llm ? callPreview(g) : null}
            open={g.llm ? openSet.has(g.callIndex) : true}
            onToggle={g.llm ? () => toggle(g.callIndex) : undefined}
          >
            {g.units.map((u) => renderUnit(u, onZoomIntoSubAgent))}
          </MessageCall>
        ))}
      </div>
    </div>
  );
}

function ConversationView({ blocks, toolNodeByToolUseId = {}, llmTimings = [], subAgentByToolUseId = {}, onZoomIntoSubAgent }) {
  if (!blocks?.length) return null;
  const units = buildRenderUnits(blocks, {
    toolNodeByToolUseId,
    subAgentByToolUseId,
    llmTimings,
  });
  return <AgentConversation units={units} onZoomIntoSubAgent={onZoomIntoSubAgent} />;
}

function UserMessageBlock({ text }) {
  if (!text) return null;
  return (
    <div className="conv-block conv-block--user">
      <div className="conv-block__header">▶ USER</div>
      <div className="conv-block__body">{text}</div>
    </div>
  );
}

// ── Upstream LLM blocks ───────────────────────────────────────────────────────

function UpstreamBlock({ node }) {
  const meta = [
    `in: ${formatTokens(node.inputTokens)}`,
    `out: ${formatTokens(node.outputTokens)}`,
    node.durationMs > 0 && `dur: ${formatDuration(node.durationMs)}`,
  ].filter(Boolean).join('  ');

  return (
    <div className="upstream-block">
      <span className="upstream-block__arrow">↑</span>
      <span className="upstream-block__label">UPSTREAM</span>
      <span className="upstream-block__model">{node.model}</span>
      {meta && <span className="upstream-block__meta">{meta}</span>}
    </div>
  );
}

function UpstreamSection({ nodes, position }) {
  if (!nodes?.length) return null;
  return (
    <div className={`upstream-section upstream-section--${position}`}>
      <div className="upstream-section__divider">
        {position === 'pre' ? 'Upstream' : 'Upstream (post)'}
      </div>
      {nodes.map((n, i) => <UpstreamBlock key={i} node={n} />)}
    </div>
  );
}

// ── Legacy cascade (fallback when no blocks) ─────────────────────────────────

function LLMNode({ node }) {
  // Input the model actually saw = fresh + cache-read (cascading context) +
  // cache-write. cache% = share served from cache.
  const cacheRead = node.cacheReadTokens || 0;
  const cacheCreation = node.cacheCreationTokens || 0;
  const totalIn = (node.inputTokens || 0) + cacheRead + cacheCreation;
  const pct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
  const breakdown = [
    `fresh ${formatTokens(node.inputTokens)}`,
    cacheRead > 0 && `cache-read ${formatTokens(cacheRead)}`,
    cacheCreation > 0 && `cache-write ${formatTokens(cacheCreation)}`,
  ].filter(Boolean).join(' · ');
  const meta = [
    `in: ${formatTokens(totalIn)} (${breakdown})`,
    cacheRead > 0 && `cache ${formatPct(pct)}`,
    `out: ${formatTokens(node.outputTokens)}`,
    `cost: ${formatCost(node.costUsd)}`,
    node.ttftMs > 0 && `ttft: ${formatDuration(node.ttftMs)}`,
    `dur: ${formatDuration(node.durationMs)}`,
  ].filter(Boolean).join('  ');

  // Render the LLM_CALL's own blocks inline (THOUGHT + TEXT + AGENT_RESPONSE)
  // so the cascade path shows the same conversation content the
  // ConversationView path does. Without this, an Anthropic SDK turn that
  // falls through to the cascade (no capturedBlocks and no flat blocks on
  // child non-AGENT nodes) renders an empty card.
  const inlineBlocks = (node.blocks || []).filter(
    (b) => b.type === 'THOUGHT' || b.type === 'TEXT' || b.type === 'AGENT_RESPONSE',
  );

  return (
    <div className="cascade-node cascade-node--llm">
      <div className="cascade-node__header">
        <span><span style={{ color: 'var(--fg-green)' }}>◆ LLM CALL</span>{'  '}{node.model}</span>
        {node.stopReason && <span className="cascade-node__meta">stop: {node.stopReason}</span>}
      </div>
      {meta && <div className="cascade-node__meta">{meta}</div>}
      {inlineBlocks.length > 0 && (
        <div className="cascade-node__blocks">
          {inlineBlocks.map((b, i) => (
            <TextUnitBlock key={`llm-b-${i}`} block={b} model={node.model} />
          ))}
        </div>
      )}
    </div>
  );
}

function HookNode({ node }) {
  const passed = node.success;
  return (
    <div className="cascade-node cascade-node--hook">
      <div className="cascade-node__header">
        <span>
          <span style={{ color: 'var(--fg-purple)' }}>⚡ HOOK</span>{'  '}{node.hookName}
          {'  '}<span className="cascade-node__meta">{node.hookEvent}</span>
        </span>
        <span className={passed ? 'hook-pass' : 'hook-fail'}>
          {node.durationMs > 0 ? formatDuration(node.durationMs) + '  ' : ''}
          {passed !== undefined ? (passed ? '✓ PASS' : '✗ FAIL') : ''}
        </span>
      </div>
    </div>
  );
}

// AGENT-kind AgentNode: a sub-agent that the user can zoom into. Renders as
// a clickable card with the agent star icon, agent name, and a summary of
// what's inside (child count, duration). Clicking pushes a new agent view
// onto the navigation stack (see DungeonView.viewStack).
function SubAgentNode({ node, onZoom }) {
  const childCount = Array.isArray(node.nodes) ? node.nodes.length : 0;
  const llmCount = childCount > 0 ? node.nodes.filter((n) => n.kind === 'LLM_CALL').length : 0;
  const toolCount = childCount > 0 ? node.nodes.filter((n) => n.kind === 'TOOL').length : 0;
  const nestedAgents = childCount > 0 ? node.nodes.filter((n) => n.kind === 'AGENT').length : 0;

  return (
    <button
      type="button"
      className="cascade-node cascade-node--agent"
      onClick={() => onZoom?.(node)}
    >
      <div className="cascade-node__header">
        <span>
          <span style={{ color: 'var(--fg-amber)' }}>★ AGENT</span>{'  '}
          {node.agentName || 'subagent'}
        </span>
        <span className="cascade-agent__zoom-hint">zoom in ▸</span>
      </div>
      <div className="cascade-agent__summary">
        <span>{childCount} step{childCount === 1 ? '' : 's'}</span>
        {llmCount > 0 && <span>{llmCount} llm</span>}
        {toolCount > 0 && <span>{toolCount} tool</span>}
        {nestedAgents > 0 && <span>{nestedAgents} sub-agent</span>}
        {node.durationMs > 0 && <span>{formatDuration(node.durationMs)}</span>}
      </div>
      {node.aggTotalInputTokens > 0 && (
        <div className="cascade-agent__summary">
          <span>in {formatTokens(node.aggTotalInputTokens)}</span>
          <span>out {formatTokens(node.aggOutputTokens)}</span>
          {node.aggCacheReadTokens > 0 && <span>cache {formatPct(node.cachePct)}</span>}
        </div>
      )}
    </button>
  );
}


// When AgentStep is rendered for a sub-agent zoom level, conversation-block
// view doesn't apply (blocks belong to the top-level AGENT's flat block list,
// not nested sub-agents). The cascade is the right view for nested levels.
// When the top-level agent step still has captured blocks, we keep the
// conversation view — but inside it, any AGENT-kind AgentNode would not be
// visible (blocks are only LLM/tool content). So AGENT nodes are presented
// through the cascade fallback path below.
export function AgentStep({ step, onZoomIntoSubAgent }) {
  const nodes = step.nodes || [];
  const upstreamPre  = step.upstreamPre  || [];
  const upstreamPost = step.upstreamPost || [];

  // Cross-reference indices used by buildRenderUnits to pair TOOL_USE
  // blocks with their TOOL agentNode (for status / parallelGroup) and to
  // splice promoted AGENT-kind sub-agents in at their spawning toolUseId.
  const toolNodeByToolUseId = {};
  const subAgentByToolUseId = {};
  const subAgentNodes = [];
  const llmTimings = [];
  for (const node of nodes) {
    if (node.kind === 'TOOL' && node.toolUseId) {
      toolNodeByToolUseId[node.toolUseId] = node;
    } else if (node.kind === 'AGENT') {
      subAgentNodes.push(node);
      if (node.toolUseId) subAgentByToolUseId[node.toolUseId] = node;
    } else if (node.kind === 'LLM_CALL') {
      llmTimings.push({
        durationMs: node.durationMs,
        ttftMs: node.ttftMs,
        model: node.model,
        inputTokens: node.inputTokens,
        outputTokens: node.outputTokens,
        cacheReadTokens: node.cacheReadTokens,
        cacheCreationTokens: node.cacheCreationTokens,
        stopReason: node.stopReason,
        costUsd: node.costUsd,
      });
    }
  }

  function renderOrphanSubAgents(blocks) {
    if (subAgentNodes.length === 0) return null;
    const matchedIds = new Set();
    for (const b of blocks || []) {
      if (b.type === 'TOOL_USE' && b.id && subAgentByToolUseId[b.id]) matchedIds.add(b.id);
    }
    const orphans = subAgentNodes.filter((a) => !a.toolUseId || !matchedIds.has(a.toolUseId));
    if (orphans.length === 0) return null;
    return (
      <div className="agent-cascade agent-cascade--subagents">
        <div className="agent-cascade__subhead">SUB-AGENTS (no inline match)</div>
        {orphans.map((sub, i) => (
          <div key={`orphan-${i}`}>
            <SubAgentNode node={sub} onZoom={onZoomIntoSubAgent} />
          </div>
        ))}
      </div>
    );
  }

  // Cascade fallback: synthesize render units from agentNodes directly so
  // ToolPair + ParallelCarousel still apply when no capturedBlocks exist.
  // Same per-call grouping + spectrum as the captured-blocks path — the unit
  // streams are homogeneous (buildRenderUnitsFromNodes emits llm-timing +
  // text units), so AgentConversation handles both.
  function renderCascade(srcNodes) {
    const units = buildRenderUnitsFromNodes(srcNodes);
    return <AgentConversation units={units} onZoomIntoSubAgent={onZoomIntoSubAgent} />;
  }

  const agentContent = (() => {
    if (step.capturedBlocks?.length > 0) {
      return (
        <>
          <ConversationView
            blocks={step.capturedBlocks}
            toolNodeByToolUseId={toolNodeByToolUseId}
            llmTimings={llmTimings}
            subAgentByToolUseId={subAgentByToolUseId}
            onZoomIntoSubAgent={onZoomIntoSubAgent}
          />
          {renderOrphanSubAgents(step.capturedBlocks)}
        </>
      );
    }
    if (nodes.length === 0) {
      return <div className="text-dim">(no agent activity)</div>;
    }
    const inlineBlockNodes = nodes.filter((n) => n.kind !== 'AGENT');
    const flatBlocks = inlineBlockNodes.flatMap((n) => n.blocks || []);
    if (flatBlocks.length > 0) {
      return (
        <>
          <ConversationView
            blocks={flatBlocks}
            toolNodeByToolUseId={toolNodeByToolUseId}
            llmTimings={llmTimings}
            subAgentByToolUseId={subAgentByToolUseId}
            onZoomIntoSubAgent={onZoomIntoSubAgent}
          />
          {renderOrphanSubAgents(flatBlocks)}
        </>
      );
    }
    return renderCascade(nodes);
  })();

  return (
    <div className="agent-step-wrap">
      {step.aggTotalInputTokens > 0 && (
        <div className="agent-token-rollup">
          <span className="agent-token-rollup__label">AGENT TOTAL</span>
          <span>in {formatTokens(step.aggTotalInputTokens)}</span>
          <span className="text-dim">
            (fresh {formatTokens(step.aggInputTokens)}
            {step.aggCacheReadTokens > 0 && ` · cache-read ${formatTokens(step.aggCacheReadTokens)}`}
            {step.aggCacheCreationTokens > 0 && ` · cache-write ${formatTokens(step.aggCacheCreationTokens)}`})
          </span>
          {step.aggCacheReadTokens > 0 && <span>cache {formatPct(step.cachePct)}</span>}
          <span>out {formatTokens(step.aggOutputTokens)}</span>
        </div>
      )}
      <UpstreamSection nodes={upstreamPre} position="pre" />
      {(upstreamPre.length > 0 || upstreamPost.length > 0) && (
        <div className="downstream-section__divider">↓ AGENT</div>
      )}
      <UserMessageBlock text={step.userPrompt} />
      {agentContent}
      <UpstreamSection nodes={upstreamPost} position="post" />
    </div>
  );
}

function FinalStep({ step }) {
  return (
    <div className="step-final">
      <div className="final-title">Turn Summary</div>
      <div className="final-grid">
        <span className="final-key">total cost</span>
        <span className="final-val">{formatCost(step.totalCost)}</span>
        <span className="final-key">input tokens</span>
        <span className="final-val final-val--green">
          {formatTokens(step.totalContextInputTokens ?? step.totalInputTokens)}
        </span>
        <span className="final-key">↳ fresh</span>
        <span className="final-val">{formatTokens(step.totalInputTokens)}</span>
        {step.totalCacheReadTokens > 0 && (
          <>
            <span className="final-key">↳ cache read</span>
            <span className="final-val">{formatTokens(step.totalCacheReadTokens)}</span>
          </>
        )}
        {step.totalCacheCreationTokens > 0 && (
          <>
            <span className="final-key">↳ cache write</span>
            <span className="final-val">{formatTokens(step.totalCacheCreationTokens)}</span>
          </>
        )}
        {step.totalCacheReadTokens > 0 && (
          <>
            <span className="final-key">cache hit</span>
            <span className="final-val">{formatPct(step.cachePct)}</span>
          </>
        )}
        <span className="final-key">output tokens</span>
        <span className="final-val final-val--green">{formatTokens(step.totalOutputTokens)}</span>
        <span className="final-key">turn duration</span>
        <span className="final-val final-val--green">{formatDuration(step.durationMs)}</span>
      </div>
    </div>
  );
}

export function StepPanel({ step }) {
  if (!step) {
    return (
      <div className="step-panel">
        <div className="text-dim">No step data.</div>
      </div>
    );
  }

  let content;
  switch (step.type) {
    case 'PROMPT':
      content = <PromptStep step={step} />;
      break;
    case 'AGENT':
      content = <AgentStep step={step} />;
      break;
    case 'FINAL':
      content = <FinalStep step={step} />;
      break;
    default:
      content = (
        <pre className="json-dump">
          {JSON.stringify(step, null, 2)}
        </pre>
      );
  }

  return <div className="step-panel">{content}</div>;
}
