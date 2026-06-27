// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
//
// Call-grouping pass.
//
// Both render-unit builders (buildRenderUnits / buildRenderUnitsFromNodes)
// emit a flat stream where each LLM call begins with an `llm-timing` unit
// followed by the generation blocks (THOUGHT/TEXT/AGENT_RESPONSE) and the
// tool calls (tool-pair / sub-agent / parallel) that call produced. This
// pass folds that flat stream into one group per LLM call so the agent view
// can render each call as a single enclosed block — "everything that happens
// in one LLM call (thinking / text / tool call(s)) in one block".
//
// A group is { key, llm, callIndex, units }:
//   - `llm`        the llm-timing node carrying the call's exact token figures,
//                  or null for the leading group (units that precede the first
//                  call — orphan tool results, etc.)
//   - `callIndex`  0-based position among real calls (−1 for the leading group)
//   - `units`      the body render units for the call (the boundary llm-timing
//                  unit is consumed into `llm`, not repeated in the body)

export function groupRenderUnits(units) {
  const safe = Array.isArray(units) ? units : [];
  const groups = [];
  let current = null;
  let callIndex = -1;

  for (const u of safe) {
    if (u.type === 'llm-timing') {
      callIndex += 1;
      current = { key: u.key, llm: u.node, callIndex, units: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      // Units before the first call boundary — keep them in a header-less
      // leading group so nothing is dropped.
      current = { key: 'lead', llm: null, callIndex: -1, units: [] };
      groups.push(current);
    }
    current.units.push(u);
  }

  return groups;
}

// Derive the per-call token figures the meters + spectrum read from. The
// model "saw" context = fresh input + cache-read + cache-write (mirrors the
// LLMTimingRow / FINAL math). Returns null for the header-less leading group.
export function callStats(group) {
  const n = group?.llm;
  if (!n) return null;
  const fresh = n.inputTokens || 0;
  const cacheRead = n.cacheReadTokens || 0;
  const cacheCreation = n.cacheCreationTokens || 0;
  const contextIn = fresh + cacheRead + cacheCreation;
  const out = n.outputTokens || 0;
  return {
    callIndex: group.callIndex,
    model: n.model || '',
    fresh,
    cacheRead,
    cacheCreation,
    contextIn,
    out,
    total: contextIn + out,
    cachePct: contextIn > 0 ? Math.round((cacheRead / contextIn) * 100) : 0,
    durationMs: n.durationMs || 0,
    ttftMs: n.ttftMs || 0,
    stopReason: n.stopReason || '',
    costUsd: n.costUsd || 0,
  };
}

// Duration breakdown for one call group. Within a single agent calls are
// strictly sequential (an agent is an LLM in a loop), so the wall-clock time a
// call "cost" is its own model latency PLUS the tools it then dispatched before
// the next call could start. Parallel tool batches are dispatched together, so
// their wall-clock is the slowest member (max), not the sum; sequential tool
// calls add. Returns { llmMs, toolMs, totalMs } so the collapsed block can show
// the combined total and the expanded block can show the split. The per-call
// totals tile the agent's own duration.
export function callDurations(group) {
  const llmMs = group?.llm?.durationMs || 0;
  let toolMs = 0;
  for (const u of group?.units || []) toolMs += unitWallMs(u);
  return { llmMs, toolMs, totalMs: llmMs + toolMs };
}

function atomWallMs(a) {
  if (!a) return 0;
  if (a.type === 'tool-pair' || a.type === 'orphan-tool-use') {
    return a.resultBlock?.durationMs || a.toolNode?.durationMs || 0;
  }
  if (a.type === 'sub-agent') return a.agentNode?.durationMs || 0;
  return 0;
}

function unitWallMs(u) {
  if (u.type === 'parallel') {
    // one LLM response → these ran concurrently; wall-clock is the slowest.
    let mx = 0;
    for (const m of u.members || []) mx = Math.max(mx, atomWallMs(m));
    return mx;
  }
  return atomWallMs(u);
}

// Inline text preview for the collapsed block. Surfaces what the call actually
// said — its assistant text / final response — so an operator can read the
// purpose of each step in the LLM loop without expanding it. Falls back to the
// model's (unredacted) reasoning when a call produced no output text, since a
// pure-reasoning-then-tool call still has a stated intent worth seeing.
// Returns { text, thought }: at most one is non-empty (text wins).
export function callPreview(group) {
  let text = '';
  let thought = '';
  for (const u of group?.units || []) {
    if (u.type !== 'text' || !u.block) continue;
    const b = u.block;
    if (b.type === 'TEXT' || b.type === 'AGENT_RESPONSE') {
      if (b.text) text += (text ? '\n' : '') + b.text;
    } else if (b.type === 'THOUGHT' && !b.redacted && b.text) {
      thought += (thought ? '\n' : '') + b.text;
    }
  }
  text = text.trim();
  thought = thought.trim();
  return text ? { text, thought: '' } : { text: '', thought };
}

// Compact summary of what one call produced, for the collapsed block's content
// row: did it emit reasoning / text, and which tools it dispatched (aggregated
// by name, repeats counted, parallel batches flagged). Tool order of first
// appearance is preserved. Sub-agents are marked so the FE can badge them.
export function callManifest(group) {
  let hasThought = false;
  let hasText = false;
  const tools = new Map(); // name -> { name, count, isAgent, parallel }
  const add = (rawName, isAgent, parallel) => {
    const name = rawName || (isAgent ? 'subagent' : 'tool');
    const cur = tools.get(name) || { name, count: 0, isAgent, parallel: false };
    cur.count += 1;
    cur.parallel = cur.parallel || parallel;
    tools.set(name, cur);
  };
  const fromAtom = (a, parallel) => {
    if (a.type === 'sub-agent') add(a.agentNode?.agentName, true, parallel);
    else add(a.toolNode?.toolName || a.useBlock?.name, false, parallel);
  };
  for (const u of group?.units || []) {
    if (u.type === 'text') {
      if (u.block?.type === 'THOUGHT') hasThought = true;
      else hasText = true; // TEXT or AGENT_RESPONSE
    } else if (u.type === 'parallel') {
      for (const m of u.members || []) fromAtom(m, true);
    } else if (u.type === 'tool-pair' || u.type === 'orphan-tool-use' || u.type === 'sub-agent') {
      fromAtom(u, false);
    }
  }
  return { hasThought, hasText, tools: [...tools.values()] };
}

