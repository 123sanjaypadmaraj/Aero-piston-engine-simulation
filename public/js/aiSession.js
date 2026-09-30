/**
 * public/js/aiSession.js
 * ---------------------------------------------------------------------------
 * Session-only, memory-only AI provider override for the dashboard.
 *
 * The operator can point the "Explain now" refresh at a provider + API key they
 * paste into the web page. The key lives ONLY in this module's closure for the
 * lifetime of the current page:
 *
 *   - never written to any browser storage or to request/session cookies
 *   - never sent to a logging or analytics endpoint
 *   - lost the moment the tab is reloaded or closed
 *   - sent to the server once per refresh as a request header, and the server
 *     uses it for exactly that one analysis before discarding it
 *
 * Everything else (normal env-configured keys, cooldowns, circuit breaking)
 * is untouched: this is purely an additive, per-tab override.
 *
 * Exports: window.DtAiSession = { set, clear, active, headers, provider }
 * ---------------------------------------------------------------------------
 */

(function () {
  'use strict';

  const PROVIDERS = new Set(['gemini', 'groq']);
  // Nothing in this module may touch any browser storage API or cookie.
  const state = { provider: null, key: '' };

  function normalize(provider) {
    return typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  }

  /**
   * Remember a provider + key for the rest of this page session.
   * Returns true on success; false (and no change) if either field is invalid.
   */
  function set(provider, key) {
    const p = normalize(provider);
    const k = typeof key === 'string' ? key.trim() : '';
    if (!PROVIDERS.has(p) || k.length < 8) return false;
    state.provider = p;
    state.key = k;
    return true;
  }

  /** Forget the override. Idempotent; returns true if there was something to clear. */
  function clear() {
    const had = state.provider !== null;
    state.provider = null;
    state.key = '';
    return had;
  }

  /** True while an override is configured for this tab. */
  function active() {
    return state.provider !== null && state.key.length > 0;
  }

  /** Headers to attach to an AI refresh request (empty object while inactive). */
  function headers() {
    if (!active()) return {};
    return {
      'x-ai-provider': state.provider,
      'x-ai-api-key': state.key,
    };
  }

  /** Currently configured provider name, or '' when inactive. */
  function provider() {
    return state.provider || '';
  }

  window.DtAiSession = {
    set, clear, active, headers, provider,
    _debugActiveProvider: provider, // tests read the mask, never the key
  };
})();