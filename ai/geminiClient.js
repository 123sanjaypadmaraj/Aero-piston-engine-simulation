/**
 * geminiClient.js
 * -----------------------------------------------------------------------
 * Thin wrapper around the Gemini "generateContent" REST endpoint. Uses
 * Node's built-in fetch (Node 18+) so no SDK dependency is required.
 *
 * Reads config from environment variables (see .env.example):
 *   GEMINI_API_KEY   - required; get one at https://aistudio.google.com/apikey
 *   GEMINI_MODEL     - optional, defaults to DEFAULT_GEMINI_MODEL below.
 *                      Model names change over time and free-tier quotas
 *                      differ per model, so set this explicitly to a model
 *                      your key can actually use (check AI Studio).
 *
 * The API key is sent in the `x-goog-api-key` header, never in the URL, so
 * it can't leak into proxy/access logs or error messages that echo a URL.
 * -----------------------------------------------------------------------
 */

'use strict';

const {
  makeError, truncate, extractRetryInfo, summarizeErrorBody, fetchText,
} = require('./aiUtil');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// A widely-available stable model; override with GEMINI_MODEL.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const MAX_PROMPT_CHARS = 12000;
const MAX_RESPONSE_CHARS = 2000;

/**
 * Call Gemini with a single user-turn prompt and return the generated text.
 * Throws with a `.code` of 'NO_API_KEY' | 'API_ERROR' | 'EMPTY_RESPONSE' |
 * 'ABORTED' (timeout) | 'CANCELLED' so callers can decide how to fall back.
 * HTTP failures also carry `.status`, and `.retryAfterMs` / `.dailyQuota`
 * when the response says how long to back off.
 */
async function callGemini(prompt, options = {}) {
  const {
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    temperature = 0.4,
    // Generous headroom: Gemini's newer models spend part of this budget on
    // internal reasoning before the visible answer, so a tight limit here
    // (e.g. ~380) reliably produces answers truncated mid-sentence.
    maxOutputTokens = 2048,
    timeoutMs = 20000,
    maxPromptChars = MAX_PROMPT_CHARS,
    maxResponseChars = MAX_RESPONSE_CHARS,
    signal,
  } = options;

  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) {
    throw makeError('GEMINI_API_KEY is not set', 'NO_API_KEY');
  }

  const modelId = String(model).trim().replace(/^models\//, '');
  if (!/^[A-Za-z0-9._-]+$/.test(modelId)) {
    throw makeError(`Invalid GEMINI_MODEL "${truncate(modelId, 60)}"`, 'API_ERROR');
  }

  const res = await fetchText(`${API_BASE}/${modelId}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: truncate(prompt, maxPromptChars) }] }],
      generationConfig: { temperature, maxOutputTokens, topP: 0.9 },
    }),
  }, { timeoutMs, signal, label: 'Gemini' });

  if (!res.ok) {
    const summary = summarizeErrorBody(res.bodyText, 300);
    throw makeError(
      `Gemini API responded ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${summary ? `: ${summary}` : ''}`,
      'API_ERROR',
      { status: res.status, ...extractRetryInfo(res.headers, res.bodyText) },
    );
  }

  let data;
  try {
    data = JSON.parse(res.bodyText);
  } catch {
    throw makeError('Gemini returned a non-JSON response', 'API_ERROR', { status: res.status });
  }

  // Skip "thought" parts (model reasoning) so they never leak into the narrative.
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    const finishReason = data?.candidates?.[0]?.finishReason;
    throw makeError(
      blockReason ? `Gemini blocked the response (${blockReason})`
        : finishReason && finishReason !== 'STOP' ? `Gemini returned no text (finishReason ${finishReason})`
          : 'Gemini returned an empty response',
      'EMPTY_RESPONSE',
    );
  }

  return { text: truncate(text, maxResponseChars), model: modelId };
}

module.exports = { callGemini, DEFAULT_GEMINI_MODEL };
