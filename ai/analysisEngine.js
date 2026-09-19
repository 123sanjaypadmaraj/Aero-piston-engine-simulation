/**
 * analysisEngine.js
 * -----------------------------------------------------------------------
 * Orchestrates the RAG + LLM "AI Engine Situation" narrative:
 *
 *   telemetry tick -> retriever picks relevant knowledge docs
 *                  -> prompt built from docs + live sensor readings
 *                  -> an LLM provider (Gemini, falling back to Groq; see
 *                     providers.js) generates a plain-language explanation
 *                  -> cached per engine + broadcast over Socket.IO
 *
 * Every stored/emitted analysis has this shape:
 *   { text, model, provider, fallbackUsed, degraded, generatedAt,
 *     severityKey, sources, error, cooldownUntil, fallbackReason }
 *   provider      'gemini' | 'groq' | null (null = static rule-based text)
 *   fallbackUsed  true when a non-primary provider answered (primary = the
 *                 first configured provider that has a key)
 *   degraded      true when `text` is the static non-AI fallback
 *   error         why AI text is unavailable (only when degraded), else null
 *   cooldownUntil ms epoch when the soonest provider cooldown ends, or null
 *   fallbackReason why the primary provider was skipped/failed (only when
 *                 fallbackUsed), else null
 *
 * Throttling: calling an LLM on every 2s telemetry tick for every engine
 * would be wasteful and rate-limit-prone, so an engine is only
 * re-analyzed when its condition actually changes (nominal/warning/
 * critical band, active fault, or predicted fault type) or when
 * AI_ANALYSIS_INTERVAL_MS has elapsed since its last analysis —
 * whichever comes first. A manual `refresh()` (wired to the dashboard's
 * "Explain now" button / POST /api/ai-analysis/:id/refresh) bypasses the
 * interval for an on-demand explanation. A degraded engine is retried as
 * soon as the blocking provider cooldown ends (or after
 * AI_DEGRADED_RETRY_MS, default 60s, for other failures).
 *
 * Fails soft: if no provider is configured, all are cooling down, or a
 * call errors/times out, a rule-based fallback sentence is cached instead
 * so the dashboard always has *something* to show, and the tick loop is
 * never blocked or crashed by an AI failure. Provider selection, circuit
 * breaking and per-provider request spacing live in providers.js.
 * -----------------------------------------------------------------------
 */

'use strict';

const { retrieveContext } = require('./retriever');
const { ProviderPool } = require('./providers');
const { redactSecrets, readNonNegInt, truncate } = require('./aiUtil');

const MAX_TRACKED_ENGINES = 256; // bound on the analysis cache (fleet is tiny; this is a guard)
const MAX_DOC_CHARS = 1200;
const MAX_ALERT_CHARS = 200;
const MAX_ALERTS = 5;

/** Key that changes whenever the engine's overall condition changes materially. */
function severityKey(engineSnapshot) {
  const statuses = Object.values((engineSnapshot && engineSnapshot.statuses) || {});
  const worst = statuses.includes('critical') ? 'critical' : statuses.includes('warning') ? 'warning' : 'nominal';
  return `${worst}|${engineSnapshot?.activeFault?.type || ''}|${engineSnapshot?.predictedFault?.type || ''}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, suffix = '') => (isNum(v) ? `${v}${suffix}` : 'unknown');

function buildPrompt(engineSnapshot, fleetSnapshot, contextDocs) {
  const engine = engineSnapshot || {};
  const fleet = (fleetSnapshot && fleetSnapshot.fleet) || {};
  const docs = Array.isArray(contextDocs) ? contextDocs : [];
  const knowledge = docs.length
    ? docs.map((doc) => `- ${doc.title}: ${truncate(doc.text, MAX_DOC_CHARS)}`).join('\n')
    : '- (no specific domain notes matched; rely on the telemetry below)';

  const telemetry = {
    tail: engine.tail,
    engine: engine.engine,
    time: engine.time,
    readings: engine.readings,
    statuses: engine.statuses,
    health: isNum(engine.health) ? engine.health : null,
    remainingUsefulLifeHours: isNum(engine.rul) ? engine.rul : null,
    activeFault: engine.activeFault,
    predictedFault: engine.predictedFault,
    recentAlerts: (Array.isArray(engine.alerts) ? engine.alerts : []).slice(0, MAX_ALERTS)
      .map((a) => truncate(a && a.message, MAX_ALERT_CHARS)),
    altitudeMeters: engine.altitude,
    airspeedKmh: engine.airspeed,
    hoursFlown: engine.hoursFlown,
  };

  return `You are an aircraft maintenance engineer's assistant embedded in a UAV piston-engine digital twin dashboard.
Explain the CURRENT situation of this engine to a flight-ops officer in plain, confident language.

Relevant domain knowledge retrieved for this specific situation:
${knowledge}

Live telemetry snapshot (JSON):
${JSON.stringify(telemetry, null, 2)}

Fleet context: mission reliability ${fmt(fleet.missionReliability, '%')}, ${fmt(fleet.criticalCount)} of ${fmt(fleet.engineCount)} fleet engine(s) currently critical.

Write a short analysis (max ~60 words, 2-3 sentences, plain prose, no markdown headers or bullet lists) that:
1. States the engine's overall condition in one clear sentence (nominal / degraded / critical).
2. Names the specific sensor(s) or fault driving that condition, with the actual reading, and briefly why it matters (use the knowledge above).
3. Gives one concrete, actionable recommendation for the flight/maintenance crew.
Do not repeat these instructions, do not mention "AI" or "prompt" — just give the analysis as a domain expert would speak it.`;
}

function fallbackText(engineSnapshot, reason) {
  const engine = engineSnapshot || {};
  const name = engine.tail || engine.id || 'Engine';
  const offNominal = Object.entries(engine.statuses || {}).filter(([, status]) => status !== 'nominal');
  const health = isNum(engine.health) ? `health ${engine.health}%` : 'health unknown';
  const headline = offNominal.length === 0
    ? `${name}: all monitored parameters nominal, ${health}.`
    : `${name}: ${health}, attention needed on ${offNominal.map(([key]) => key).join(', ')}.`;
  return `${headline} (AI narrative unavailable: ${reason})`;
}

class AiAnalysisEngine {
  /**
   * @param {object}   [opts]
   * @param {object}   [opts.io]      Socket.IO server (for the 'ai-analysis' emit)
   * @param {Function} [opts.now]     clock (ms epoch), injectable for tests
   * @param {object}   [opts.pool]    ProviderPool instance (default: built from env)
   * @param {object}   [opts.env]     env source for the default pool/intervals
   * @param {object}   [opts.config]  ProviderPool config overrides (see providers.js)
   * @param {Function} [opts.sleep]   sleep override for the default pool
   * @param {object}   [opts.logger]  { warn, log }
   */
  constructor({
    io, now = Date.now, pool, env = process.env, config, sleep, logger = console,
  } = {}) {
    this.io = io;
    this._now = now;
    this._logger = logger;
    this._closed = false;
    this.pool = pool || new ProviderPool({ env, config, now, sleep, logger });
    this.byEngine = new Map(); // engineId -> analysis object (see header)
    this._inFlight = new Map(); // engineId -> Promise of the running analysis
    this._retryAt = new Map(); // engineId -> ms epoch after which a degraded result is retried
    // How often a *nominal, unchanged* engine gets re-analyzed just to keep
    // the narrative fresh. Kept fairly long by default because free-tier
    // keys/models can carry surprisingly small daily request quotas (as low
    // as ~20/day for some preview models) on top of any per-minute limit — a
    // short interval times 3 engines burns that budget in minutes. A real
    // condition change (fault starts/resolves, a sensor crosses into
    // warning/critical) always triggers an immediate re-analysis regardless
    // of this interval, so responsiveness to genuine events isn't affected.
    this.minIntervalMs = readNonNegInt(env.AI_ANALYSIS_INTERVAL_MS, 5 * 60 * 1000) || 5 * 60 * 1000;
    this.degradedRetryMs = readNonNegInt(env.AI_DEGRADED_RETRY_MS, 60 * 1000) || 60 * 1000;
  }

  /** Per-provider configuration/cooldown state (no secrets), e.g. for a health endpoint. */
  providerStatus() {
    return this.pool.status();
  }

  /** Latest cached analysis for one engine, or null if none yet. */
  latest(engineId) {
    return this.byEngine.get(engineId) || null;
  }

  /** Latest cached analysis for every engine, keyed by engine id. */
  allLatest() {
    return Object.fromEntries(this.byEngine.entries());
  }

  _isDue(cached, engineId, sevKey) {
    if (!cached || cached.severityKey !== sevKey) return true;
    const retryAt = this._retryAt.get(engineId);
    if (cached.degraded && retryAt !== undefined) return this._now() >= retryAt;
    return this._now() - cached.generatedAt > this.minIntervalMs;
  }

  /** Called once per telemetry tick; fires (throttled) analyses in the background. */
  onFleetTick(fleetSnapshot) {
    if (this._closed || !fleetSnapshot || !Array.isArray(fleetSnapshot.engines)) return;
    for (const engine of fleetSnapshot.engines) {
      if (!engine || !engine.id) continue;
      const sevKey = severityKey(engine);
      if (this._isDue(this.byEngine.get(engine.id), engine.id, sevKey)) {
        this._analyze(engine, fleetSnapshot, sevKey).catch(() => {}); // _analyze never rejects; belt and braces
      }
    }
  }

  /** On-demand analysis for one engine, bypassing the interval throttle. */
  refresh(engine, fleetSnapshot) {
    return this._analyze(engine, fleetSnapshot, severityKey(engine), true);
  }

  _analyze(engine, fleetSnapshot, sevKey, force = false) {
    const id = engine && engine.id;
    const running = this._inFlight.get(id);
    // A forced refresh joins the analysis already running for this engine instead of stacking another request.
    if (running) return force ? running : Promise.resolve(this.byEngine.get(id) || null);
    const job = this._run(engine, fleetSnapshot, sevKey).finally(() => this._inFlight.delete(id));
    this._inFlight.set(id, job);
    return job;
  }

  async _run(engine, fleetSnapshot, sevKey) {
    const id = engine && engine.id;
    let contextDocs = [];
    try {
      contextDocs = retrieveContext(engine);
      const prompt = buildPrompt(engine, fleetSnapshot, contextDocs);
      const result = await this.pool.generate(prompt);
      this._retryAt.delete(id);
      return this._store(id, {
        text: result.text,
        model: result.model,
        provider: result.provider,
        fallbackUsed: result.fallbackUsed,
        degraded: false,
        generatedAt: this._now(),
        severityKey: sevKey,
        sources: contextDocs.map((d) => d.title),
        error: null,
        cooldownUntil: result.cooldownUntil ?? null,
        fallbackReason: result.fallbackReason ?? null,
      });
    } catch (err) {
      if (err && err.code === 'CLOSED') return this.byEngine.get(id) || null; // shutting down: nothing to store or emit
      const reason = redactSecrets(err && err.message ? err.message : 'unknown error');
      // Only log when a real request was made; "no key" / "all cooling down" are expected states already logged once.
      if (err && err.attempted !== false && err.code !== 'NO_PROVIDERS' && err.code !== 'ALL_COOLING_DOWN') {
        this._log('warn', `${id}: ${reason}`);
      }
      const now = this._now();
      const cooldownUntil = err && err.cooldownUntil ? err.cooldownUntil : null;
      if (err && err.code === 'NO_PROVIDERS') this._retryAt.delete(id); // nothing to retry until the config changes
      else this._retryAt.set(id, cooldownUntil || now + this.degradedRetryMs);
      return this._store(id, {
        text: fallbackText(engine, reason),
        model: null,
        provider: null,
        fallbackUsed: false,
        degraded: true,
        generatedAt: now,
        severityKey: sevKey,
        sources: [],
        error: reason,
        cooldownUntil,
        fallbackReason: null,
      });
    }
  }

  _log(level, message) {
    try { (this._logger[level] || this._logger.log).call(this._logger, `[ai-analysis] ${redactSecrets(message)}`); } catch { /* never throw from logging */ }
  }

  _store(engineId, result) {
    if (this._closed) return result;
    if (!this.byEngine.has(engineId) && this.byEngine.size >= MAX_TRACKED_ENGINES) {
      const oldest = this.byEngine.keys().next().value; // Map iterates in insertion order
      this.byEngine.delete(oldest);
      this._retryAt.delete(oldest);
    }
    this.byEngine.set(engineId, result);
    try {
      this.io?.emit('ai-analysis', { engineId, ...result });
    } catch (err) {
      this._log('warn', `socket emit failed: ${err.message}`);
    }
    return result;
  }

  /** Stop accepting work, cancel in-flight provider requests and sleeps. Safe to call more than once. */
  close() {
    this._closed = true;
    this.pool.close();
  }
}

module.exports = {
  AiAnalysisEngine, buildPrompt, fallbackText, severityKey,
};
