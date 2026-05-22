import { useState } from 'react';
import { formatCost, formatTokens, formatDuration } from '../utils/format.js';

const MAX_PROMPT_LINES = 50;
const MAX_JSON_LINES = 20;
const MAX_RESULT_LINES = 15;

function truncateLines(text, max) {
  if (!text) return { text: '', truncated: false };
  const lines = text.split('\n');
  if (lines.length <= max) return { text, truncated: false };
  return { text: lines.slice(0, max).join('\n'), truncated: true };
}

function PromptStep({ step }) {
  const { text, truncated } = truncateLines(step.text, MAX_PROMPT_LINES);
  return (
    <div className="step-prompt">
      <div className="step-title">▶ USER PROMPT</div>
      <div className="step-text">{text || <span className="text-empty">(empty)</span>}</div>
      {truncated && <div className="step-trunc">[... truncated]</div>}
    </div>
  );
}

// ── Conversation blocks ──────────────────────────────────────────────────────

function ThoughtBlock({ block }) {
  const { text, truncated } = truncateLines(block.text, 30);
  return (
    <div className="conv-block conv-block--thought">
      <div className="conv-block__header">◈ THINKING</div>
      <div className="conv-block__body">
        {text || <span className="text-empty">(empty)</span>}
        {truncated && <div className="text-truncated">[... truncated]</div>}
      </div>
    </div>
  );
}

function TextBlock({ block }) {
  const { text, truncated } = truncateLines(block.text, 50);
  return (
    <div className="conv-block conv-block--text">
      <div className="conv-block__header">◆ CLAUDE</div>
      <div className="conv-block__body">
        {text || <span className="text-empty">(empty)</span>}
        {truncated && <div className="text-truncated">[... truncated]</div>}
      </div>
    </div>
  );
}

function ToolUseBlock({ block, timing }) {
  let jsonFormatted = '';
  try {
    jsonFormatted = JSON.stringify(block.input, null, 2);
  } catch {}
  const { text: jsonText, truncated } = truncateLines(jsonFormatted, MAX_JSON_LINES);
  return (
    <div className="conv-block conv-block--tool-use">
      <div className="conv-block__header">
        ⚙ TOOL_USE  {block.name}
        {timing != null && <span className="conv-timing">{formatDuration(timing)}</span>}
      </div>
      <div className="conv-block__body">
        {jsonText}
        {truncated && <div className="text-truncated">[... truncated]</div>}
      </div>
    </div>
  );
}

function LLMTimingRow({ node }) {
  if (!node) return null;
  return (
    <div className="llm-timing-row">
      <span className="llm-timing__label">◆ LLM</span>
      <span className="llm-timing__model">{node.model}</span>
      <span className="llm-timing__dur">{formatDuration(node.durationMs)}</span>
      {node.ttftMs > 0 && (
        <span className="llm-timing__ttft">ttft {formatDuration(node.ttftMs)}</span>
      )}
    </div>
  );
}

function ToolResultBlock({ block }) {
  const PREVIEW_LINES = 5;
  const lines = (block.text || '').split('\n');
  const needsCollapse = lines.length > PREVIEW_LINES;
  const [expanded, setExpanded] = useState(false);
  const displayed = (!needsCollapse || expanded) ? block.text : lines.slice(0, PREVIEW_LINES).join('\n');
  return (
    <div className="conv-block conv-block--tool-result">
      <div className="conv-block__header">↩ RESULT  {block.name}</div>
      <div className="conv-block__body">
        {displayed || <span className="text-empty">(empty)</span>}
      </div>
      {needsCollapse && (
        <button className="conv-block__toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '▾ collapse' : `▸ show ${lines.length - PREVIEW_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

function AgentResponseBlock({ block }) {
  const { text, truncated } = truncateLines(block.text, 50);
  return (
    <div className="conv-block conv-block--agent-response">
      <div className="conv-block__header">★ RESPONSE</div>
      <div className="conv-block__body">
        {text || <span className="text-empty">(empty)</span>}
        {truncated && <div className="text-truncated">[... truncated]</div>}
      </div>
    </div>
  );
}

function ConvBlock({ block, timing }) {
  switch (block.type) {
    case 'THOUGHT':         return <ThoughtBlock block={block} />;
    case 'TEXT':            return <TextBlock block={block} />;
    case 'TOOL_USE':        return <ToolUseBlock block={block} timing={timing} />;
    case 'TOOL_RESULT':     return <ToolResultBlock block={block} />;
    case 'AGENT_RESPONSE':  return <AgentResponseBlock block={block} />;
    default: return null;
  }
}

function ConversationView({ blocks, toolTimingMap = {}, llmTimings = [] }) {
  if (!blocks?.length) return null;

  // Inject LLMTimingRow before each new generation group (THOUGHT/TEXT run)
  const renderList = [];
  let llmIdx = 0;
  let inGenerationGroup = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const isGenBlock = b.type === 'THOUGHT' || b.type === 'TEXT';
    if (isGenBlock && !inGenerationGroup) {
      if (llmIdx < llmTimings.length) {
        renderList.push({ _llmTiming: true, node: llmTimings[llmIdx++], key: `llm-${llmIdx}` });
      }
      inGenerationGroup = true;
    } else if (!isGenBlock) {
      inGenerationGroup = false;
    }
    renderList.push({ ...b, _idx: i });
  }

  return (
    <div className="conv-view">
      {renderList.map((item) => {
        if (item._llmTiming) {
          return <LLMTimingRow key={item.key} node={item.node} />;
        }
        const timing = item.type === 'TOOL_USE' ? toolTimingMap[item.id] : undefined;
        return <ConvBlock key={item._idx} block={item} timing={timing} />;
      })}
    </div>
  );
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
  const meta = [
    `in: ${formatTokens(node.inputTokens)}`,
    `out: ${formatTokens(node.outputTokens)}`,
    node.cacheReadTokens > 0 && `cache: ${formatTokens(node.cacheReadTokens)}`,
    `cost: ${formatCost(node.costUsd)}`,
    node.ttftMs > 0 && `ttft: ${formatDuration(node.ttftMs)}`,
    `dur: ${formatDuration(node.durationMs)}`,
  ].filter(Boolean).join('  ');

  return (
    <div className="cascade-node cascade-node--llm">
      <div className="cascade-node__header">
        <span><span style={{ color: 'var(--fg-green)' }}>◆ LLM CALL</span>{'  '}{node.model}</span>
        {node.stopReason && <span className="cascade-node__meta">stop: {node.stopReason}</span>}
      </div>
      {meta && <div className="cascade-node__meta">{meta}</div>}
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

function ToolNode({ node }) {
  const decClass =
    node.decision === 'accept' ? 'tool-decision--accept' :
    node.decision === 'block' ? 'tool-decision--block' : 'tool-decision--unknown';

  let jsonFormatted = node.toolInput || '';
  try { jsonFormatted = JSON.stringify(JSON.parse(node.toolInput), null, 2); } catch {}
  const { text: jsonText, truncated } = truncateLines(jsonFormatted, MAX_JSON_LINES);

  return (
    <div className="cascade-node cascade-node--tool">
      <div className="cascade-node__header">
        <span><span style={{ color: 'var(--fg-cyan)' }}>⚙ TOOL</span>{'  '}{node.toolName}</span>
        <span className={`tool-decision ${decClass}`}>
          {(node.decision || 'unknown').toUpperCase()}{node.source ? ` [${node.source}]` : ''}
        </span>
      </div>
      {jsonText && (
        <div className="cascade-node__input">{jsonText}{truncated ? '\n[... truncated]' : ''}</div>
      )}
      {(node.durationMs > 0 || node.toolResultSizeBytes > 0) && (
        <div className="cascade-node__meta">
          {node.durationMs > 0 ? `dur: ${formatDuration(node.durationMs)}  ` : ''}
          {node.toolResultSizeBytes > 0 ? `result: ${node.toolResultSizeBytes} bytes` : ''}
        </div>
      )}
    </div>
  );
}

function CascadeNode({ node }) {
  if (node.kind === 'LLM_CALL') return <LLMNode node={node} />;
  if (node.kind === 'TOOL') return <ToolNode node={node} />;
  if (node.kind === 'HOOK') return <HookNode node={node} />;
  return null;
}

export function AgentStep({ step }) {
  const nodes = step.nodes || [];
  const upstreamPre  = step.upstreamPre  || [];
  const upstreamPost = step.upstreamPost || [];

  // Build timing maps from agentNodes
  const toolTimingMap = {};
  const llmTimings = [];
  for (const node of nodes) {
    if (node.kind === 'TOOL' && node.toolUseId && node.durationMs > 0) {
      toolTimingMap[node.toolUseId] = node.durationMs;
    } else if (node.kind === 'LLM_CALL') {
      llmTimings.push({ durationMs: node.durationMs, ttftMs: node.ttftMs, model: node.model });
    }
  }

  const agentContent = (() => {
    if (step.capturedBlocks?.length > 0) {
      return <ConversationView blocks={step.capturedBlocks} toolTimingMap={toolTimingMap} llmTimings={llmTimings} />;
    }
    if (nodes.length === 0) {
      return <div className="text-dim">(no agent activity)</div>;
    }
    const hasBlocks = nodes.some((n) => n.kind === 'LLM_CALL' && n.blocks?.length > 0);
    if (hasBlocks) {
      return <ConversationView blocks={nodes.flatMap((n) => n.blocks || [])} toolTimingMap={toolTimingMap} llmTimings={llmTimings} />;
    }
    return (
      <div className="agent-cascade">
        {nodes.map((node, i) => (
          <div key={i}>
            <CascadeNode node={node} />
            {i < nodes.length - 1 && <div className="cascade-connector">{'│'}<br />{'▼'}</div>}
          </div>
        ))}
      </div>
    );
  })();

  return (
    <div className="agent-step-wrap">
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
        <span className="final-val final-val--green">{formatTokens(step.totalInputTokens)}</span>
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
        <pre style={{ color: 'var(--fg-dim)', fontSize: 11 }}>
          {JSON.stringify(step, null, 2)}
        </pre>
      );
  }

  return <div className="step-panel">{content}</div>;
}
