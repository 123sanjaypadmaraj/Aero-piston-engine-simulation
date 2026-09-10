/**
 * analysisEngine.js
 * -----------------------------------------------------------------------
 * Orchestrates the RAG + Gemini "AI Engine Situation" narrative:
 *
 *   telemetry tick -> retriever picks relevant knowledge docs
 *                  -> prompt built from docs + live sensor readings
 *                  -> Gemini generates a plain-language explanation
 *                  -> cached per engine + broadcast over Socket.IO
 *
 * Throttling: calling an LLM on every 2s telemetry tick for every engine
 * would be wasteful and rate-limit-prone, so an engine is only
 * re-analyzed when its condition actually changes (nominal/warning/
 * critical band, active fault, or predicted fault type) or when
 * AI_ANALYSIS_INTERVAL_MS has elapsed since its last analysis —
 * whichever comes first. A manual `refresh()` (wired to the dashboard's
 * "Explain now" button / POST /api/ai-analysis/:id/refresh) bypasses the
 * interval for an on-demand explanation.
 *
 * Fails soft: if GEMINI_API_KEY is missing or the API call errors/times
 * out, a rule-based fallback sentence is cached instead so the dashboard
 * always has *something* to show, and the tick loop is never blocked or
 * crashed by an AI failure.
 * -----------------------------------------------------------------------
 */

'use strict';

const { retrieveContext } = require('./retriever');
const { callGemini } = require('./geminiClient');

// How often a *nominal, unchanged* engine gets re-analyzed just to keep the
// narrative fresh. Kept fairly long by default because free-tier Gemini
// keys/models can carry surprisingly small daily request quotas (as low as
// ~20/day for some preview models) on top of any per-minute limit — a
// short interval here times 3 engines burns that budget in minutes. A real
// condition change (fault starts/resolves, a sensor crosses into
// warning/critical) always triggers an immediate re-analysis regardless of
// this interval, so responsiveness to genuine events isn't affected.
const MIN_INTERVAL_MS = Number(process.env.AI_ANALYSIS_INTERVAL_MS) || 5 * 60 * 1000;

// Guards against bursts hitting a per-minute cap: with 3 engines potentially
// all "due" on the same tick, firing them concurrently would spend that
// budget in one shot. Every Gemini call — across all engines — is funneled
// through one queue that enforces a minimum gap between calls, so the fleet
// degrades to "analyses arrive a bit more slowly" rather than "most calls 429".
const GLOBAL_MIN_GAP_MS = Number(process.env.GEMINI_MIN_GAP_MS) || 13000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Key that changes whenever the engine's overall condition changes materially. */
function severityKey(engineSnapshot) {
  const statuses = Object.values(engineSnapshot.statuses || {});
  const worst = statuses.includes('critical') ? 'critical' : statuses.includes('warning') ? 'warning' : 'nominal';
  return `${worst}|${engineSnapshot.activeFault?.type || ''}|${engineSnapshot.predictedFault?.type || ''}`;
}

function buildPrompt(engineSnapshot, fleetSnapshot, contextDocs) {
  const knowledge = contextDocs.map((doc) => `- ${doc.title}: ${doc.text}`).join('\n');

  const telemetry = {
    tail: engineSnapshot.tail,
    engine: engineSnapshot.engine,
    time: engineSnapshot.time,
    readings: engineSnapshot.readings,
    statuses: engineSnapshot.statuses,
    health: engineSnapshot.health,
    remainingUsefulLifeHours: engineSnapshot.rul,
    activeFault: engineSnapshot.activeFault,
    predictedFault: engineSnapshot.predictedFault,
    recentAlerts: (engineSnapshot.alerts || []).slice(0, 5).map((a) => a.message),
    altitudeMeters: engineSnapshot.altitude,
    airspeedKmh: engineSnapshot.airspeed,
    hoursFlown: engineSnapshot.hoursFlown,
  };

  return `You are an aircraft maintenance engineer's assistant embedded in a UAV piston-engine digital twin dashboard.
Explain the CURRENT situation of this engine to a flight-ops officer in plain, confident language.

Relevant domain knowledge retrieved for this specific situation:
${knowledge}

Live telemetry snapshot (JSON):
${JSON.stringify(telemetry, null, 2)}

Fleet context: mission reliability ${fleetSnapshot.fleet.missionReliability}%, ${fleetSnapshot.fleet.criticalCount} of ${fleetSnapshot.fleet.engineCount} fleet engine(s) currently critical.

Write a short analysis (max ~120 words, 3-5 sentences, plain prose, no markdown headers or bullet lists) that:
1. States the engine's overall condition in one clear sentence (nominal / degraded / critical).
2. Names the specific sensor(s) or fault driving that condition, with the actual reading, and briefly why it matters (use the knowledge above).
3. Gives one concrete, actionable recommendation for the flight/maintenance crew.
Do not repeat these instructions, do not mention "AI" or "prompt" — just give the analysis as a domain expert would speak it.`;
}

function fallbackText(engineSnapshot, reason) {
  const offNominal = Object.entries(engineSnapshot.statuses || {}).filter(([, status]) => status !== 'nominal');
  const headline = offNominal.length === 0
    ? `${engineSnapshot.tail}: all monitored parameters nominal, health ${engineSnapshot.health}%.`
    : `${engineSnapshot.tail}: health ${engineSnapshot.health}%, attention needed on ${offNominal.map(([key]) => key).join(', ')}.`;
  return `${headline} (AI narrative unavailable: ${reason})`;
}

class AiAnalysisEngine {
  constructor({ io } = {}) {
    this.io = io;
    this.byEngine = new Map(); // engineId -> { text, model, generatedAt, severityKey, sources, error }
    this._inFlight = new Set();
    this._queue = Promise.resolve(); // serializes + spaces out Gemini calls across all engines
    this._lastCallAt = 0;
  }

  /** Run one Gemini call, queued behind any others so calls are spaced at least GLOBAL_MIN_GAP_MS apart. */
  async _rateLimitedCall(prompt) {
    const previous = this._queue.catch(() => {}); // a prior failure must not jam the queue
    let releaseTurn;
    this._queue = previous.then(() => new Promise((resolve) => { releaseTurn = resolve; }));
    await previous;
    const wait = GLOBAL_MIN_GAP_MS - (Date.now() - this._lastCallAt);
    if (wait > 0) await sleep(wait);
    this._lastCallAt = Date.now();
    try {
      return await callGemini(prompt);
    } finally {
      releaseTurn();
    }
  }

  /** Latest cached analysis for one engine, or null if none yet. */
  latest(engineId) {
    return this.byEngine.get(engineId) || null;
  }

  /** Latest cached analysis for every engine, keyed by engine id. */
  allLatest() {
    return Object.fromEntries(this.byEngine.entries());
  }

  /** Called once per telemetry tick; fires (throttled) analyses in the background. */
  onFleetTick(fleetSnapshot) {
    for (const engine of fleetSnapshot.engines) {
      const cached = this.byEngine.get(engine.id);
      const sevKey = severityKey(engine);
      const dueForRefresh = !cached
        || cached.severityKey !== sevKey
        || Date.now() - cached.generatedAt > MIN_INTERVAL_MS;
      if (dueForRefresh) this._analyze(engine, fleetSnapshot, sevKey);
    }
  }

  /** On-demand analysis for one engine, bypassing the interval throttle. */
  refresh(engine, fleetSnapshot) {
    return this._analyze(engine, fleetSnapshot, severityKey(engine), true);
  }

  async _analyze(engine, fleetSnapshot, sevKey, force = false) {
    if (this._inFlight.has(engine.id) && !force) return this.byEngine.get(engine.id);
    this._inFlight.add(engine.id);
    try {
      const contextDocs = retrieveContext(engine);
      const prompt = buildPrompt(engine, fleetSnapshot, contextDocs);
      const { text, model } = await this._rateLimitedCall(prompt);
      return this._store(engine.id, {
        text,
        model,
        generatedAt: Date.now(),
        severityKey: sevKey,
        sources: contextDocs.map((d) => d.title),
        error: null,
      });
    } catch (err) {
      const reason = err.code === 'NO_API_KEY' ? 'GEMINI_API_KEY is not set' : err.message;
      if (err.code !== 'NO_API_KEY') console.warn(`[ai-analysis] ${engine.id}: ${reason}`);
      return this._store(engine.id, {
        text: fallbackText(engine, reason),
        model: null,
        generatedAt: Date.now(),
        severityKey: sevKey,
        sources: [],
        error: reason,
      });
    } finally {
      this._inFlight.delete(engine.id);
    }
  }

  _store(engineId, result) {
    this.byEngine.set(engineId, result);
    this.io?.emit('ai-analysis', { engineId, ...result });
    return result;
  }
}

module.exports = { AiAnalysisEngine };
