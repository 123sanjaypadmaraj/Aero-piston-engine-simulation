/**
 * retriever.js
 * -----------------------------------------------------------------------
 * Retrieval half of the RAG pipeline: given one engine's current
 * telemetry snapshot, decide which knowledge-base documents are relevant
 * right now and return them for the Gemini prompt in analysisEngine.js.
 *
 * Scoring is deliberately simple tag matching rather than embeddings —
 * the knowledge base is small and hand-tagged, so a weighted overlap
 * score is enough to reliably surface "this engine's active/predicted
 * fault" and "any sensor currently out of its nominal band" ahead of
 * generic background docs, without pulling in a vector DB or an
 * embeddings API call per tick.
 * -----------------------------------------------------------------------
 */

'use strict';

const { KNOWLEDGE_BASE } = require('./knowledgeBase');

/** Build a tag -> weight map describing what's relevant for this engine right now. */
function interestTags(engineSnapshot) {
  const tags = new Map();
  const bump = (tag, weight) => tags.set(tag, Math.max(tags.get(tag) || 0, weight));

  if (engineSnapshot.activeFault) bump(engineSnapshot.activeFault.type, 3);
  if (engineSnapshot.predictedFault) bump(engineSnapshot.predictedFault.type, 2);

  for (const [sensorKey, status] of Object.entries(engineSnapshot.statuses || {})) {
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
 * current state, most relevant first.
 */
function retrieveContext(engineSnapshot, topK = 5) {
  const tags = interestTags(engineSnapshot);

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

  const top = scored.slice(0, topK).map((entry) => entry.doc);

  // Fallback so the prompt is never sent with zero grounding context.
  if (top.length === 0) {
    const general = KNOWLEDGE_BASE.find((doc) => doc.id === 'concept-health');
    if (general) top.push(general);
  }

  return top;
}

module.exports = { retrieveContext, interestTags };
