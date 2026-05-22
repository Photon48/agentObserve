import { useState, useRef } from 'react';
import { AgentStep } from './StepPanel.jsx';
import { formatTokens, formatDuration } from '../utils/format.js';

const KIND_ICONS = {
  UPSTREAM_LLM: '↑',
  AGENT: '★',
  DOWNSTREAM_LLM: '↓',
  PIPELINE_MEMBER: '·',
};

const COLLAPSE_LINES = 12;

function LLMDetailView({ node }) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const nodeRef = useRef(node);
  if (nodeRef.current !== node) {
    nodeRef.current = node;
    if (inputExpanded) setInputExpanded(false);
    if (outputExpanded) setOutputExpanded(false);
  }

  const fullInput = node.systemText
    ? `[SYSTEM]\n${node.systemText}${node.inputText ? `\n\n${node.inputText}` : ''}`
    : node.inputText || '';

  function renderBlock(text, expanded, setExpanded, label, colorClass) {
    if (!text) return (
      <div className={`turn-io__block turn-io__block--${colorClass}`}>
        <div className="turn-io__label">{label}</div>
        <div className="turn-io__empty">not available</div>
      </div>
    );
    const lines = text.split('\n');
    const needsCollapse = lines.length > COLLAPSE_LINES;
    const displayed = (!needsCollapse || expanded) ? text : lines.slice(0, COLLAPSE_LINES).join('\n');
    return (
      <div className={`turn-io__block turn-io__block--${colorClass}`}>
        <div className="turn-io__label">{label}</div>
        <div className="turn-io__text">{displayed}</div>
        {needsCollapse && (
          <button className="turn-io__toggle" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'collapse' : `${lines.length - COLLAPSE_LINES} more lines`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="detail-view">
      <div className="detail-view__header">
        <span className="detail-view__kind">{node.kind}</span>
        <span className="detail-view__label">{node.label.toUpperCase()}</span>
      </div>
      <div className="detail-view__grid">
        <span className="detail-view__key">model</span>
        <span className="detail-view__val">{node.model || '—'}</span>
        <span className="detail-view__key">duration</span>
        <span className="detail-view__val">{formatDuration(node.durationMs)}</span>
        <span className="detail-view__key">input tokens</span>
        <span className="detail-view__val">{formatTokens(node.inputTokens)}</span>
        <span className="detail-view__key">output tokens</span>
        <span className="detail-view__val">{formatTokens(node.outputTokens)}</span>
        {node.maxTokens > 0 && (
          <>
            <span className="detail-view__key">max tokens</span>
            <span className="detail-view__val">{node.maxTokens}</span>
          </>
        )}
      </div>
      <div className="turn-io">
        {renderBlock(fullInput, inputExpanded, setInputExpanded, 'INPUT', 'input')}
        <div className="turn-io__divider" />
        {renderBlock(node.outputText, outputExpanded, setOutputExpanded, 'OUTPUT', 'output')}
      </div>
    </div>
  );
}

export function NodeDetailView({ node }) {
  if (!node) return null;

  if (node.kind === 'AGENT') {
    return (
      <div className="detail-view">
        <div className="detail-view__header">
          <span className="detail-view__kind">{KIND_ICONS.AGENT} AGENT</span>
          <span className="detail-view__label">AGENT DETAIL</span>
        </div>
        {node.agentStepData
          ? <AgentStep step={node.agentStepData} />
          : <div className="text-dim">No agent data.</div>
        }
      </div>
    );
  }

  if (node.kind === 'UPSTREAM_LLM' || node.kind === 'DOWNSTREAM_LLM' || node.kind === 'PIPELINE_MEMBER') {
    return <LLMDetailView node={node} />;
  }

  // Fallback for unknown kinds
  return (
    <div className="detail-view">
      <div className="detail-view__header">
        <span className="detail-view__kind">{node.kind}</span>
        <span className="detail-view__label">{node.label}</span>
      </div>
      <pre style={{ color: 'var(--fg-dim)', fontSize: 11 }}>
        {JSON.stringify({ ...node, agentStepData: undefined }, null, 2)}
      </pre>
    </div>
  );
}
