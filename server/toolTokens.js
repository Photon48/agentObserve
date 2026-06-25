// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
//
// Tool token enrichment.
//
// No agent framework emits per-tool token counts in raw OTEL — tokens live
// only on LLM-level events (api_request / gen_ai.usage). So we count tool
// input/output token counts ourselves, after the canonical sessions are
// built, using `ai-tokenizer` (pure JS, offline, per-model encodings). Each
// tool's text is counted with the tokenizer of the model that DISPATCHED it
// (the LLM_CALL preceding the TOOL node in the same scope), so a Claude turn
// uses Claude's encoding and a GPT/Gemini/Mistral turn uses theirs.
//
// This runs once per telemetry load (startup + debounced fs.watch reload),
// not per request — routes serve the already-enriched in-memory sessions.
//
// Counts are approximate (the library validates >=97% against real API
// responses for top models); they are decision-support numbers for an
// operator scanning a run, not billing figures.

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

// Counting a multi-MB tool dump in full is wasteful — past this many chars we
// count a prefix and extrapolate linearly. Tool I/O is overwhelmingly small;
// this only bites pathological dumps and keeps reloads fast.
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

// Collect every TOOL_RESULT block in a captured-block list, keyed by id, so a
// TOOL node can find its result text (and we can stamp the block in place).
function indexResultBlocks(blocks, into) {
  for (const b of blocks || []) {
    if (b && b.type === 'TOOL_RESULT' && b.id != null) into.set(b.id, b);
  }
}

// Walk a node list (recursing into AGENT-kind children), threading the model
// of the most recent LLM_CALL as the dispatcher for subsequent TOOL nodes.
// resultBlockById lets TOOL nodes recover their output text from the step's
// captured blocks; scopeFallbackModel covers a TOOL that precedes any LLM_CALL.
async function enrichNodes(nodes, resultBlockById, scopeFallbackModel) {
  if (!Array.isArray(nodes)) return;
  let currentModel = scopeFallbackModel || '';

  for (const node of nodes) {
    if (!node) continue;
    if (node.kind === 'LLM_CALL') {
      if (node.model) currentModel = node.model;
    } else if (node.kind === 'TOOL') {
      const model = currentModel || scopeFallbackModel || '';
      node.toolInputTokens = await countTokens(node.toolInput, model);

      const resultBlock = node.toolUseId != null ? resultBlockById.get(node.toolUseId) : null;
      const outputText = resultBlock?.text ?? node.toolOutput ?? null;
      let outTokens;
      if (outputText != null && outputText !== '') {
        outTokens = await countTokens(outputText, model);
      } else {
        outTokens = node.toolResultSizeBytes > 0
          ? Math.round(node.toolResultSizeBytes / BYTES_PER_TOKEN)
          : 0;
      }
      node.toolOutputTokens = outTokens;
      if (resultBlock) resultBlock.outputTokens = outTokens;
    } else if (node.kind === 'AGENT') {
      // Nested sub-agent: its own LLM_CALL children dispatch its tools. Seed
      // the recursion with the current model so a sub-agent whose first node
      // is a TOOL (before its first LLM_CALL) still resolves an encoding.
      await enrichNodes(node.nodes, resultBlockById, currentModel);
    }
  }
}

// Enrich one step-shaped object ({ nodes, capturedBlocks }). Used for both
// real AGENT steps and the per-node `agentStepData` sub-steps the workflow
// graph carries (langchain builds those as SEPARATE node objects via
// buildScopedAgentStep, so they need their own pass — see NodeDetailView).
function enrichStepLike(stepLike, fallbackModel) {
  if (!stepLike || !Array.isArray(stepLike.nodes)) return Promise.resolve();
  const resultBlockById = new Map();
  indexResultBlocks(stepLike.capturedBlocks, resultBlockById);
  return enrichNodes(stepLike.nodes, resultBlockById, fallbackModel);
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
 * Stamp `toolInputTokens` / `toolOutputTokens` on every TOOL AgentNode (at any
 * nesting depth) and `outputTokens` on matched TOOL_RESULT blocks. Mutates the
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

  for (const session of sessions) {
    const fallbackModel = dominantModel(session);
    for (const turn of session.turns || []) {
      for (const step of turn.steps || []) {
        if (step.type === 'AGENT') await enrichStepLike(step, fallbackModel);
      }
      // The workflow graph's per-node agentStepData are separate node trees
      // (langchain) — NodeDetailView renders them, so they need stamping too.
      for (const asd of workflowAgentSteps(turn)) await enrichStepLike(asd, fallbackModel);
    }
  }

  if (loadedEncodings.size > 0) {
    console.log(`[agentObserve] tool token encodings loaded: ${[...loadedEncodings].join(', ')}`);
  }
  return sessions;
}
