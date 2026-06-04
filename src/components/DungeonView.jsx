import { useState, useEffect, useCallback, useRef } from 'react';
import { HUD } from './HUD.jsx';
import { WorkflowGraph } from './WorkflowGraph.jsx';
import { StackedDetail } from './StackedDetail.jsx';
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

const SIDEBAR_MODES = ['collapsed', 'default', 'wide'];

function stepSidebarMode(mode, delta) {
  const i = SIDEBAR_MODES.indexOf(mode);
  const next = Math.max(0, Math.min(SIDEBAR_MODES.length - 1, i + delta));
  return SIDEBAR_MODES[next];
}

function PanelHeader({ label, mode, onStep, side = 'left' }) {
  const atMin = mode === 'collapsed';
  const atMax = mode === 'wide';
  // Arrows always point in their literal direction; the *meaning* flips for the
  // right-side panel because "grow" there means expanding leftward (into the
  // workspace) and "shrink" means collapsing rightward (toward the wall).
  const shrinkGlyph = side === 'right' ? '»' : '«';
  const growGlyph   = side === 'right' ? '«' : '»';
  // Visual order also flips so the "into the workspace" arrow sits closer to
  // the workspace edge on both sides.
  const buttons = [
    <button
      key="shrink"
      type="button"
      className="panel-stepper panel-stepper--shrink"
      aria-label={`Shrink ${label}`}
      aria-disabled={atMin}
      title="Shrink panel"
      onClick={() => { if (!atMin) onStep(-1); }}
    >{shrinkGlyph}</button>,
    <button
      key="grow"
      type="button"
      className="panel-stepper panel-stepper--grow"
      aria-label={`Expand ${label}`}
      aria-disabled={atMax}
      title="Expand panel"
      onClick={() => { if (!atMax) onStep(+1); }}
    >{growGlyph}</button>,
  ];
  return (
    <div className="panel-header">
      <span className="panel-rail">{label}</span>
      <span className="panel-header__label">{label}</span>
      <span className="panel-header__steppers">
        {side === 'right' ? [buttons[1], buttons[0]] : buttons}
      </span>
    </div>
  );
}

function SystemPromptPanel({ prompt, label, mode, onStep }) {
  return (
    <div className="sysprompt-panel">
      <PanelHeader label={label} mode={mode} onStep={onStep} />
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

function ToolDirectorySidebar({ tools, emptyState, nodeName, mode, onStep }) {
  const [expanded, setExpanded] = useState(null);
  // Expand state for nested schema rows — keyed by dot-path so each level
  // is independent. Generic over any JSON Schema shape.
  const [openPaths, setOpenPaths] = useState(() => new Set());

  function togglePath(p) {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function typeLabel(prop) {
    if (!prop) return '?';
    if (prop.type === 'array' && prop.items?.type) return `array<${prop.items.type}>`;
    return prop.type || '?';
  }

  function hasChildren(prop) {
    if (!prop) return false;
    if (prop.type === 'object' && prop.properties) return true;
    if (prop.type === 'array' && prop.items?.properties) return true;
    return false;
  }

  function renderRow(name, prop, required, path) {
    const expandable = hasChildren(prop);
    const open = openPaths.has(path);
    return (
      <div key={path} className="tool-schema__row">
        <div
          className={`tool-schema__row-top${expandable ? ' tool-schema__row-top--clickable' : ''}`}
          onClick={expandable ? () => togglePath(path) : undefined}
        >
          <span className="tool-schema__chevron" aria-hidden="true">
            {expandable ? (open ? '▾' : '▸') : ''}
          </span>
          <span className="tool-schema__param">{name}</span>
          <span className="tool-schema__meta">
            <span className="tool-schema__type">{typeLabel(prop)}</span>
            <span className={required ? 'tool-schema__req' : 'tool-schema__opt'}>
              {required ? 'req' : 'opt'}
            </span>
          </span>
        </div>
        {prop.description && (
          <div className="tool-schema__desc">{prop.description}</div>
        )}
        {expandable && open && (
          <div className="tool-schema__nested">
            {prop.type === 'object' && renderProperties(prop, path)}
            {prop.type === 'array' && renderProperties(prop.items, `${path}[]`)}
          </div>
        )}
      </div>
    );
  }

  function renderProperties(schema, path) {
    if (!schema?.properties) return null;
    const req = new Set(schema.required || []);
    return Object.entries(schema.properties).map(([name, prop]) =>
      renderRow(name, prop, req.has(name), `${path}.${name}`)
    );
  }

  function renderSchema(schema) {
    return renderProperties(schema, '');
  }

  return (
    <div className="tool-sidebar">
      <PanelHeader label={`TOOLS [${tools.length}]`} mode={mode} onStep={onStep} side="right" />
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
                    {t.inputSchema && Object.keys(t.inputSchema.properties || {}).length > 0 && (
                      <>
                        <div className="tool-schema__eyebrow">PARAMETERS</div>
                        <div className="tool-schema__params">
                          {renderSchema(t.inputSchema)}
                        </div>
                      </>
                    )}
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

// Detail view model:
//   - `detailMode: boolean` — are we zoomed in past the workflow graph?
//   - `subAgentStack: Array<{ agentStep, label }>` — extra zoom levels
//     stacked on top of the workflow-node detail.
//
// Level 1 (workflow-node detail) is NOT stored explicitly — it always
// derives from the current `selectedNode` (driven by graphState). That
// way arrow-key navigation (which mutates graphState) updates the
// level-1 view live, exactly like the old single-boolean detailMode did.
//
// Sub-agent zooms (level 2+) are snapshots — they capture the specific
// agentStep the user clicked into, independent of workflow selection.
function makeSubAgentEntry(agentNode) {
  return {
    kind: 'subagent',
    agentStep: { type: 'AGENT', nodes: agentNode.nodes || [], capturedBlocks: null, userPrompt: '' },
    label: agentNode.agentName ? `SUB-AGENT · ${agentNode.agentName}` : 'SUB-AGENT',
  };
}
function detailLabelFromWorkflowNode(node) {
  if (!node) return '';
  if (node.kind === 'AGENT') return 'AGENT DETAIL';
  if (node.kind === 'UPSTREAM_LLM') return 'UPSTREAM LLM';
  if (node.kind === 'DOWNSTREAM_LLM') return 'DOWNSTREAM LLM';
  return (node.label || node.kind || '').toUpperCase();
}

export function DungeonView({ sessionId, onExit }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [turnIdx, setTurnIdx] = useState(0);
  const [graphState, setGraphState] = useState({ groupIdx: 0, nodeIdx: 0 });
  // Are we zoomed in past the workflow graph? Live level-1 detail derives
  // from selectedNode; sub-agent zooms layer on top in subAgentStack.
  const [detailMode, setDetailMode] = useState(false);
  const [subAgentStack, setSubAgentStack] = useState([]);
  const [sysMode, setSysMode] = useState(() => {
    if (typeof window === 'undefined') return 'default';
    const stored = window.localStorage.getItem('ao.sysprompt.mode');
    return SIDEBAR_MODES.includes(stored) ? stored : 'default';
  });
  const [toolsMode, setToolsMode] = useState(() => {
    if (typeof window === 'undefined') return 'default';
    const stored = window.localStorage.getItem('ao.tools.mode');
    return SIDEBAR_MODES.includes(stored) ? stored : 'default';
  });

  useEffect(() => {
    try { window.localStorage.setItem('ao.sysprompt.mode', sysMode); } catch {}
  }, [sysMode]);
  useEffect(() => {
    try { window.localStorage.setItem('ao.tools.mode', toolsMode); } catch {}
  }, [toolsMode]);

  const stepSys = useCallback((delta) => {
    setSysMode((m) => stepSidebarMode(m, delta));
  }, []);
  const stepTools = useCallback((delta) => {
    setToolsMode((m) => stepSidebarMode(m, delta));
  }, []);

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
        setSubAgentStack([]);
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

  const onZoomIntoSubAgent = useCallback((agentNode) => {
    setSubAgentStack((prev) => [...prev, makeSubAgentEntry(agentNode)]);
  }, []);
  const onExitDetail = useCallback(() => {
    // Pop one sub-agent level if any are open, else leave detail mode.
    if (subAgentStack.length > 0) {
      setSubAgentStack((prev) => prev.slice(0, -1));
    } else {
      setDetailMode(false);
    }
  }, [subAgentStack.length]);

  const onTurnChange = useCallback((delta) => {
    const newTurnIdx = turnIdx + delta;
    if (newTurnIdx < 0 || newTurnIdx >= turns.length) return;
    const newGraph = turns[newTurnIdx]?.workflowGraph || null;
    setTurnIdx(newTurnIdx);
    setGraphState(resolveGraphState(selectedNode, graphState.groupIdx, newGraph));
    // Sub-agent zooms collapse — they're scoped to the previous turn.
    // detailMode is preserved so the user stays in the detail view of
    // the resolved node in the new turn.
    setSubAgentStack([]);
  }, [turnIdx, turns, selectedNode, graphState.groupIdx]);

  const onTurnSelect = useCallback((idx) => {
    if (idx < 0 || idx >= turns.length) return;
    setTurnIdx(idx);
    setGraphState(resolveGraphState(selectedNode, graphState.groupIdx, turns[idx]?.workflowGraph));
    setSubAgentStack([]);
  }, [turns, selectedNode, graphState.groupIdx]);

  useKeyNav({
    groups: graph?.groups || [],
    groupIdx: graphState.groupIdx,
    nodeIdx: graphState.nodeIdx,
    setGraphState,
    onTurnChange,
    detailMode,
    onEnterDetail: () => setDetailMode(true),
    onExitDetail,
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
    <div className="dungeon-view" data-sysprompt={sysMode} data-tools={toolsMode}>
      <SystemPromptPanel
        prompt={leftPrompt}
        label={leftLabel}
        mode={sysMode}
        onStep={stepSys}
      />
      <HUD
        sessionId={sessionId}
        turnIdx={turnIdx}
        turnCount={turns.length}
        turn={currentTurn}
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
              <StackedDetail
                // Level 1 is the live workflow-node detail (selectedNode
                // changes with arrow keys); sub-agent zooms layer on top.
                stack={[
                  {
                    kind: 'detail',
                    workflowNode: selectedNode,
                    label: detailLabelFromWorkflowNode(selectedNode),
                  },
                  ...subAgentStack,
                ]}
                onZoomIntoSubAgent={onZoomIntoSubAgent}
                onPop={onExitDetail}
              />
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
        ? <ToolDirectorySidebar
            tools={[]}
            emptyState="llm"
            nodeName={selectedNode?.label}
            mode={toolsMode}
            onStep={stepTools}
          />
        : <ToolDirectorySidebar
            tools={session?.availableTools || []}
            mode={toolsMode}
            onStep={stepTools}
          />
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
