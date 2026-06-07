// Render-unit pre-pass.
//
// Transforms the AGENT step's flat block stream into a list of typed render
// units that the FE can map 1:1 to components. Unit types:
//
//   text            — THOUGHT, TEXT, AGENT_RESPONSE singletons
//   tool-pair       — TOOL_USE paired with its matching TOOL_RESULT
//   sub-agent       — TOOL_USE whose id matches a promoted AGENT-kind node
//   parallel        — N consecutive tool-pair / sub-agent units sharing a
//                     parallelGroup id; rendered as a single carousel frame
//   llm-timing      — small inline timing row inserted before each new
//                     generation group (preserves existing StepPanel layout)
//   orphan-tool-use — TOOL_USE without a matching TOOL_RESULT (still shown)
//   orphan-tool-result — TOOL_RESULT not consumed by any prior TOOL_USE
//
// Coalescing rule: tool-pair / sub-agent units only coalesce into a parallel
// unit when they're CONSECUTIVE. An intervening THOUGHT or TEXT breaks the
// group — we never reorder blocks to fit a parallel frame.

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

  // ── Pass 2: coalesce consecutive same-parallelGroup atoms ────────────────
  const units = [];
  for (let i = 0; i < atoms.length; ) {
    const a = atoms[i];
    if ((a.type === 'tool-pair' || a.type === 'sub-agent') && a.parallelGroup) {
      const gid = a.parallelGroup;
      const members = [a];
      let j = i + 1;
      while (j < atoms.length) {
        const next = atoms[j];
        if ((next.type === 'tool-pair' || next.type === 'sub-agent') && next.parallelGroup === gid) {
          members.push(next);
          j++;
        } else break;
      }
      if (members.length >= 2) {
        units.push({
          type: 'parallel',
          members,
          parallelGroup: gid,
          siblings: a.parallelSiblingNames || members.map(memberDisplayName),
          key: `pg-${gid}`,
        });
        i = j;
        continue;
      }
    }
    units.push(a);
    i++;
  }

  return units;
}

function memberDisplayName(atom) {
  if (atom.type === 'tool-pair') return atom.toolNode?.toolName || atom.useBlock?.name || 'tool';
  if (atom.type === 'sub-agent') return atom.agentNode?.agentName || 'subagent';
  return '';
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
      atoms.push({ type: 'cascade-llm', node: n, key: `cl-${i}` });
    } else if (n.kind === 'HOOK') {
      atoms.push({ type: 'cascade-hook', node: n, key: `ch-${i}` });
    } else if (n.kind === 'TOOL') {
      // Synthesize a tool-pair atom using the node's own input/output.
      let inputObj = {};
      try { inputObj = n.toolInput ? JSON.parse(n.toolInput) : {}; } catch { inputObj = n.toolInput || ''; }
      const useBlock = { type: 'TOOL_USE', id: n.toolUseId || `_${i}`, name: n.toolName, input: inputObj };
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
        is_error: !ok || undefined,
      };
      atoms.push({
        type: 'tool-pair',
        useBlock,
        resultBlock,
        toolNode: n,
        parallelGroup: n.parallelGroup || null,
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
        parallelSiblingNames: n.parallelSiblingNames || null,
        key: `sa-${i}`,
      });
    }
  }

  // Same coalescing pass as buildRenderUnits.
  const units = [];
  for (let i = 0; i < atoms.length; ) {
    const a = atoms[i];
    if ((a.type === 'tool-pair' || a.type === 'sub-agent') && a.parallelGroup) {
      const gid = a.parallelGroup;
      const members = [a];
      let j = i + 1;
      while (j < atoms.length) {
        const next = atoms[j];
        if ((next.type === 'tool-pair' || next.type === 'sub-agent') && next.parallelGroup === gid) {
          members.push(next);
          j++;
        } else break;
      }
      if (members.length >= 2) {
        units.push({
          type: 'parallel',
          members,
          parallelGroup: gid,
          siblings: a.parallelSiblingNames || members.map(memberDisplayName),
          key: `pg-${gid}`,
        });
        i = j;
        continue;
      }
    }
    units.push(a);
    i++;
  }

  return units;
}
