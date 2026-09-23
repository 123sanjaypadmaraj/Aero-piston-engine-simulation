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

/**
 * Deterministic, LLM-free verdict on whether the current combined sensor
 * signature is an *accident* (immediate power-loss / mechanical collapse)
 * or a *degradation* (cooling/coking/fouling that looks similar but is
 * NOT crash-imminent). Grounded in the same combined-pattern KB docs the
 * retriever surfaces, not in an LLM call — so the AI box's most dangerous
 * classification ("is this an accident right now?") is unit-testable and
 * CI-gateable in BOTH directions, which is the whole point of the combined
 * signature class (see docs/ACCIDENT_TAXONOMY.md and the
 * pattern-cooling-vibration / pattern-power-loss KB docs).
 *
 * Class-of-signature rules (kept in sync with the KB docs):
 *   - Slow CHT/EGT/climb WITH a gradual vibration rise (cooling/coking
 *     degradation) resolves to `degradation`, NOT `accident` — even though
 *     several channels are off-nominal at once, they moved together SLOWLY.
 *   - An abrupt, simultaneous collapse of RPM + fuel flow + manifold
 *     pressure (optionally with a vibration spike) resolves to `accident`
 *     — multi-channel combined power loss that arrives fast.
 *   - Anything that drifts on only ONE channel (or a few, slowly) with no
 *     combined power-loss signature is `nominal`/`degradation`, never
 *     `accident`.
 *
 * @param {object} engineSnapshot  same shape retrieveContext takes.
 * @param {object} [opts]          { thresholdS } — accident margin in seconds.
 * @returns {{className: 'accident'|'degradation'|'nominal',
 *            patternIds: string[], evidence: string[],
 *            accidentScore: number, degradationScore: number}}
 */
function classifySignature(engineSnapshot, opts = {}) {
  const snap = engineSnapshot && typeof engineSnapshot === 'object' ? engineSnapshot : {};
  const statuses = snap.statuses && typeof snap.statuses === 'object' ? snap.statuses : {};
  const status = (k) => statuses[k];
  const any = (...ks) => ks.some((k) => status(k));
  const all = (...ks) => ks.every((k) => status(k));
  const counts = { accident: 0, degradation: 0 };
  const evidence = [];
  const patternIds = [];

  const push = (id, why) => { patternIds.push(id); evidence.push(why); };

  // Accident leg — abrupt combined power collapse. These KB docs say the
  // three-channel collapse (RPM+fuel+MP, with or without a vibe spike) is
  // THE combined signature of an accident, NOT three separate faults.
  if (all('rpm', 'fuelFlow', 'manifoldPressure') || all('rpm', 'fuelFlow', 'manifoldPressure', 'vibration')) {
    counts.accident += 3;
    push('pattern-power-loss', 'RPM+fuel flow+manifold pressure collapsing together (vibration accompanies it) = accident-class power loss');
  } else if (any('rpm', 'fuelFlow', 'manifoldPressure')) {
    counts.degradation += 1;
    evidence.push('isolated power-channel drift without the full combined collapse = degradation, not accident');
  }

  // Look-alike leg — the cooling/coking case from the KB doc: CHT/EGT
  // climbing SLOWLY with a gradual vibration rise is a serious but gradual
  // degradation, explicitly NOT an accident. It must never flip to accident
  // on its own (that is the exact false-accident the class exists to kill).
  if (all('cht', 'egt') && any('vibration')) {
    if (counts.accident === 0) counts.degradation += 3;
    push('pattern-cooling-vibration', 'CHT+EGT climbing together with vibration = cooling/coking degradation, NOT an accident');
  } else if (all('cht', 'egt') || any('cht', 'egt', 'vibration')) {
    counts.degradation += 1;
  }

  if (counts.accident === 0 && counts.degradation === 0) {
    evidence.push('no combined off-nominal signature — nominal health');
  }

  const className = counts.accident > 0 ? 'accident' : (counts.degradation > 0 ? 'degradation' : 'nominal');
  return { className, patternIds, evidence, accidentScore: counts.accident, degradationScore: counts.degradation };
}

module.exports = { retrieveContext, interestTags, classifySignature };
