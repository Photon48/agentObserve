import { useState, useEffect, useCallback, useRef } from 'react';
import { HUD } from './HUD.jsx';
import { WorkflowGraph } from './WorkflowGraph.jsx';
import { NodeDetailView } from './NodeDetailView.jsx';
import { TimelineBar } from './TimelineBar.jsx';
import { WorkflowMinimap } from './WorkflowMinimap.jsx';
import { useKeyNav } from '../hooks/useKeyNav.js';

function resolveGraphState(currentNode, currentGroupIdx, newGraph) {
  if (!newGraph?.groups?.length) return { groupIdx: 0, nodeIdx: 0 };
  if (currentNode) {
    const { kind, label } = currentNode;
    // 1. kind + label (OTEL: span role + gen_ai.request.max_tokens-derived label)
    for (const group of newGraph.groups) {
      for (let nIdx = 0; nIdx < group.nodes.length; nIdx++) {
        const n = group.nodes[nIdx];
        if (n.kind === kind && n.label === label) return { groupIdx: group.groupIdx, nodeIdx: nIdx };
      }
    }
    // 2. kind only
    for (const group of newGraph.groups) {
      for (let nIdx = 0; nIdx < group.nodes.length; nIdx++) {
        if (group.nodes[nIdx].kind === kind) return { groupIdx: group.groupIdx, nodeIdx: nIdx };
      }
    }
  }
  // 3. Positional clamp
  return { groupIdx: Math.min(currentGroupIdx, newGraph.groups.length - 1), nodeIdx: 0 };
}

function SystemPromptPanel({ prompt, label }) {
  return (
    <div className="sysprompt-panel">
      <div className="sysprompt-panel__header">{label}</div>
      <div className="sysprompt-panel__body">
        {prompt || (
          <span className="sysprompt-panel__empty">
            not available{'\n'}(enable OTEL_LOG_RAW_API_BODIES)
          </span>
        )}
      </div>
    </div>
  );
}

function extractTurnIO(turn) {
  if (!turn) return { input: '', output: '' };
  const input = turn.userPrompt || turn.steps?.[0]?.text || '';
  let output = '';
  const agentStep = turn.steps?.find((s) => s.type === 'AGENT');
  if (agentStep?.capturedBlocks?.length) {
    for (let i = agentStep.capturedBlocks.length - 1; i >= 0; i--) {
      const b = agentStep.capturedBlocks[i];
      if (b.type === 'AGENT_RESPONSE' || b.type === 'TEXT') {
        output = b.text || '';
        break;
      }
    }
  }
  if (!output) {
    const nodes = agentStep?.nodes || [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].kind === 'LLM_CALL' && nodes[i].blocks?.length) {
        const lastText = [...nodes[i].blocks].reverse().find((b) => b.type === 'TEXT' || b.type === 'AGENT_RESPONSE');
        if (lastText) { output = lastText.text || ''; break; }
      }
    }
  }
  return { input, output };
}

const COLLAPSE_LINES = 12;

function TurnIOPanel({ turn }) {
  const { input, output } = extractTurnIO(turn);
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  // Reset expanded state when turn changes
  const turnRef = useRef(turn);
  if (turnRef.current !== turn) {
    turnRef.current = turn;
    if (inputExpanded) setInputExpanded(false);
    if (outputExpanded) setOutputExpanded(false);
  }

  if (!input && !output) return null;

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
    <div className="turn-io">
      {renderBlock(input, inputExpanded, setInputExpanded, 'INPUT', 'input')}
      <div className="turn-io__divider" />
      {renderBlock(output, outputExpanded, setOutputExpanded, 'OUTPUT', 'output')}
    </div>
  );
}

function ToolDirectorySidebar({ tools, emptyState, nodeName }) {
  const [expanded, setExpanded] = useState(null);

  function renderSchema(schema) {
    if (!schema?.properties) return null;
    const req = new Set(schema.required || []);
    return Object.entries(schema.properties).map(([name, prop]) => (
      <div key={name} className="tool-schema__row">
        <div className="tool-schema__row-top">
          <span className="tool-schema__param">{name}</span>
          <span className="tool-schema__type">{prop.type || '?'}</span>
          <span className={req.has(name) ? 'tool-schema__req' : 'tool-schema__opt'}>
            {req.has(name) ? 'req' : 'opt'}
          </span>
        </div>
        {prop.description && (
          <div className="tool-schema__desc">{prop.description}</div>
        )}
      </div>
    ));
  }

  return (
    <div className="tool-sidebar">
      <div className="tool-sidebar__header">TOOLS [{tools.length}]</div>
      {emptyState === 'llm'
        ? <div className="tool-sidebar__empty-state">
            <span className="tool-sidebar__empty-label">{nodeName || 'LLM'}</span>
            <span className="tool-sidebar__empty-desc">LLM nodes execute prompts directly.{'\n'}No tool bindings at this layer.</span>
          </div>
        : tools.length === 0
          ? <div className="tool-sidebar__empty">— not available</div>
          : tools.map((t, i) => (
              <div key={i} className="tool-sidebar__item">
                <div
                  className="tool-sidebar__name"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  <span className="tool-sidebar__chevron">
                    {expanded === i ? '▾' : '▸'}
                  </span>
                  {t.name}
                </div>
                {expanded === i && (
                  <div className="tool-schema">
                    {t.description && (
                      <div className="tool-schema__desc-header">{t.description}</div>
                    )}
                    {renderSchema(t.inputSchema)}
                    {t.inputSchema && Object.keys(t.inputSchema.properties || {}).length === 0 && (
                      <div className="tool-schema__empty">no parameters</div>
                    )}
                    {!t.inputSchema && (
                      <div className="tool-schema__empty">no schema available</div>
                    )}
                  </div>
                )}
              </div>
            ))
      }
    </div>
  );
}

export function DungeonView({ sessionId, onExit }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [turnIdx, setTurnIdx] = useState(0);
  const [graphState, setGraphState] = useState({ groupIdx: 0, nodeIdx: 0 });
  const [detailMode, setDetailMode] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setSession(data);
        setTurnIdx(0);
        setGraphState({ groupIdx: 0, nodeIdx: 0 });
        setDetailMode(false);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [sessionId]);

  const turns = session?.turns || [];
  const currentTurn = turns[turnIdx] || null;
  const graph = currentTurn?.workflowGraph || null;
  const selectedGroup = graph?.groups[graphState.groupIdx] || null;
  const selectedNode = selectedGroup?.nodes[graphState.nodeIdx] || null;

  const onTurnChange = useCallback((delta) => {
    const newTurnIdx = turnIdx + delta;
    if (newTurnIdx < 0 || newTurnIdx >= turns.length) return;
    const newGraph = turns[newTurnIdx]?.workflowGraph || null;
    setTurnIdx(newTurnIdx);
    setGraphState(resolveGraphState(selectedNode, graphState.groupIdx, newGraph));
    // detailMode intentionally NOT reset — stay in whatever mode you were in
  }, [turnIdx, turns, selectedNode, graphState.groupIdx]);

  const onTurnSelect = useCallback((idx) => {
    if (idx < 0 || idx >= turns.length) return;
    setTurnIdx(idx);
    setGraphState(resolveGraphState(selectedNode, graphState.groupIdx, turns[idx]?.workflowGraph));
  }, [turns, selectedNode, graphState.groupIdx]);

  useKeyNav({
    groups: graph?.groups || [],
    groupIdx: graphState.groupIdx,
    nodeIdx: graphState.nodeIdx,
    setGraphState,
    onTurnChange,
    detailMode,
    onEnterDetail: () => setDetailMode(true),
    onExitDetail: () => setDetailMode(false),
    onExitSession: onExit,
  });

  const isLLMNode = selectedNode?.kind === 'UPSTREAM_LLM' ||
    selectedNode?.kind === 'DOWNSTREAM_LLM' ||
    selectedNode?.kind === 'PIPELINE_MEMBER';
  const leftPrompt = isLLMNode ? '' : session?.systemPrompt;
  const leftLabel = 'SYSTEM PROMPT';

  if (loading) return (
    <div className="center-msg">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div className="skeleton-row" style={{ border: 'none', justifyContent: 'center' }}>
          <div className="skeleton-cell skeleton-cell--lg" />
          <div className="skeleton-cell skeleton-cell--md" />
          <div className="skeleton-cell skeleton-cell--sm" />
        </div>
        <span className="text-dim">Loading session data</span>
      </div>
    </div>
  );
  if (error) return (
    <div className="error-state">
      <div className="error-state__icon">!</div>
      <div className="error-state__message">{error}</div>
      <div className="error-state__hint">Press ESC to return to session list</div>
    </div>
  );

  return (
    <div className="dungeon-view">
      <SystemPromptPanel prompt={leftPrompt} label={leftLabel} />
      <HUD
        sessionId={sessionId}
        turnIdx={turnIdx}
        turnCount={turns.length}
      />
      <div className="step-panel">
        {!detailMode
          ? <div className="step-panel__graph-wrap">
              <WorkflowGraph
                graph={graph}
                groupIdx={graphState.groupIdx}
                nodeIdx={graphState.nodeIdx}
                onNodeClick={(gIdx, nIdx) => {
                  setGraphState({ groupIdx: gIdx, nodeIdx: nIdx });
                  setDetailMode(true);
                }}
              />
              <TurnIOPanel turn={currentTurn} />
              <WorkflowMinimap
                graph={graph}
                groupIdx={graphState.groupIdx}
                nodeIdx={graphState.nodeIdx}
                onNodeSelect={(gIdx, nIdx) => setGraphState({ groupIdx: gIdx, nodeIdx: nIdx })}
              />
            </div>
          : <div className="step-panel__detail-wrap">
              <div className="step-panel__detail-scroll">
                <NodeDetailView node={selectedNode} />
              </div>
              <WorkflowMinimap
                graph={graph}
                groupIdx={graphState.groupIdx}
                nodeIdx={graphState.nodeIdx}
                onNodeSelect={(gIdx, nIdx) => setGraphState({ groupIdx: gIdx, nodeIdx: nIdx })}
              />
            </div>
        }
      </div>
      {isLLMNode
        ? <ToolDirectorySidebar tools={[]} emptyState="llm" nodeName={selectedNode?.label} />
        : <ToolDirectorySidebar tools={session?.availableTools || []} />
      }
      <TimelineBar
        turns={turns}
        turnIdx={turnIdx}
        onTurnSelect={onTurnSelect}
        detailMode={detailMode}
      />
    </div>
  );
}
