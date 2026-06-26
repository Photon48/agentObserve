// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
//
// Token attribution.
//
// Every token in an agent run is reported, exactly, by the LLM API calls — a
// per-call `output_tokens` (what the model wrote) and `input/cache_*` (what it
// read). A tool has NO token cost of its own. So instead of inventing tool
// token counts, we attribute the exact per-call numbers down to the individual
// content blocks:
//
//   • A message's exact `output_tokens` is split across its OUTPUT blocks
//     (THOUGHT / TEXT / TOOL_USE / AGENT_RESPONSE) in proportion to each
//     block's tokenized size. The split preserves the exact total —
//     Σ block.tokens === node.outputTokens — using largest-remainder rounding.
//   • A TOOL_RESULT is not part of the producing call's output; it is READ by
//     the next message. Its cost is just the tokenized result text.
//   • A tool's cost is therefore two honest numbers: `callTokens` (its
//     TOOL_USE block's share of the model's output) and `resultTokens` (its
//     TOOL_RESULT text read on the next message).
//
// The proportioning ratio comes from `ai-tokenizer` (pure JS, offline,
// per-model encodings), counted with the encoding of the model that produced
// the message — but the per-message TOTAL it is divided into is always the
// exact API figure, so this is an attribution of real tokens, not a guess.
//
// This runs once per telemetry load (startup + debounced fs.watch reload), not
// per request — routes serve the already-attributed in-memory sessions. It is
// framework-agnostic: adapters only have to emit blocks + exact LLM_CALL token
// fields, and any future framework inherits per-block attribution for free.

import { Tokenizer } from 'ai-tokenizer';
import { models } from 'ai-tokenizer';

// ai-tokenizer ships four BPE encodings; every one of its 100+ models maps to
// one of these. We lazy-import only the ones a given telemetry set actually
// needs (each is 2-8 MB uncompressed).
const ENCODING_LOADERS = {
  claude: () => import('ai-tokenizer/encoding/claude'),
  o200k_base: () => import('ai-tokenizer/encoding/o200k_base'),
  cl100k_base: () => import('ai-tokenizer/encoding/cl100k_base'),
  p50k_base: () => import('ai-tokenizer/encoding/p50k_base'),
};

const DEFAULT_ENCODING = 'o200k_base';

// Counting a multi-MB block in full is wasteful — past this many chars we count
// a prefix and extrapolate linearly. Block text is overwhelmingly small; this
// only bites pathological dumps and keeps reloads fast.
const TOKEN_COUNT_CHAR_CAP = 200_000;

// Fallback when we have a byte size but never captured the result text
// (OTEL_LOG_TOOL_CONTENT off). ~4 bytes/token is the standard rough ratio.
const BYTES_PER_TOKEN = 4;

// Build a lowercase exact-match index of the registry once.
const MODELS_BY_LOWER = new Map();
for (const [key, val] of Object.entries(models)) {
  MODELS_BY_LOWER.set(key.toLowerCase(), val.encoding);
}

// Map a canonical model id to one of the four encoding names. Telemetry model
// strings (e.g. "claude-opus-4-7", "claude-haiku-4-5-20251001", "gpt-4o")
// rarely match the registry's "provider/model" keys verbatim, so the family
// heuristic below is the load-bearing path; the registry lookups handle the
// cases (mostly LangChain "provider/model" ids) where they do match.
const encodingCache = new Map(); // model id -> encoding name (resolution memo)

function resolveEncodingName(modelId) {
  if (!modelId) return DEFAULT_ENCODING;
  if (encodingCache.has(modelId)) return encodingCache.get(modelId);

  const lower = String(modelId).toLowerCase();
  let enc = MODELS_BY_LOWER.get(lower);

  // Registry keys are "provider/model"; telemetry often gives a bare model.
  if (!enc) {
    for (const [key, val] of MODELS_BY_LOWER) {
      const bare = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
      if (bare === lower) { enc = val; break; }
    }
  }

  // Family heuristic — matches the registry's dominant encoding per provider.
  if (!enc) {
    if (lower.includes('claude')) enc = 'claude';
    else if (/(^|[/\-])(gpt|chatgpt|o1|o3|o4|davinci|text-embedding)/.test(lower)) enc = 'o200k_base';
    else if (lower.includes('gemini') || lower.includes('deepseek')) enc = 'o200k_base';
    else if (/(mistral|mixtral|codestral|qwen|llama|nova|grok)/.test(lower)) enc = 'cl100k_base';
    else enc = DEFAULT_ENCODING;
  }

  encodingCache.set(modelId, enc);
  return enc;
}

// Lazily instantiate (and cache) the Tokenizer for an encoding name.
const tokenizerByEncoding = new Map();
const loadedEncodings = new Set();

async function getTokenizer(encodingName) {
  if (tokenizerByEncoding.has(encodingName)) return tokenizerByEncoding.get(encodingName);
  const loader = ENCODING_LOADERS[encodingName] || ENCODING_LOADERS[DEFAULT_ENCODING];
  const encoding = await loader();
  const tok = new Tokenizer(encoding);
  tokenizerByEncoding.set(encodingName, tok);
  loadedEncodings.add(encodingName);
  return tok;
}

async function countTokens(text, modelId) {
  if (!text || typeof text !== 'string') return 0;
  const tok = await getTokenizer(resolveEncodingName(modelId));
  if (text.length <= TOKEN_COUNT_CHAR_CAP) return tok.count(text);
  const sampled = tok.count(text.slice(0, TOKEN_COUNT_CHAR_CAP));
  return Math.round(sampled * (text.length / TOKEN_COUNT_CHAR_CAP));
}

// Resolve the encoding for every model present, so getTokenizer's first call
// per encoding (the dynamic import) happens before the hot counting loop.
async function warmEncodings(modelIds) {
  const needed = new Set();
  for (const id of modelIds) needed.add(resolveEncodingName(id));
  await Promise.all([...needed].map(getTokenizer));
}

// ── Block-level attribution ──────────────────────────────────────────────────

const OUTPUT_BLOCK_TYPES = new Set(['THOUGHT', 'TEXT', 'TOOL_USE', 'AGENT_RESPONSE']);

// The text whose tokenized size weights a block's share of the message output.
function outputBlockWeightText(block) {
  if (block.type === 'TOOL_USE') {
    try { return JSON.stringify(block.input ?? {}); } catch { return String(block.input ?? ''); }
  }
  return typeof block.text === 'string' ? block.text : '';
}

// Largest-remainder (Hamilton) apportionment: split the integer `total` into
// integer parts proportional to `weights`, guaranteeing Σ parts === total.
function hamilton(weights, total) {
  const n = weights.length;
  if (n === 0) return [];
  if (!(total > 0)) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    // No measurable size anywhere — distribute evenly, residual to the tail.
    const base = Math.floor(total / n);
    const out = weights.map(() => base);
    let rem = total - base * n;
    for (let i = n - 1; i >= 0 && rem > 0; i--, rem--) out[i]++;
    return out;
  }
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((e) => Math.floor(e));
  let deficit = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; k < deficit && k < order.length; k++) out[order[k].i]++;
  return out;
}

// Proportion a message's EXACT output_tokens across its output blocks, stamping
// `block.tokens`. Leaves blocks untouched when there are none (capture off) so
// the FE can tell "not measured" from "zero".
async function proportionOutputBlocks(blocks, outputTokens, model) {
  const outs = (blocks || []).filter((b) => b && OUTPUT_BLOCK_TYPES.has(b.type));
  if (outs.length === 0) return;
  if (!(outputTokens > 0)) { for (const b of outs) b.tokens = 0; return; }

  const weights = [];
  for (const b of outs) {
    let w = await countTokens(outputBlockWeightText(b), model);
    // Redacted extended-thinking carries no text but a real output cost — give
    // it a signature-derived floor so its share isn't absorbed by siblings.
    if (w === 0 && b.type === 'THOUGHT' && b.redacted) {
      w = Math.max(1, Math.round((b.signature?.length || 0) / 4));
    }
    weights.push(w);
  }
  const parts = hamilton(weights, outputTokens);
  for (let i = 0; i < outs.length; i++) outs[i].tokens = parts[i];
}

// Tokenize a TOOL_RESULT's text → "result cost" (read by the next message).
// Falls back to byte size / 4 when the result text wasn't captured.
async function tokenizeResultBlock(block, model, toolNode) {
  if (!block) return;
  const text = typeof block.text === 'string' ? block.text : '';
  if (text !== '') { block.tokens = await countTokens(text, model); return; }
  const bytes = toolNode?.toolResultSizeBytes || 0;
  block.tokens = bytes > 0 ? Math.round(bytes / BYTES_PER_TOKEN) : 0;
}

// Walk a node tree (recursing into AGENT children), threading the dispatching
// model. Proportions each LLM_CALL's output blocks and tokenizes any node-side
// TOOL_RESULT blocks (cli / anthropic inject them into node.blocks; langchain
// keeps them only on capturedBlocks — handled in reconcile).
async function attributeNodes(nodes, scopeFallbackModel, toolByUseId) {
  if (!Array.isArray(nodes)) return;
  let currentModel = scopeFallbackModel || '';
  for (const node of nodes) {
    if (!node) continue;
    if (node.kind === 'LLM_CALL') {
      if (node.model) currentModel = node.model;
      await proportionOutputBlocks(node.blocks, node.outputTokens, currentModel);
      for (const b of node.blocks || []) {
        if (b && b.type === 'TOOL_RESULT') {
          await tokenizeResultBlock(b, currentModel, b.id != null ? toolByUseId.get(b.id) : null);
        }
      }
    } else if (node.kind === 'AGENT') {
      await attributeNodes(node.nodes, currentModel, toolByUseId);
    }
  }
}

// Index every TOOL node by its toolUseId across the whole tree.
function indexToolNodes(nodes, into) {
  for (const n of nodes || []) {
    if (!n) continue;
    if (n.kind === 'TOOL' && n.toolUseId != null) into.set(n.toolUseId, n);
    else if (n.kind === 'AGENT') indexToolNodes(n.nodes, into);
  }
}

// Collect already-stamped TOOL_USE / TOOL_RESULT block tokens by id from the
// node tree, so TOOL nodes (at any depth) can read their call/result cost.
function collectBlockTokensById(nodes, useTokens, resultTokens) {
  for (const n of nodes || []) {
    if (!n) continue;
    if (n.kind === 'LLM_CALL') {
      for (const b of n.blocks || []) {
        if (!b || b.tokens == null || b.id == null) continue;
        if (b.type === 'TOOL_USE') useTokens.set(b.id, b.tokens);
        else if (b.type === 'TOOL_RESULT') resultTokens.set(b.id, b.tokens);
      }
    } else if (n.kind === 'AGENT') {
      collectBlockTokensById(n.nodes, useTokens, resultTokens);
    }
  }
}

const isTextBlock = (t) => t === 'THOUGHT' || t === 'TEXT' || t === 'AGENT_RESPONSE';
// TEXT ≡ AGENT_RESPONSE (every adapter rewrites the final TEXT into a new
// AGENT_RESPONSE object); THOUGHT only matches THOUGHT.
const textClassMatch = (a, b) => (a === 'THOUGHT') === (b === 'THOUGHT');

// Copy per-block tokens onto the step's flattened capturedBlocks (what the FE
// conversation view renders). Output text blocks carry no id, so they match the
// ordered node-side output blocks via a consuming cursor; tool blocks match by
// id. A capturedBlocks-only TOOL_RESULT (langchain) is tokenized in place.
async function reconcileCapturedBlocks(stepLike, fallbackModel, useTokens, resultTokens, toolByUseId) {
  const captured = stepLike.capturedBlocks;
  if (!Array.isArray(captured)) return 0;

  // Ordered node-side output text blocks (top-level only — capturedBlocks is
  // the flattened top-level stream; sub-agent blocks render from node.blocks).
  const textCursor = [];
  for (const n of stepLike.nodes || []) {
    if (n?.kind !== 'LLM_CALL') continue;
    for (const b of n.blocks || []) {
      if (b && isTextBlock(b.type)) textCursor.push(b);
    }
  }

  let ci = 0;
  let unmatched = 0;
  for (const cb of captured) {
    if (!cb) continue;
    if (cb.type === 'TOOL_USE') {
      if (cb.id != null && useTokens.has(cb.id)) cb.tokens = useTokens.get(cb.id);
      else unmatched++;
    } else if (cb.type === 'TOOL_RESULT') {
      if (cb.id != null && resultTokens.has(cb.id)) {
        cb.tokens = resultTokens.get(cb.id);
      } else {
        await tokenizeResultBlock(cb, fallbackModel, cb.id != null ? toolByUseId.get(cb.id) : null);
        if (cb.id != null) resultTokens.set(cb.id, cb.tokens);
      }
    } else if (isTextBlock(cb.type)) {
      while (ci < textCursor.length && !textClassMatch(textCursor[ci].type, cb.type)) ci++;
      if (ci < textCursor.length) { cb.tokens = textCursor[ci].tokens; ci++; }
      else unmatched++;
    }
  }
  return unmatched;
}

// Stamp `callTokens` / `resultTokens` on every TOOL node (any depth). Null when
// unknown so the FE renders an em dash rather than a misleading 0.
function stampToolNodes(nodes, useTokens, resultTokens) {
  for (const n of nodes || []) {
    if (!n) continue;
    if (n.kind === 'TOOL') {
      n.callTokens = n.toolUseId != null && useTokens.has(n.toolUseId)
        ? useTokens.get(n.toolUseId) : null;
      n.resultTokens = n.toolUseId != null && resultTokens.has(n.toolUseId)
        ? resultTokens.get(n.toolUseId) : null;
    } else if (n.kind === 'AGENT') {
      stampToolNodes(n.nodes, useTokens, resultTokens);
    }
  }
}

// Attribute tokens for one step-shaped object ({ nodes, capturedBlocks }). Used
// for both real AGENT steps and the per-node `agentStepData` sub-steps the
// workflow graph carries (langchain builds those as separate node trees).
// Returns the count of capturedBlocks that found no node match (for logging).
async function attributeStepTokens(stepLike, fallbackModel) {
  if (!stepLike || !Array.isArray(stepLike.nodes)) return 0;

  const toolByUseId = new Map();
  indexToolNodes(stepLike.nodes, toolByUseId);

  await attributeNodes(stepLike.nodes, fallbackModel, toolByUseId);

  const useTokens = new Map();
  const resultTokens = new Map();
  collectBlockTokensById(stepLike.nodes, useTokens, resultTokens);

  const unmatched = await reconcileCapturedBlocks(
    stepLike, fallbackModel, useTokens, resultTokens, toolByUseId,
  );

  stampToolNodes(stepLike.nodes, useTokens, resultTokens);
  return unmatched;
}

// Every agentStepData hanging off a turn's workflow graph nodes.
function workflowAgentSteps(turn) {
  const out = [];
  const groups = turn?.workflowGraph?.groups || [];
  for (const g of groups) {
    for (const node of g.nodes || []) {
      if (node?.agentStepData) out.push(node.agentStepData);
    }
  }
  return out;
}

// Dominant model across a session — the seed when a scope has no LLM_CALL at
// all (rare; keeps the encoding sensible rather than defaulting blindly).
function dominantModel(session) {
  const counts = new Map();
  const visit = (nodes) => {
    for (const n of nodes || []) {
      if (!n) continue;
      if (n.kind === 'LLM_CALL' && n.model) counts.set(n.model, (counts.get(n.model) || 0) + 1);
      else if (n.kind === 'AGENT') visit(n.nodes);
    }
  };
  for (const turn of session.turns || []) {
    for (const step of turn.steps || []) {
      if (step.type === 'AGENT') visit(step.nodes);
    }
    for (const asd of workflowAgentSteps(turn)) visit(asd.nodes);
  }
  let best = '', bestN = 0;
  for (const [model, n] of counts) if (n > bestN) { best = model; bestN = n; }
  return best;
}

/**
 * Attribute the exact per-LLM-call tokens down to individual content blocks and
 * tool nodes: stamps `tokens` on every output/result Block, and `callTokens` /
 * `resultTokens` on every TOOL AgentNode (at any nesting depth), reconciling
 * the per-node blocks with the step's flattened capturedBlocks. Mutates the
 * sessions in place and returns them. Async because encodings are imported on
 * demand.
 */
export async function enrichToolTokens(sessions) {
  if (!Array.isArray(sessions)) return sessions;

  // Pre-warm every encoding the telemetry needs (one dynamic import each).
  const modelIds = new Set();
  const collectModels = (nodes) => {
    for (const n of nodes || []) {
      if (!n) continue;
      if (n.kind === 'LLM_CALL' && n.model) modelIds.add(n.model);
      else if (n.kind === 'AGENT') collectModels(n.nodes);
    }
  };
  for (const session of sessions) {
    for (const turn of session.turns || []) {
      for (const step of turn.steps || []) {
        if (step.type === 'AGENT') collectModels(step.nodes);
      }
      for (const asd of workflowAgentSteps(turn)) collectModels(asd.nodes);
    }
  }
  await warmEncodings(modelIds);

  let unmatched = 0;
  for (const session of sessions) {
    const fallbackModel = dominantModel(session);
    for (const turn of session.turns || []) {
      for (const step of turn.steps || []) {
        if (step.type === 'AGENT') unmatched += await attributeStepTokens(step, fallbackModel);
      }
      // The workflow graph's per-node agentStepData are separate node trees
      // (langchain) — NodeDetailView renders them, so they need attribution too.
      for (const asd of workflowAgentSteps(turn)) unmatched += await attributeStepTokens(asd, fallbackModel);
    }
  }

  if (loadedEncodings.size > 0) {
    const note = unmatched > 0 ? ` (${unmatched} captured blocks unmatched)` : '';
    console.log(`[agentObserve] token attribution encodings loaded: ${[...loadedEncodings].join(', ')}${note}`);
  }
  return sessions;
}
