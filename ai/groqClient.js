/**
 * groqClient.js
 * -----------------------------------------------------------------------
 * Thin wrapper around Groq's OpenAI-compatible chat completions endpoint.
 * Used as a fallback when Gemini is unavailable (see providers.js). Uses
 * Node's built-in fetch.
 *
 * Reads config from environment variables (see .env.example):
 *   GROQ_API_KEY   - required; get one at https://console.groq.com/keys
 *   GROQ_MODEL     - optional, defaults to 'llama-3.3-70b-versatile'
 *
 * The key goes in the Authorization header only and is redacted from any
 * error message this module produces.
 * -----------------------------------------------------------------------
 */

'use strict';

const {
  makeError, truncate, extractRetryInfo, summarizeErrorBody, fetchText,
} = require('./aiUtil');

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MAX_PROMPT_CHARS = 12000;
const MAX_RESPONSE_CHARS = 2000;

/**
 * Call Groq with a single user-turn prompt and return the generated text.
 * Throws with a `.code` of 'NO_API_KEY' | 'API_ERROR' | 'EMPTY_RESPONSE' |
 * 'ABORTED' | 'CANCELLED', matching geminiClient.js (HTTP failures also
 * carry `.status` and, when known, `.retryAfterMs`).
 */
async function callGroq(prompt, options = {}) {
  const {
    apiKey = process.env.GROQ_API_KEY,
    model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    temperature = 0.4,
    maxTokens = 1024,
    timeoutMs = 20000,
    maxPromptChars = MAX_PROMPT_CHARS,
    maxResponseChars = MAX_RESPONSE_CHARS,
    signal,
  } = options;

  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) {
    throw makeError('GROQ_API_KEY is not set', 'NO_API_KEY');
  }

  const res = await fetchText(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: truncate(prompt, maxPromptChars) }],
      temperature,
      max_tokens: maxTokens,
      top_p: 0.9,
    }),
  }, { timeoutMs, signal, label: 'Groq' });

  if (!res.ok) {
    const summary = summarizeErrorBody(res.bodyText, 300);
    throw makeError(
      `Groq API responded ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${summary ? `: ${summary}` : ''}`,
      'API_ERROR',
      { status: res.status, ...extractRetryInfo(res.headers, res.bodyText) },
    );
  }

  let data;
  try {
    data = JSON.parse(res.bodyText);
  } catch {
    throw makeError('Groq returned a non-JSON response', 'API_ERROR', { status: res.status });
  }

  const content = data?.choices?.[0]?.message?.content;
  const text = (typeof content === 'string' ? content : '').trim();

  if (!text) {
    throw makeError('Groq returned an empty response', 'EMPTY_RESPONSE');
  }

  return { text: truncate(text, maxResponseChars), model: `groq:${model}` };
}

module.exports = { callGroq };
