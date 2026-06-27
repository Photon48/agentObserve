// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
// Render-unit pre-pass.
//
// Transforms the AGENT step's flat block stream into a list of typed render
// units that the FE can map 1:1 to components. Unit types:
//
//   text            — THOUGHT, TEXT, AGENT_RESPONSE singletons
//   tool-pair       — TOOL_USE paired with its matching TOOL_RESULT
//   sub-agent       — TOOL_USE whose id matches a promoted AGENT-kind node
//   parallel        — N tool-pair / sub-agent units sharing a parallelGroup id
//                     (i.e. emitted by ONE LLM call); rendered as one carousel
//   llm-timing      — small inline timing row inserted before each new
//                     generation group (preserves existing StepPanel layout)
//   orphan-tool-use — TOOL_USE without a matching TOOL_RESULT (still shown)
//   orphan-tool-result — TOOL_RESULT not consumed by any prior TOOL_USE
//
// Coalescing rule: tool-pair / sub-agent units coalesce into a parallel unit
// whenever ≥2 of them share a parallelGroup id — the backend's per-response
// signal for "two or more tools called in one LLM call". Adjacency does NOT
// matter: an intervening THOUGHT/TEXT (Anthropic interleaved thinking) no
// longer breaks the group. We never reorder or drop those text blocks; the
// carousel takes the first member's slot and absorbed members are removed.

function findToolResultIndex(blocks, startIdx, useId) {
  for (let k = startIdx + 1; k < blocks.length; k++) {
    if (blocks[k].type === 'TOOL_RESULT' && blocks[k].id === useId) return k;
  }
  return -1;
}

export function buildRenderUnits(blocks, ctx = {}) {
  const {
    toolNodeByToolUseId = {},
    subAgentByToolUseId = {},
    llmTimings = [],
  } = ctx;
  const safe = Array.isArray(blocks) ? blocks : [];

  // ── Pass 1: atoms (linear, no coalescing yet) ────────────────────────────
  const consumed = new Set(); // indices of TOOL_RESULT blocks already paired
  const atoms = [];
  let llmIdx = 0;
  let inGenGroup = false;
  // Model name of the LLM_CALL that produced the current generation group.
  // Used so TextBlock can render "◆ <actual-model>" instead of a hardcoded
  // CLAUDE label — necessary for LangChain pipelines that mix providers.
  let currentModel = '';

  for (let i = 0; i < safe.length; i++) {
    const b = safe[i];
    const isGen = b.type === 'THOUGHT' || b.type === 'TEXT' || b.type === 'AGENT_RESPONSE';

    if (isGen && !inGenGroup) {
      if (llmIdx < llmTimings.length) {
        const timing = llmTimings[llmIdx++];
        currentModel = timing?.model || '';
        atoms.push({ type: 'llm-timing', node: timing, key: `llm-${llmIdx}` });
      }
      inGenGroup = true;
    } else if (!isGen) {
      inGenGroup = false;
    }

    if (isGen) {
      atoms.push({ type: 'text', block: b, model: currentModel, key: `t-${i}` });
      continue;
    }

    if (b.type === 'TOOL_USE') {
      const useId = b.id;
      const agentNode = subAgentByToolUseId[useId];
      const toolNode = toolNodeByToolUseId[useId];
      const resultIdx = findToolResultIndex(safe, i, useId);
      const resultBlock = resultIdx >= 0 ? safe[resultIdx] : null;
      if (resultIdx >= 0) consumed.add(resultIdx);

      if (agentNode) {
        atoms.push({
          type: 'sub-agent',
          useBlock: b,
          resultBlock,
          agentNode,
          parallelGroup: agentNode.parallelGroup || null,
          parallelIndex: agentNode.parallelIndex,
          parallelSiblingNames: agentNode.parallelSiblingNames || null,
          key: `sa-${i}`,
        });
      } else if (resultBlock) {
        atoms.push({
          type: 'tool-pair',
          useBlock: b,
          resultBlock,
          toolNode: toolNode || null,
          parallelGroup: toolNode?.parallelGroup || null,
          parallelIndex: toolNode?.parallelIndex,
          parallelSiblingNames: toolNode?.parallelSiblingNames || null,
          key: `tp-${i}`,
        });
      } else {
        atoms.push({
          type: 'orphan-tool-use',
          useBlock: b,
          toolNode: toolNode || null,
          key: `otu-${i}`,
        });
      }
      continue;
    }

    if (b.type === 'TOOL_RESULT') {
      if (!consumed.has(i)) {
        atoms.push({ type: 'orphan-tool-result', block: b, key: `otr-${i}` });
      }
      continue;
    }
  }

  // ── Pass 2: coalesce same-parallelGroup atoms into parallel units ────────
  return coalesceParallelUnits(atoms);
}

function memberDisplayName(atom) {
  if (atom.type === 'tool-pair') return atom.toolNode?.toolName || atom.useBlock?.name || 'tool';
  if (atom.type === 'sub-agent') return atom.agentNode?.agentName || 'subagent';
  return '';
}

// Coalesce tool-pair / sub-agent atoms that share a parallelGroup id into a
// single `parallel` unit — the backend stamps that id per LLM response, so a
// shared id means "≥2 tools dispatched in one LLM call". Adjacency-independent:
// members are bucketed by id across the whole stream, so interleaved THOUGHT/
// TEXT atoms no longer split a batch. The carousel takes the FIRST member's
// slot; absorbed members are removed; every non-member atom passes through in
// place. Members render in model-emitted order (parallelIndex) when present so
// they line up positionally with parallelSiblingNames.
function coalesceParallelUnits(atoms) {
  // Bucket members by parallelGroup id, keeping their stream index.
  const buckets = new Map(); // gid -> [{ atom, idx }]
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if ((a.type === 'tool-pair' || a.type === 'sub-agent') && a.parallelGroup) {
      const arr = buckets.get(a.parallelGroup) || [];
      arr.push({ atom: a, idx: i });
      buckets.set(a.parallelGroup, arr);
    }
  }

  // Decide which atoms get absorbed and where each parallel unit anchors.
  const parallelByAnchor = new Map(); // anchor stream idx -> parallel unit
  const absorbed = new Set();          // stream indices folded into a carousel
  for (const [gid, entries] of buckets) {
    if (entries.length < 2) continue; // a lone member stays a plain tool-pair
    const allIndexed = entries.every((e) => Number.isInteger(e.atom.parallelIndex));
    const ordered = entries
      .slice()
      .sort((a, b) => (allIndexed ? a.atom.parallelIndex - b.atom.parallelIndex : a.idx - b.idx));
    const members = ordered.map((e) => e.atom);
    const anchor = Math.min(...entries.map((e) => e.idx));
    parallelByAnchor.set(anchor, {
      type: 'parallel',
      members,
      parallelGroup: gid,
      siblings: members[0].parallelSiblingNames || members.map(memberDisplayName),
      key: `pg-${gid}`,
    });
    for (const e of entries) absorbed.add(e.idx);
  }

  // Emit in original order: parallel unit at its anchor slot, others dropped,
  // every non-member atom untouched.
  const units = [];
  for (let i = 0; i < atoms.length; i++) {
    if (parallelByAnchor.has(i)) {
      units.push(parallelByAnchor.get(i));
    } else if (!absorbed.has(i)) {
      units.push(atoms[i]);
    }
  }
  return units;
}

// Cascade-fallback variant: when capturedBlocks is empty we synthesize
// tool-pair atoms straight from the AgentNodes themselves (input/output
// strings already on TOOL nodes). Lets the cascade path reuse ToolPair +
// ParallelCarousel components without diverging.

export function buildRenderUnitsFromNodes(nodes, onZoomCb = null) {
  const list = Array.isArray(nodes) ? nodes : [];
  const atoms = [];

  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!n) continue;

    if (n.kind === 'LLM_CALL') {
      // Emit the same boundary + text-unit shape buildRenderUnits produces so
      // groupRenderUnits folds both paths identically into per-call blocks.
      atoms.push({
        type: 'llm-timing',
        node: {
          durationMs: n.durationMs,
          ttftMs: n.ttftMs,
          model: n.model,
          inputTokens: n.inputTokens,
          outputTokens: n.outputTokens,
          cacheReadTokens: n.cacheReadTokens,
          cacheCreationTokens: n.cacheCreationTokens,
          stopReason: n.stopReason,
          costUsd: n.costUsd,
        },
        key: `cl-${i}`,
      });
      const inlineBlocks = (n.blocks || []).filter(
        (b) => b.type === 'THOUGHT' || b.type === 'TEXT' || b.type === 'AGENT_RESPONSE',
      );
      for (let bi = 0; bi < inlineBlocks.length; bi++) {
        atoms.push({ type: 'text', block: inlineBlocks[bi], model: n.model, key: `cl-${i}-b${bi}` });
      }
    } else if (n.kind === 'HOOK') {
      atoms.push({ type: 'cascade-hook', node: n, key: `ch-${i}` });
    } else if (n.kind === 'TOOL') {
      // Synthesize a tool-pair atom using the node's own input/output.
      let inputObj = {};
      try { inputObj = n.toolInput ? JSON.parse(n.toolInput) : {}; } catch { inputObj = n.toolInput || ''; }
      const useBlock = {
        type: 'TOOL_USE',
        id: n.toolUseId || `_${i}`,
        name: n.toolName,
        input: inputObj,
        tokens: n.callTokens ?? null,
      };
      const errText = n.error || '';
      const ok = !errText && n.success !== false;
      const resultBlock = {
        type: 'TOOL_RESULT',
        id: useBlock.id,
        name: n.toolName,
        text: n.toolOutput || '',
        success: ok,
        errorText: errText,
        durationMs: n.durationMs || 0,
        tokens: n.resultTokens ?? null,
        is_error: !ok || undefined,
      };
      atoms.push({
        type: 'tool-pair',
        useBlock,
        resultBlock,
        toolNode: n,
        parallelGroup: n.parallelGroup || null,
        parallelIndex: n.parallelIndex,
        parallelSiblingNames: n.parallelSiblingNames || null,
        key: `tp-${i}`,
      });
    } else if (n.kind === 'AGENT') {
      // Synthesize a sub-agent atom — input is the spawning toolInput when
      // we have it, output is "" (the SubAgentPair component derives the
      // last response from agentNode.nodes itself).
      const useBlock = {
        type: 'TOOL_USE',
        id: n.toolUseId || `_sa_${i}`,
        name: 'Agent',
        input: {},
      };
      atoms.push({
        type: 'sub-agent',
        useBlock,
        resultBlock: null,
        agentNode: n,
        parallelGroup: n.parallelGroup || null,
        parallelIndex: n.parallelIndex,
        parallelSiblingNames: n.parallelSiblingNames || null,
        key: `sa-${i}`,
      });
    }
  }

  // Same coalescing pass as buildRenderUnits.
  return coalesceParallelUnits(atoms);
}
