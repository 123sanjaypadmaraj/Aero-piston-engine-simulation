/**
 * providers.js
 * -----------------------------------------------------------------------
 * Provider abstraction + resilience layer for the LLM calls behind the
 * "AI Engine Situation" narrative.
 *
 * A ProviderPool owns a uniform view of every provider (gemini, groq) and
 * decides, per request, which one to ask:
 *
 *   - Order comes from AI_PROVIDER_ORDER (default "gemini,groq"). A
 *     provider with no API key is skipped entirely — that is not an error.
 *   - Each provider has a circuit breaker. Quota/rate-limit (429, 402),
 *     auth/config errors (401, 403, invalid key, unknown model) put it in
 *     a cooldown during which NO request is made to it. Cooldown length:
 *     Retry-After / Gemini `retryDelay` when the response supplies one,
 *     else AI_PROVIDER_COOLDOWN_MS (5 min); auth errors use
 *     AI_PROVIDER_AUTH_COOLDOWN_MS (1 h). Timeouts / 5xx / network errors
 *     are retried once after a short jittered backoff; after 3
 *     consecutive failed requests the provider cools down for
 *     AI_PROVIDER_FAILURE_COOLDOWN_MS (60 s). Start/end of a cooldown is
 *     logged once, not per call.
 *   - Requests to one provider are serialized with a minimum gap between
 *     them (GEMINI_MIN_GAP_MS default 13000, GROQ_MIN_GAP_MS default
 *     2000). The gap is only ever slept when a real request is about to be
 *     sent: cooling/unkeyed providers are skipped without waiting, and the
 *     cooldown is re-checked after a call reaches the front of the queue,
 *     so calls queued behind a 429 don't each sleep a gap just to be
 *     skipped.
 *
 * "Primary" provider = the first provider in the configured order that has
 * a key. A result from any other provider has fallbackUsed = true.
 * -----------------------------------------------------------------------
 */

'use strict';

const { callGemini } = require('./geminiClient');
const { callGroq } = require('./groqClient');
const {
  makeError, redactSecrets, readNonNegInt, truncate,
} = require('./aiUtil');

const PROVIDER_DEFS = {
  gemini: {
    name: 'gemini', label: 'Gemini', keyEnv: 'GEMINI_API_KEY', gapEnv: 'GEMINI_MIN_GAP_MS', defaultGapMs: 13000,
    call: (prompt, opts) => callGemini(prompt, opts),
  },
  groq: {
    name: 'groq', label: 'Groq', keyEnv: 'GROQ_API_KEY', gapEnv: 'GROQ_MIN_GAP_MS', defaultGapMs: 2000,
    call: (prompt, opts) => callGroq(prompt, opts),
  },
};

const DEFAULT_ORDER = ['gemini', 'groq'];
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000; // never trust a server hint beyond a day
const MIN_COOLDOWN_MS = 1000;

/** Parse AI_PROVIDER_ORDER into known, de-duplicated provider names. */
function parseProviderOrder(value) {
  const names = String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => PROVIDER_DEFS[s]);
  const unique = [...new Set(names)];
  return unique.length ? unique : DEFAULT_ORDER.slice();
}

/** Resolve tunables from env (read at construction so tests can set them), with explicit overrides winning. */
function resolveConfig(env = process.env, overrides = {}) {
  const gaps = {};
  for (const def of Object.values(PROVIDER_DEFS)) gaps[def.name] = readNonNegInt(env[def.gapEnv], def.defaultGapMs);
  return {
    order: parseProviderOrder(env.AI_PROVIDER_ORDER),
    cooldownMs: readNonNegInt(env.AI_PROVIDER_COOLDOWN_MS, 5 * 60 * 1000) || 5 * 60 * 1000,
    authCooldownMs: readNonNegInt(env.AI_PROVIDER_AUTH_COOLDOWN_MS, 60 * 60 * 1000) || 60 * 60 * 1000,
    failureThreshold: 3,
    failureCooldownMs: readNonNegInt(env.AI_PROVIDER_FAILURE_COOLDOWN_MS, 60 * 1000) || 60 * 1000,
    retryBackoffMs: 400, // base for the single retry; +0-100% jitter
    timeoutMs: readNonNegInt(env.AI_REQUEST_TIMEOUT_MS, 20000) || 20000,
    maxPromptChars: readNonNegInt(env.AI_MAX_PROMPT_CHARS, 12000) || 12000,
    maxResponseChars: readNonNegInt(env.AI_MAX_RESPONSE_CHARS, 2000) || 2000,
    maxQueue: readNonNegInt(env.AI_MAX_QUEUE, 16) || 16, // pending requests per provider
    ...overrides,
    gaps: { ...gaps, ...(overrides.gaps || {}) },
  };
}

/**
 * Map a provider error onto what the breaker should do.
 *   kind: 'quota' | 'auth' | 'transient' | 'failure' | 'cancelled' | 'nokey'
 */
function classifyError(err) {
  const status = err && err.status;
  const code = err && err.code;
  if (code === 'CANCELLED' || code === 'CLOSED') return { kind: 'cancelled' };
  if (code === 'NO_API_KEY') return { kind: 'nokey' };
  if (status === 429 || status === 402) return { kind: 'quota', label: 'quota/rate limit' };
  if (status === 401 || status === 403) return { kind: 'auth', label: 'authentication/permission error' };
  if (status === 404) return { kind: 'auth', label: 'model or endpoint not found' };
  if (status === 400 && /api key not valid|API_KEY_INVALID|invalid api key|api key expired/i.test(err.message || '')) {
    return { kind: 'auth', label: 'invalid API key' };
  }
  if (code === 'ABORTED' || status === 408 || (status >= 500 && status <= 599)) return { kind: 'transient' };
  if (code === 'API_ERROR' && status === undefined) return { kind: 'transient' }; // network error
  return { kind: 'failure' }; // 4xx bad request, empty/blocked response, ...
}

/** Error thrown by ProviderPool.generate() when no provider produced text. */
class AiUnavailableError extends Error {
  constructor(message, code, { reasons = [], cooldownUntil = null, attempted = false } = {}) {
    super(redactSecrets(message));
    this.name = 'AiUnavailableError';
    this.code = code; // 'NO_PROVIDERS' | 'ALL_COOLING_DOWN' | 'ALL_PROVIDERS_FAILED'
    this.reasons = reasons; // [{ provider, kind: 'skipped'|'failed', message }]
    this.cooldownUntil = cooldownUntil; // earliest cooldown end among keyed providers, or null
    this.attempted = attempted; // true if at least one real request was sent
  }
}

class ProviderPool {
  /**
   * @param {object}   [opts]
   * @param {object}   [opts.env]       env source (default process.env), read lazily for keys
   * @param {object}   [opts.config]    overrides for resolveConfig()
   * @param {Function} [opts.now]       clock, ms epoch (injectable for tests)
   * @param {Function} [opts.sleep]     (ms) => Promise; default is a real, closable, unref'd timer
   * @param {object}   [opts.logger]    { warn, log }
   * @param {object}   [opts.providers] provider definitions (default gemini + groq)
   * @param {Function} [opts.random]    jitter source (default Math.random)
   */
  constructor({
    env = process.env, config = {}, now = Date.now, sleep, logger = console, providers = PROVIDER_DEFS, random = Math.random,
  } = {}) {
    this.env = env;
    this.config = resolveConfig(env, config);
    this._now = now;
    this._customSleep = sleep;
    this._logger = logger;
    this._random = random;
    this._defs = providers;
    this.order = this.config.order.filter((name) => providers[name]);
    this._state = new Map(); // name -> breaker state
    this._lanes = new Map(); // name -> { tail, pending }
    this._timers = new Set(); // outstanding sleeps, cleared by close()
    this._abort = new AbortController();
    this._closed = false;
    for (const name of this.order) {
      this._state.set(name, {
        cooldownUntil: null, cooldownReason: null, failures: 0, lastCallAt: null,
      });
      this._lanes.set(name, { tail: Promise.resolve(), pending: 0 });
    }
  }

  _key(def) {
    const v = this.env[def.keyEnv];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  }

  _isCooling(name) {
    const st = this._state.get(name);
    if (st.cooldownUntil === null) return false;
    if (this._now() < st.cooldownUntil) return true;
    // Cooldown elapsed: log the end exactly once, then allow a probe request.
    this._log('log', `${this._defs[name].label} cooldown ended (${st.cooldownReason}); will try it again`);
    st.cooldownUntil = null;
    st.cooldownReason = null;
    st.failures = 0;
    return false;
  }

  _log(level, message) {
    try { (this._logger[level] || this._logger.log).call(this._logger, `[ai-analysis] ${redactSecrets(message)}`); } catch { /* logging must never throw */ }
  }

  _startCooldown(name, ms, reason) {
    const st = this._state.get(name);
    const bounded = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
    if (st.cooldownUntil !== null && this._now() < st.cooldownUntil) return; // already cooling: don't re-log
    st.cooldownUntil = this._now() + bounded;
    st.cooldownReason = reason;
    st.failures = 0;
    this._log('warn', `${this._defs[name].label} cooling down for ${Math.round(bounded / 1000)}s (${reason}); skipping it until ${new Date(st.cooldownUntil).toISOString()}`);
  }

  _sleep(ms) {
    if (this._customSleep) return Promise.resolve(this._customSleep(ms));
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => { this._timers.delete(entry); resolve(); }, ms);
      if (entry.timer.unref) entry.timer.unref();
      this._timers.add(entry);
    });
  }

  /** Run `fn` after all earlier work for this provider; bounded queue, a failure never jams later calls. */
  async _withLane(name, fn) {
    const lane = this._lanes.get(name);
    if (lane.pending >= this.config.maxQueue) {
      throw makeError(`request queue full (${lane.pending} pending)`, 'QUEUE_FULL');
    }
    lane.pending += 1;
    const run = lane.tail.then(fn);
    lane.tail = run.then(() => {}, () => {});
    try {
      return await run;
    } finally {
      lane.pending -= 1;
    }
  }

  _cancellationSignal(external) {
    if (external && typeof AbortSignal.any === 'function') return AbortSignal.any([external, this._abort.signal]);
    return external || this._abort.signal;
  }

  /** One provider, up to two requests (retry once on a transient error). Runs inside the provider's lane. */
  async _attempt(def, key, prompt, signal) {
    const st = this._state.get(def.name);
    const opts = {
      apiKey: key,
      timeoutMs: this.config.timeoutMs,
      maxPromptChars: this.config.maxPromptChars,
      maxResponseChars: this.config.maxResponseChars,
      signal,
    };
    for (let attempt = 1; ; attempt += 1) {
      st.lastCallAt = this._now();
      try {
        const result = await def.call(prompt, opts);
        st.failures = 0;
        return result;
      } catch (err) {
        const cls = classifyError(err);
        if (this._closed || cls.kind === 'cancelled') throw makeError('AI request cancelled', 'CLOSED');
        if (cls.kind === 'quota') {
          const hinted = Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : null;
          // A per-day quota can't recover in seconds, so never go below the default for it.
          const ms = hinted === null ? this.config.cooldownMs : err.dailyQuota ? Math.max(hinted, this.config.cooldownMs) : hinted;
          this._startCooldown(def.name, ms, `${cls.label}, HTTP ${err.status}${hinted !== null ? ', server retry hint' : ''}`);
          throw err;
        }
        if (cls.kind === 'auth') {
          const hinted = Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 0;
          this._startCooldown(def.name, Math.max(hinted, this.config.authCooldownMs), `${cls.label}, HTTP ${err.status}`);
          throw err;
        }
        if (cls.kind === 'transient' && attempt === 1) {
          const backoff = Math.round(this.config.retryBackoffMs * (1 + this._random()));
          await this._sleep(backoff);
          if (this._closed) throw makeError('AI request cancelled', 'CLOSED');
          continue;
        }
        st.failures += 1;
        if (st.failures >= this.config.failureThreshold) {
          this._startCooldown(def.name, this.config.failureCooldownMs, `${st.failures} consecutive failures`);
        }
        throw err;
      }
    }
  }

  /**
   * Ask the providers in order until one answers. Resolves to
   * { text, model, provider, fallbackUsed, fallbackReason, cooldownUntil }
   * or rejects with AiUnavailableError (or a CLOSED error after close()).
   */
  async generate(prompt, { signal } = {}) {
    if (this._closed) throw makeError('AI provider pool is closed', 'CLOSED');
    const text = truncate(prompt, this.config.maxPromptChars);
    const cancel = this._cancellationSignal(signal);
    const reasons = [];
    let primary = null;
    let keyed = 0;
    let attempted = false;

    for (const name of this.order) {
      const def = this._defs[name];
      const key = this._key(def);
      if (!key) continue; // unkeyed: skipped entirely, not an error
      keyed += 1;
      if (primary === null) primary = name;

      const skipMessage = () => {
        const st = this._state.get(name);
        return `cooling down until ${new Date(st.cooldownUntil).toISOString()} (${st.cooldownReason})`;
      };
      if (this._isCooling(name)) {
        reasons.push({ provider: name, kind: 'skipped', message: `${def.label}: ${skipMessage()}` });
        continue;
      }

      try {
        const outcome = await this._withLane(name, async () => {
          // Re-check now that we are at the front of the queue: an earlier call may have just tripped the breaker.
          if (this._isCooling(name)) return { skipped: true };
          if (this._closed) throw makeError('AI provider pool is closed', 'CLOSED');
          const st = this._state.get(name);
          if (st.lastCallAt !== null) {
            const wait = this.config.gaps[name] - (this._now() - st.lastCallAt);
            if (wait > 0) {
              await this._sleep(wait);
              if (this._closed) throw makeError('AI provider pool is closed', 'CLOSED');
            }
          }
          attempted = true;
          return { result: await this._attempt(def, key, text, cancel) };
        });
        if (outcome.skipped) {
          reasons.push({ provider: name, kind: 'skipped', message: `${def.label}: ${skipMessage()}` });
          continue;
        }
        const fallbackUsed = name !== primary;
        return {
          text: outcome.result.text,
          model: outcome.result.model,
          provider: name,
          fallbackUsed,
          fallbackReason: fallbackUsed ? reasons.map((r) => r.message).join(' | ') || null : null,
          cooldownUntil: this.earliestCooldownEnd(),
        };
      } catch (err) {
        if (err.code === 'CLOSED') throw err;
        reasons.push({ provider: name, kind: 'failed', message: `${def.label}: ${redactSecrets(err.message)}` });
      }
    }

    const cooldownUntil = this.earliestCooldownEnd();
    if (keyed === 0) {
      throw new AiUnavailableError('No AI provider configured (set GEMINI_API_KEY or GROQ_API_KEY)', 'NO_PROVIDERS', { reasons, cooldownUntil, attempted });
    }
    const message = reasons.map((r) => r.message).join(' | ');
    const allSkipped = reasons.length > 0 && reasons.every((r) => r.kind === 'skipped');
    throw new AiUnavailableError(
      allSkipped ? `All AI providers cooling down: ${message}` : message,
      allSkipped ? 'ALL_COOLING_DOWN' : 'ALL_PROVIDERS_FAILED',
      { reasons, cooldownUntil, attempted },
    );
  }

  /** Earliest end of any currently active cooldown among keyed providers (ms epoch), or null. */
  earliestCooldownEnd() {
    let earliest = null;
    for (const name of this.order) {
      if (!this._key(this._defs[name]) || !this._isCooling(name)) continue;
      const until = this._state.get(name).cooldownUntil;
      if (earliest === null || until < earliest) earliest = until;
    }
    return earliest;
  }

  /** Snapshot of breaker state per provider (safe to expose: contains no keys). */
  status() {
    return {
      order: this.order.slice(),
      providers: this.order.map((name) => {
        const st = this._state.get(name);
        const cooling = this._isCooling(name);
        return {
          name,
          configured: Boolean(this._key(this._defs[name])),
          cooldownUntil: cooling ? st.cooldownUntil : null,
          cooldownReason: cooling ? st.cooldownReason : null,
          consecutiveFailures: st.failures,
        };
      }),
    };
  }

  /** Cancel in-flight requests and pending sleeps so shutdown/tests don't hang. Idempotent. */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._abort.abort();
    for (const entry of this._timers) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    this._timers.clear();
  }
}

module.exports = {
  ProviderPool, AiUnavailableError, PROVIDER_DEFS, classifyError, resolveConfig, parseProviderOrder,
};
