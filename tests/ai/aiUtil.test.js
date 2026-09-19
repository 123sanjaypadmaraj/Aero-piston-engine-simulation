'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redactSecrets, parseRetryAfterHeader, parseDurationMs, extractRetryInfo, truncate, summarizeErrorBody,
} = require('../../ai/aiUtil');
const { classifyError } = require('../../ai/providers');
const { callGemini } = require('../../ai/geminiClient');
const { callGroq } = require('../../ai/groqClient');
const {
  GEMINI_KEY, GROQ_KEY, geminiOk, groqOk, errorResponse, mockFetch, hang,
} = require('./_helpers');

test('Retry-After header: seconds and HTTP-date', () => {
  assert.equal(parseRetryAfterHeader('30'), 30000);
  assert.equal(parseRetryAfterHeader('1.5'), 1500);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfterHeader('Thu, 01 Jan 2026 00:01:00 GMT', now), 60000);
  assert.equal(parseRetryAfterHeader('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
  assert.equal(parseRetryAfterHeader('garbage'), null);
  assert.equal(parseRetryAfterHeader(''), null);
  assert.equal(parseRetryAfterHeader(null), null);
});

test('duration text: gemini retryDelay and groq "try again in"', () => {
  assert.equal(parseDurationMs('34s'), 34000);
  assert.equal(parseDurationMs('34.5s'), 34500);
  assert.equal(parseDurationMs('7m12.5s'), 432500);
  assert.equal(parseDurationMs('250ms'), 250);
  assert.equal(parseDurationMs('1h2m'), 3720000);
  assert.equal(parseDurationMs('soon'), null);

  const h = new Headers();
  assert.equal(extractRetryInfo(h, '{"error":{"details":[{"retryDelay":"34s"}]}}').retryAfterMs, 34000);
  assert.equal(extractRetryInfo(h, 'Please retry in 34.5s.').retryAfterMs, 34500);
  assert.equal(extractRetryInfo(h, 'Rate limit reached. Please try again in 7m12.5s. Need more?').retryAfterMs, 432500);
  assert.equal(extractRetryInfo(new Headers({ 'retry-after': '9' }), 'try again in 1m').retryAfterMs, 9000, 'header wins');
  assert.equal(extractRetryInfo(h, 'nothing useful').retryAfterMs, null);
  assert.equal(extractRetryInfo(h, 'GenerateRequestsPerDayPerProjectPerModel').dailyQuota, true);
});

test('redactSecrets masks keys by shape and by literal', () => {
  const text = `GET https://x/?key=${GEMINI_KEY}&a=1 Authorization: Bearer ${GROQ_KEY} x-goog-api-key: ${GEMINI_KEY} custom=MYCUSTOMSECRET99`;
  const out = redactSecrets(text, ['MYCUSTOMSECRET99']);
  for (const secret of [GEMINI_KEY, GROQ_KEY, 'MYCUSTOMSECRET99']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('a=1'));
  assert.equal(redactSecrets(undefined), '');
});

test('redactSecrets also masks keys currently in the environment', () => {
  const prev = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'plain-looking-secret-value';
  try {
    assert.ok(!redactSecrets('oops plain-looking-secret-value leaked').includes('plain-looking'));
  } finally {
    if (prev === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prev;
  }
});

test('truncate and summarizeErrorBody', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.ok(truncate('abcdefghij', 5).length <= 5);
  assert.equal(summarizeErrorBody('{"error":{"message":"quota out"}}'), 'quota out');
  assert.equal(summarizeErrorBody('<html>  bad   gateway </html>'), '<html> bad gateway </html>');
  assert.equal(summarizeErrorBody(''), '');
});

test('classifyError', () => {
  const k = (e) => classifyError(e).kind;
  assert.equal(k({ status: 429 }), 'quota');
  assert.equal(k({ status: 402 }), 'quota');
  assert.equal(k({ status: 401 }), 'auth');
  assert.equal(k({ status: 403 }), 'auth');
  assert.equal(k({ status: 400, message: 'API key not valid' }), 'auth');
  assert.equal(k({ status: 400, message: 'bad field' }), 'failure');
  assert.equal(k({ status: 503 }), 'transient');
  assert.equal(k({ code: 'ABORTED' }), 'transient');
  assert.equal(k({ code: 'API_ERROR' }), 'transient');
  assert.equal(k({ code: 'EMPTY_RESPONSE' }), 'failure');
  assert.equal(k({ code: 'CANCELLED' }), 'cancelled');
});

test('callGemini/callGroq exports still work directly', async (t) => {
  const net = mockFetch({ gemini: geminiOk('g'), groq: groqOk('q') });
  t.after(net.restore);
  assert.deepEqual(await callGemini('p', { apiKey: GEMINI_KEY, model: 'gemini-test' }), { text: 'g', model: 'gemini-test' });
  assert.deepEqual(await callGroq('p', { apiKey: GROQ_KEY, model: 'llama-x' }), { text: 'q', model: 'groq:llama-x' });
  assert.match(net.calls[0].url, /models\/gemini-test:generateContent$/);
  assert.equal(net.calls[1].headers.Authorization, `Bearer ${GROQ_KEY}`);
});

test('clients: missing key throws NO_API_KEY; HTTP error carries status and retry hint', async (t) => {
  const net = mockFetch({ gemini: errorResponse(429, 'quota', { 'Retry-After': '7' }), groq: errorResponse(503, 'down') });
  t.after(net.restore);
  await assert.rejects(callGemini('p', { apiKey: '' }), (e) => e.code === 'NO_API_KEY');
  await assert.rejects(callGroq('p', { apiKey: '   ' }), (e) => e.code === 'NO_API_KEY');
  await assert.rejects(callGemini('p', { apiKey: GEMINI_KEY }), (e) => e.status === 429 && e.retryAfterMs === 7000 && e.code === 'API_ERROR');
  await assert.rejects(callGroq('p', { apiKey: GROQ_KEY }), (e) => e.status === 503);
  await assert.rejects(callGemini('p', { apiKey: GEMINI_KEY, model: 'bad/model?x=1' }), (e) => /Invalid GEMINI_MODEL/.test(e.message));
});

test('clients: timeout, external abort', async (t) => {
  const net = mockFetch({ gemini: hang });
  t.after(net.restore);
  await assert.rejects(callGemini('p', { apiKey: GEMINI_KEY, timeoutMs: 20 }), (e) => e.code === 'ABORTED' && /timed out after 20ms/.test(e.message));
  const ac = new AbortController();
  const pending = callGemini('p', { apiKey: GEMINI_KEY, timeoutMs: 5000, signal: ac.signal });
  setImmediate(() => ac.abort());
  await assert.rejects(pending, (e) => e.code === 'CANCELLED');
});

test('clients: empty, blocked and malformed bodies', async (t) => {
  const net = mockFetch({
    gemini: [new Response('{"candidates":[]}', { status: 200 }), new Response('not json', { status: 200 }),
      new Response('{"promptFeedback":{"blockReason":"SAFETY"}}', { status: 200 })],
    groq: [new Response('{"choices":[{"message":{"content":"  "}}]}', { status: 200 })],
  });
  t.after(net.restore);
  await assert.rejects(callGemini('p', { apiKey: GEMINI_KEY }), (e) => e.code === 'EMPTY_RESPONSE');
  await assert.rejects(callGemini('p', { apiKey: GEMINI_KEY }), (e) => e.code === 'API_ERROR' && /non-JSON/.test(e.message));
  await assert.rejects(callGemini('p', { apiKey: GEMINI_KEY }), (e) => e.code === 'EMPTY_RESPONSE' && /SAFETY/.test(e.message));
  await assert.rejects(callGroq('p', { apiKey: GROQ_KEY }), (e) => e.code === 'EMPTY_RESPONSE');
});
