// Builds the nested-treemap data the minimap renders.
//
// The workflow level is a flat row of WorkflowItems. Each item is either a
// `CELL` (LLM, pipeline member, etc.) or a `SLAB` (an AGENT). Inside a SLAB,
// only AGENT-kind children appear — LLM_CALL / TOOL / HOOK are intentionally
// dropped because the minimap is about agent containment, not the agent's
// inner work (which the detail view already shows).
//
// Children inside a slab are laid out as columns. Sequential siblings sit in
// adjacent columns left-to-right by start time; parallel siblings (overlapping
// startTime/endTime) stack vertically inside the same column. Each column is
// a parallel cluster from `clusterAgentsByOverlap`.
//
// Each slab keeps a reference to its original AgentNode (`_agentNode`) so the
// renderer can find "you are here" by reference-equality against
// `subAgentStack[i].agentStep.nodes` — that's the same array that
// `makeSubAgentEntry` in DungeonView passes through.

function parseTime(t) {
  if (!t) return 0;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : 0;
}

function labelForAgent(node) {
  return node.agentName || node.agentType || 'agent';
}

function clusterAgentsByOverlap(siblings, prefix) {
  if (!Array.isArray(siblings) || siblings.length === 0) return [];

  // Keep origIdx into the unfiltered .nodes array so paths stay stable and
  // reference equality with subAgentStack[i].agentStep.nodes still works.
  const agentEntries = [];
  for (let i = 0; i < siblings.length; i++) {
    const node = siblings[i];
    if (node && node.kind === 'AGENT') {
      agentEntries.push({
        node,
        origIdx: i,
        start: parseTime(node.startTime),
        end: parseTime(node.endTime),
      });
    }
  }
  if (agentEntries.length === 0) return [];

  const sorted = [...agentEntries].sort((a, b) => a.start - b.start);

  // Sweep into temporal-overlap clusters.
  const clusters = [];
  let current = [];
  let maxEnd = -Infinity;
  for (const item of sorted) {
    if (current.length === 0 || item.start <= maxEnd) {
      current.push(item);
      if (item.end > maxEnd) maxEnd = item.end;
    } else {
      clusters.push(current);
      current = [item];
      maxEnd = item.end;
    }
  }
  if (current.length) clusters.push(current);

  // Order clusters by earliest start so columns flow left-to-right by time.
  clusters.sort((a, b) => Math.min(...a.map((x) => x.start)) - Math.min(...b.map((x) => x.start)));

  return clusters.map((cluster) =>
    cluster.map((item) => slabFromAgentNode(item.node, [...prefix, item.origIdx]))
  );
}

function slabFromAgentNode(node, path) {
  const columns = clusterAgentsByOverlap(node.nodes || [], path);
  return {
    id: path.join('.'),
    path,
    agentName: node.agentName || '',
    label: labelForAgent(node),
    durationMs: node.durationMs || 0,
    startTime: node.startTime || '',
    endTime: node.endTime || '',
    columns,
    isLeaf: columns.length === 0,
    _agentNode: node,
  };
}

function indexSlab(slab, map) {
  map.set(slab.id, slab);
  for (const col of slab.columns) {
    for (const child of col) indexSlab(child, map);
  }
}

export function buildAgentTree(turn) {
  if (!turn?.workflowGraph?.groups?.length) {
    return { workflowItems: [], slabIndex: new Map() };
  }

  const workflowItems = [];
  const slabIndex = new Map();
  const groups = turn.workflowGraph.groups;

  for (let g = 0; g < groups.length; g++) {
    for (let n = 0; n < groups[g].nodes.length; n++) {
      const wfNode = groups[g].nodes[n];
      const path = [g, n];

      if (wfNode.kind === 'AGENT') {
        const agentChildren = wfNode.agentStepData?.nodes || [];
        const columns = clusterAgentsByOverlap(agentChildren, path);
        const slab = {
          kind: 'SLAB',
          id: path.join('.'),
          path,
          wfKind: 'AGENT',
          label: wfNode.label || labelForAgent(wfNode) || 'agent',
          agentName: wfNode.agentStepData?.agentName || '',
          durationMs: wfNode.durationMs || 0,
          columns,
          isLeaf: columns.length === 0,
          // Wrap in a small object so the same reference-equality trick
          // applies at the workflow level: subAgentStack[0].agentStep.nodes
          // === wfNode.agentStepData.nodes (same array reference).
          _agentNode: { nodes: agentChildren },
        };
        workflowItems.push(slab);
        indexSlab(slab, slabIndex);
      } else {
        workflowItems.push({
          kind: 'CELL',
          id: path.join('.'),
          path,
          wfKind: wfNode.kind,
          label: wfNode.label || (wfNode.kind || '').toLowerCase(),
          durationMs: wfNode.durationMs || 0,
        });
      }
    }
  }

  return { workflowItems, slabIndex };
}

export function findFocusedSlabId(workflowItems, groupIdx, nodeIdx, subAgentStack) {
  const root = workflowItems.find((it) => it.path[0] === groupIdx && it.path[1] === nodeIdx);
  if (!root || root.kind !== 'SLAB') return null;

  let current = root;
  const stack = subAgentStack || [];
  for (let i = 0; i < stack.length; i++) {
    const targetNodes = stack[i]?.agentStep?.nodes;
    if (!targetNodes) break;
    let next = null;
    for (const col of current.columns) {
      for (const child of col) {
        if (child._agentNode && child._agentNode.nodes === targetNodes) {
          next = child;
          break;
        }
      }
      if (next) break;
    }
    if (!next) break;
    current = next;
  }
  return current.id;
}

export function collectAncestorIds(workflowItems, focusedSlabId) {
  if (!focusedSlabId) return new Set();
  // Walk the workflow items and DFS down each SLAB collecting parent chain.
  const ancestors = new Set();
  function dfs(slab, chain) {
    if (slab.id === focusedSlabId) {
      for (const id of chain) ancestors.add(id);
      return true;
    }
    for (const col of slab.columns) {
      for (const child of col) {
        if (dfs(child, [...chain, slab.id])) return true;
      }
    }
    return false;
  }
  for (const item of workflowItems) {
    if (item.kind !== 'SLAB') continue;
    if (dfs(item, [])) return ancestors;
  }
  return ancestors;
}
