/**
 * aiUtil.js
 * -----------------------------------------------------------------------
 * Small shared helpers for the LLM provider clients (geminiClient.js,
 * groqClient.js) and the provider pool (providers.js): error construction,
 * secret redaction, retry-hint parsing and a fetch wrapper that enforces a
 * timeout across BOTH the response headers and body.
 * -----------------------------------------------------------------------
 */

'use strict';

// Env vars whose values must never appear in a log line or error message.
const SECRET_ENV_VARS = ['GEMINI_API_KEY', 'GROQ_API_KEY'];

// Shapes of credentials we recognise even when we don't know the literal
// value (e.g. a key echoed back inside an upstream error body).
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{16,}/g, // Google API keys
  /gsk_[0-9A-Za-z]{16,}/g, // Groq keys
  /sk-[0-9A-Za-z_-]{16,}/g, // OpenAI-style keys
  /Bearer\s+[0-9A-Za-z._~+/=-]{8,}/gi,
  /([?&]key=)[^&\s"']+/gi,
  /(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/**
 * Mask any known/likely API key in `text`. `extraSecrets` lets a caller
 * pass the literal key it is using (works even for keys with an unusual
 * shape). Always returns a string.
 */
function redactSecrets(text, extraSecrets = []) {
  let out = String(text ?? '');
  const literals = [...extraSecrets, ...SECRET_ENV_VARS.map((name) => process.env[name])]
    .filter((s) => typeof s === 'string' && s.trim().length >= 6)
    .map((s) => s.trim());
  for (const secret of literals) out = out.split(secret).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

/** Build an Error with a machine-readable `.code`; the message is always redacted. */
function makeError(message, code, extra) {
  const err = new Error(redactSecrets(message));
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/** Cut `text` to at most `max` characters (marking the cut with an ellipsis). */
function truncate(text, max) {
  const s = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Non-negative integer from an env-style value, else `fallback` (0 is allowed). */
function readNonNegInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Sum a duration string such as "34s", "34.5s", "7m12.5s", "250ms", "1h2m" into ms. */
function parseDurationMs(text) {
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    total += Number(m[1]) * unit[m[2].toLowerCase()];
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into ms, else null. */
function parseRetryAfterHeader(value, nowMs = Date.now()) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const when = Date.parse(s);
  return Number.isNaN(when) ? null : Math.max(0, when - nowMs);
}

/**
 * Pull retry hints out of an error response: the Retry-After header first,
 * then Gemini's `"retryDelay": "34s"` / "Please retry in 34.5s" and Groq's
 * "try again in 7m12s". `dailyQuota` flags per-day limits, where retrying
 * after a few seconds would be pointless.
 */
function extractRetryInfo(headers, bodyText, nowMs = Date.now()) {
  let retryAfterMs = null;
  const headerValue = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  retryAfterMs = parseRetryAfterHeader(headerValue, nowMs);
  const body = String(bodyText || '');
  if (retryAfterMs === null) {
    const m = /(?:retryDelay["']?\s*[:=]\s*["']?|(?:retry|try again) in\s+)((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i.exec(body);
    if (m) retryAfterMs = parseDurationMs(m[1]);
  }
  return { retryAfterMs, dailyQuota: /PerDay|per day|daily/i.test(body) };
}

/** Best human-readable message from an upstream error body (JSON `error.message` or raw text). */
function summarizeErrorBody(bodyText, max = 300) {
  const raw = String(bodyText || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const msg = parsed?.error?.message || (typeof parsed?.error === 'string' ? parsed.error : null) || parsed?.message;
    if (typeof msg === 'string' && msg) return truncate(redactSecrets(msg), max);
  } catch { /* not JSON: fall through to raw text */ }
  return truncate(redactSecrets(raw.replace(/\s+/g, ' ')), max);
}

/**
 * fetch + read the whole body under one timeout. `signal` lets a caller
 * cancel (used by AiAnalysisEngine.close()). Throws makeError() errors with
 * code 'ABORTED' (timeout), 'CANCELLED' (external abort) or 'API_ERROR'
 * (network failure); resolves to { ok, status, statusText, headers, bodyText }
 * for any HTTP response, success or not.
 */
async function fetchText(url, init, { timeoutMs, signal, label }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw makeError(`${label} request cancelled`, 'CANCELLED');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  // Race against the abort so a fetch that ignores its signal still can't hang us.
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  aborted.catch(() => {}); // avoid an unhandled rejection when the race is already settled

  try {
    const work = (async () => {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const bodyText = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
      return { ok: res.ok, status: res.status, statusText: res.statusText || '', headers: res.headers, bodyText };
    })();
    work.catch(() => {}); // same: the loser of the race must not surface as unhandled
    return await Promise.race([work, aborted]);
  } catch (err) {
    if (timedOut) throw makeError(`${label} request timed out after ${timeoutMs}ms`, 'ABORTED');
    if (signal?.aborted) throw makeError(`${label} request cancelled`, 'CANCELLED');
    if (err.code) throw err;
    throw makeError(`${label} request failed: ${err.message}`, 'API_ERROR');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  redactSecrets,
  makeError,
  truncate,
  readNonNegInt,
  parseDurationMs,
  parseRetryAfterHeader,
  extractRetryInfo,
  summarizeErrorBody,
  fetchText,
};
