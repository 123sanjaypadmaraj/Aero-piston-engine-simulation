/**
 * geminiClient.js
 * -----------------------------------------------------------------------
 * Thin wrapper around the Gemini "generateContent" REST endpoint. Uses
 * Node's built-in fetch (Node 18+) so no SDK dependency is required.
 *
 * Reads config from environment variables (see .env.example):
 *   GEMINI_API_KEY   - required; get one at https://aistudio.google.com/apikey
 *   GEMINI_MODEL     - optional, defaults to 'gemini-2.0-flash'
 * -----------------------------------------------------------------------
 */

'use strict';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function makeError(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * Call Gemini with a single user-turn prompt and return the generated text.
 * Throws with a `.code` of 'NO_API_KEY' | 'API_ERROR' | 'EMPTY_RESPONSE' | 'ABORTED'
 * so callers can decide how to fall back.
 */
async function callGemini(prompt, options = {}) {
  const {
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    temperature = 0.4,
    // Generous headroom: Gemini's newer models spend part of this budget on
    // internal reasoning before the visible answer, so a tight limit here
    // (e.g. ~380) reliably produces answers truncated mid-sentence.
    maxOutputTokens = 2048,
    timeoutMs = 20000,
  } = options;

  if (!apiKey) {
    throw makeError('GEMINI_API_KEY is not set', 'NO_API_KEY');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${API_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens, topP: 0.9 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw makeError(`Gemini request timed out after ${timeoutMs}ms`, 'ABORTED');
    }
    throw makeError(`Gemini request failed: ${err.message}`, 'API_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw makeError(
      `Gemini API responded ${res.status} ${res.statusText}: ${bodyText.slice(0, 300)}`,
      'API_ERROR',
      { status: res.status },
    );
  }

  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw makeError(
      blockReason ? `Gemini blocked the response (${blockReason})` : 'Gemini returned an empty response',
      'EMPTY_RESPONSE',
    );
  }

  return { text, model };
}

module.exports = { callGemini };
