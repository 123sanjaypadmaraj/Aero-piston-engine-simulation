/**
 * retriever.js
 * -----------------------------------------------------------------------
 * Retrieval half of the RAG pipeline: given one engine's current
 * telemetry snapshot, decide which knowledge-base documents are relevant
 * right now and return them for the LLM prompt in analysisEngine.js.
 *
 * Scoring is deliberately simple tag matching rather than embeddings —
 * the knowledge base is small and hand-tagged, so a weighted overlap
 * score is enough to reliably surface "this engine's active/predicted
 * fault" and "any sensor currently out of its nominal band" ahead of
 * generic background docs, without pulling in a vector DB or an
 * embeddings API call per tick.
 *
 * Robust to partial snapshots: a missing/odd snapshot, an unknown fault
 * type or a non-array `topK` never throws, and the result is never empty.
 * -----------------------------------------------------------------------
 */

'use strict';

const { KNOWLEDGE_BASE } = require('./knowledgeBase');

const DEFAULT_TOP_K = 5;

/** Build a tag -> weight map describing what's relevant for this engine right now. */
function interestTags(engineSnapshot) {
  const tags = new Map();
  const bump = (tag, weight) => {
    if (typeof tag !== 'string' || !tag) return; // ignore missing/odd fault types
    tags.set(tag, Math.max(tags.get(tag) || 0, weight));
  };
  const snap = engineSnapshot && typeof engineSnapshot === 'object' ? engineSnapshot : {};

  if (snap.activeFault) bump(snap.activeFault.type, 3);
  if (snap.predictedFault) bump(snap.predictedFault.type, 2);

  const statuses = snap.statuses && typeof snap.statuses === 'object' ? snap.statuses : {};
  for (const [sensorKey, status] of Object.entries(statuses)) {
    if (status === 'critical') bump(sensorKey, 2.2);
    else if (status === 'warning') bump(sensorKey, 1.1);
  }

  // Always keep a little weight on the general/background concepts so a
  // fully nominal engine still gets a grounded (if generic) explanation.
  bump('health', 0.4);
  bump('rul', 0.4);
  bump('general', 0.3);

  return tags;
}

/**
 * Return the top `topK` knowledge-base docs relevant to this engine's
 * current state, most relevant first (ties keep knowledge-base order).
 */
function retrieveContext(engineSnapshot, topK = DEFAULT_TOP_K) {
  const tags = interestTags(engineSnapshot);
  const limit = Number.isFinite(topK) && topK >= 1 ? Math.floor(topK) : DEFAULT_TOP_K;

  const scored = KNOWLEDGE_BASE
    .map((doc) => {
      let score = 0;
      for (const tag of doc.tags) {
        if (tags.has(tag)) score += tags.get(tag);
      }
      return { doc, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, limit).map((entry) => entry.doc);

  // Fallback so the prompt is never sent with zero grounding context.
  if (top.length === 0) {
    const general = KNOWLEDGE_BASE.find((doc) => doc.id === 'concept-health') || KNOWLEDGE_BASE[0];
    if (general) top.push(general);
  }

  return top;
}

module.exports = { retrieveContext, interestTags };
