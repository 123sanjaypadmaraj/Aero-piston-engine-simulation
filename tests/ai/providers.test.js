'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderPool } = require('../../ai/providers');
const {
  GEMINI_KEY, GROQ_KEY, geminiOk, groqOk, errorResponse, mockFetch, hang, fakeClock, silentLogger, bothKeys,
} = require('./_helpers');

function makePool({ env = bothKeys(), config = {}, clock = fakeClock(), logger = silentLogger() } = {}) {
  const pool = new ProviderPool({
    env, config, now: clock.now, sleep: clock.sleep, logger, random: () => 0,
  });
  return { pool, clock, logger };
}

test('gemini success: key goes in x-goog-api-key header, never the URL', async (t) => {
  const net = mockFetch({ gemini: geminiOk('Engine nominal.') });
  t.after(net.restore);
  const { pool } = makePool();
  const r = await pool.generate('hello');
  assert.equal(r.provider, 'gemini');
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.text, 'Engine nominal.');
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].headers['x-goog-api-key'], GEMINI_KEY);
  assert.ok(!net.calls[0].url.includes('key='), 'key must not be in the URL');
  assert.ok(!net.calls[0].url.includes(GEMINI_KEY));
  pool.close();
});

test('gemini 429 falls back to groq with correct flags, then gemini is skipped without a request', async (t) => {
  const net = mockFetch({
    gemini: errorResponse(429, 'You exceeded your current quota'),
    groq: groqOk('Groq answer.'),
  });
  t.after(net.restore);
  const { pool, clock } = makePool({ config: { gaps: { groq: 0, gemini: 0 } } });

  const r1 = await pool.generate('p');
  assert.equal(r1.provider, 'groq');
  assert.equal(r1.fallbackUsed, true);
  assert.match(r1.fallbackReason, /Gemini/);
  assert.equal(r1.cooldownUntil, clock.now() + 300000);
  assert.equal(net.calls.filter((c) => c.provider === 'gemini').length, 1);

  const r2 = await pool.generate('p');
  assert.equal(r2.provider, 'groq');
  assert.equal(net.calls.filter((c) => c.provider === 'gemini').length, 1, 'gemini must not be called while cooling down');
  pool.close();
});

test('cooldown honours Retry-After and recovers after it elapses', async (t) => {
  const net = mockFetch({
    gemini: [errorResponse(429, 'slow down', { 'Retry-After': '30' }), geminiOk('Back again.')],
    groq: groqOk('Groq.'),
  });
  t.after(net.restore);
  const logger = silentLogger();
  const { pool, clock } = makePool({ logger, config: { gaps: { gemini: 0, groq: 0 } } });

  const r1 = await pool.generate('p');
  assert.equal(r1.provider, 'groq');
  assert.equal(pool.status().providers[0].cooldownUntil, clock.now() + 30000);

  clock.advance(29000);
  assert.equal((await pool.generate('p')).provider, 'groq');
  assert.equal(net.calls.filter((c) => c.provider === 'gemini').length, 1);

  clock.advance(2000);
  const r3 = await pool.generate('p');
  assert.equal(r3.provider, 'gemini');
  assert.equal(r3.fallbackUsed, false);
  assert.equal(pool.status().providers[0].cooldownUntil, null);

  const starts = logger.lines.filter((l) => /cooling down for/.test(l));
  const ends = logger.lines.filter((l) => /cooldown ended/.test(l));
  assert.equal(starts.length, 1, 'cooldown start logged once');
  assert.equal(ends.length, 1, 'cooldown end logged once');
  pool.close();
});

test('Gemini retryDelay in the error body sets the cooldown', async (t) => {
  const body = { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] };
  const net = mockFetch({ gemini: errorResponse(429, 'quota', {}, body), groq: groqOk() });
  t.after(net.restore);
  const { pool, clock } = makePool();
  await pool.generate('p');
  assert.equal(pool.status().providers[0].cooldownUntil, clock.now() + 12000);
  pool.close();
});

test('auth errors cool down for an hour; 400 invalid key counts as auth', async (t) => {
  const net = mockFetch({
    gemini: errorResponse(400, 'API key not valid. Please pass a valid API key.'),
    groq: errorResponse(401, 'Invalid API Key'),
  });
  t.after(net.restore);
  const { pool, clock } = makePool();
  await assert.rejects(pool.generate('p'), (err) => err.code === 'ALL_PROVIDERS_FAILED');
  const [g, q] = pool.status().providers;
  assert.equal(g.cooldownUntil, clock.now() + 3600000);
  assert.equal(q.cooldownUntil, clock.now() + 3600000);
  pool.close();
});

test('both providers fail: rejects with combined reason; next call makes no request', async (t) => {
  const net = mockFetch({ gemini: errorResponse(429, 'quota'), groq: errorResponse(429, 'rate limited') });
  t.after(net.restore);
  const { pool, clock } = makePool();
  await assert.rejects(pool.generate('p'), (err) => {
    assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
    assert.match(err.message, /Gemini: .*quota/);
    assert.match(err.message, /Groq: .*rate limited/);
    assert.equal(err.attempted, true);
    return true;
  });
  const before = net.calls.length;
  const sleepsBefore = clock.sleeps.length;
  await assert.rejects(pool.generate('p'), (err) => {
    assert.equal(err.code, 'ALL_COOLING_DOWN');
    assert.equal(err.attempted, false);
    assert.ok(err.cooldownUntil > 0);
    return true;
  });
  assert.equal(net.calls.length, before);
  assert.equal(clock.sleeps.length, sleepsBefore, 'no sleeping when everything is cooling down');
  pool.close();
});

test('no keys: immediate NO_PROVIDERS without fetch or sleeping', async (t) => {
  const net = mockFetch({});
  t.after(net.restore);
  const { pool, clock } = makePool({ env: {} });
  await assert.rejects(pool.generate('p'), (err) => {
    assert.equal(err.code, 'NO_PROVIDERS');
    assert.match(err.message, /No AI provider configured/);
    return true;
  });
  assert.equal(net.calls.length, 0);
  assert.deepEqual(clock.sleeps, []);
  pool.close();
});

test('unkeyed primary is skipped silently; groq alone is not labelled a fallback', async (t) => {
  const net = mockFetch({ groq: groqOk('Only groq.') });
  t.after(net.restore);
  const { pool } = makePool({ env: { GROQ_API_KEY: GROQ_KEY } });
  const r = await pool.generate('p');
  assert.equal(r.provider, 'groq');
  assert.equal(r.fallbackUsed, false);
  assert.equal(net.calls.some((c) => c.provider === 'gemini'), false);
  pool.close();
});

test('AI_PROVIDER_ORDER changes which provider is asked first', async (t) => {
  const net = mockFetch({ gemini: geminiOk(), groq: groqOk('Groq first.') });
  t.after(net.restore);
  const { pool } = makePool({ env: { ...bothKeys(), AI_PROVIDER_ORDER: 'groq, gemini, bogus, groq' } });
  assert.deepEqual(pool.order, ['groq', 'gemini']);
  const r = await pool.generate('p');
  assert.equal(r.provider, 'groq');
  assert.equal(r.fallbackUsed, false);
  assert.equal(net.calls.length, 1);
  pool.close();
});

test('gap is per provider and only slept before a real request', async (t) => {
  const net = mockFetch({ gemini: [geminiOk(), errorResponse(429, 'quota', { 'Retry-After': '600' })], groq: groqOk() });
  t.after(net.restore);
  const { pool, clock } = makePool({ config: { gaps: { gemini: 13000, groq: 2000 } } });

  await pool.generate('p'); // first ever call: no gap
  assert.deepEqual(clock.sleeps, []);

  await pool.generate('p'); // gemini again -> waits its own gap, then 429 -> groq (never called before: no gap)
  assert.deepEqual(clock.sleeps, [13000]);

  clock.sleeps.length = 0;
  await pool.generate('p'); // gemini cooling: skipped, no gemini gap; groq only waits for its own (2s) gap
  assert.ok(!clock.sleeps.includes(13000), 'gemini gap must not be slept while it is cooling down');
  pool.close();
});

test('calls queued behind a 429 skip the cooling provider instead of sleeping its gap', async (t) => {
  const net = mockFetch({ gemini: errorResponse(429, 'quota'), groq: groqOk() });
  t.after(net.restore);
  const { pool, clock } = makePool({ config: { gaps: { gemini: 13000, groq: 0 } } });
  const results = await Promise.all([pool.generate('a'), pool.generate('b'), pool.generate('c')]);
  assert.ok(results.every((r) => r.provider === 'groq'));
  assert.equal(net.calls.filter((c) => c.provider === 'gemini').length, 1);
  assert.ok(!clock.sleeps.includes(13000));
  pool.close();
});

test('timeout: retried once, then counted; 3 consecutive failures start a 60s cooldown', async (t) => {
  const net = mockFetch({ gemini: hang });
  t.after(net.restore);
  const { pool, clock } = makePool({
    env: { GEMINI_API_KEY: GEMINI_KEY },
    config: { timeoutMs: 15, gaps: { gemini: 0 } },
  });
  for (let i = 1; i <= 3; i += 1) {
    await assert.rejects(pool.generate('p'), (err) => /timed out after 15ms/.test(err.message));
    assert.equal(net.calls.length, i * 2, 'each generate = 1 request + 1 retry');
    if (i < 3) assert.equal(pool.status().providers[0].cooldownUntil, null);
  }
  assert.equal(pool.status().providers[0].cooldownUntil, clock.now() + 60000);
  await assert.rejects(pool.generate('p'), (err) => err.code === 'ALL_COOLING_DOWN');
  assert.equal(net.calls.length, 6, 'no request while cooling down');
  pool.close();
});

test('5xx is retried once with backoff and can succeed', async (t) => {
  const net = mockFetch({ gemini: [errorResponse(503, 'overloaded'), geminiOk('Recovered.')] });
  t.after(net.restore);
  const { pool, clock } = makePool({ env: { GEMINI_API_KEY: GEMINI_KEY }, config: { gaps: { gemini: 0 } } });
  const r = await pool.generate('p');
  assert.equal(r.text, 'Recovered.');
  assert.equal(net.calls.length, 2);
  assert.deepEqual(clock.sleeps, [400]); // base backoff, random() = 0
  assert.equal(pool.status().providers[0].consecutiveFailures, 0);
  pool.close();
});

test('errors and logs never contain API keys', async (t) => {
  const leaky = errorResponse(500, `bad request for https://x/?key=${GEMINI_KEY} and Bearer ${GROQ_KEY}`);
  const net = mockFetch({ gemini: leaky, groq: errorResponse(403, `denied ${GROQ_KEY}`) });
  t.after(net.restore);
  const { pool, logger } = makePool();
  let message = '';
  await assert.rejects(pool.generate('p'), (err) => { message = err.message; return true; });
  const everything = [message, ...logger.lines].join('\n');
  assert.ok(!everything.includes(GEMINI_KEY));
  assert.ok(!everything.includes(GROQ_KEY));
  assert.ok(everything.includes('[REDACTED]'));
  pool.close();
});

test('response text is validated and length-capped; thought parts are dropped', async (t) => {
  const long = 'x'.repeat(5000);
  const res = new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'secret reasoning', thought: true }, { text: long }] } }],
  }), { status: 200 });
  const net = mockFetch({ gemini: res });
  t.after(net.restore);
  const { pool } = makePool({ env: { GEMINI_API_KEY: GEMINI_KEY }, config: { maxResponseChars: 100 } });
  const r = await pool.generate('p');
  assert.ok(r.text.length <= 100);
  assert.ok(!r.text.includes('secret'));
  pool.close();
});

test('prompt is capped before sending', async (t) => {
  const net = mockFetch({ gemini: geminiOk() });
  t.after(net.restore);
  const { pool } = makePool({ env: { GEMINI_API_KEY: GEMINI_KEY }, config: { maxPromptChars: 500 } });
  await pool.generate('y'.repeat(100000));
  const sent = JSON.parse(net.calls[0].body).contents[0].parts[0].text;
  assert.ok(sent.length <= 500);
  pool.close();
});

test('close() wakes a request sleeping on the gap and rejects with CLOSED; later calls reject', async (t) => {
  const net = mockFetch({ gemini: geminiOk() });
  t.after(net.restore);
  const pool = new ProviderPool({
    env: { GEMINI_API_KEY: GEMINI_KEY }, config: { gaps: { gemini: 60000 } }, logger: silentLogger(),
  });
  await pool.generate('first');
  const pending = pool.generate('second'); // sleeps ~60s on a real (unref'd) timer
  await new Promise((r) => setImmediate(r));
  pool.close();
  await assert.rejects(pending, (err) => err.code === 'CLOSED');
  await assert.rejects(pool.generate('third'), (err) => err.code === 'CLOSED');
  assert.equal(net.calls.length, 1);
});

test('queue is bounded per provider; overflow goes to the next provider', async (t) => {
  const net = mockFetch({ gemini: hang, groq: groqOk('via groq') });
  t.after(net.restore);
  const { pool } = makePool({ config: { maxQueue: 2, timeoutMs: 30, gaps: { gemini: 0, groq: 0 } } });
  const all = await Promise.all([1, 2, 3, 4].map(() => pool.generate('p')));
  assert.ok(all.every((r) => r.provider === 'groq'));
  pool.close();
});
