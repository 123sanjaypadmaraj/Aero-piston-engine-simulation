'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AiAnalysisEngine, buildPrompt, fallbackText, severityKey } = require('../../ai/analysisEngine');
const { retrieveContext } = require('../../ai/retriever');
const { KNOWLEDGE_BASE } = require('../../ai/knowledgeBase');
const {
  GEMINI_KEY, geminiOk, groqOk, errorResponse, mockFetch, fakeClock, silentLogger, bothKeys, engineSnap, fleetSnap,
} = require('./_helpers');

function makeEngine({ env = bothKeys(), clock = fakeClock(), config = { gaps: { gemini: 0, groq: 0 } } } = {}) {
  const emitted = [];
  const io = { emit: (event, payload) => emitted.push({ event, payload }) };
  const logger = silentLogger();
  const ai = new AiAnalysisEngine({
    io, env, now: clock.now, sleep: clock.sleep, logger, config,
  });
  return { ai, emitted, clock, logger };
}

const CONTRACT_KEYS = ['text', 'model', 'provider', 'fallbackUsed', 'degraded', 'generatedAt', 'severityKey', 'sources', 'error'];

test('gemini success: contract fields, socket emit, cached', async (t) => {
  const net = mockFetch({ gemini: geminiOk('All nominal for Falcon.') });
  t.after(net.restore);
  const { ai, emitted } = makeEngine();
  const r = await ai.refresh(engineSnap(), fleetSnap());
  for (const k of CONTRACT_KEYS) assert.ok(k in r, `missing ${k}`);
  assert.equal(r.provider, 'gemini');
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.degraded, false);
  assert.equal(r.error, null);
  assert.ok(r.sources.length > 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai-analysis');
  assert.equal(emitted[0].payload.engineId, 'uav-01');
  assert.equal(ai.latest('uav-01'), r);
  assert.deepEqual(Object.keys(ai.allLatest()), ['uav-01']);
  ai.close();
});

test('gemini 429 -> groq answers: provider groq, fallbackUsed true, not degraded', async (t) => {
  const net = mockFetch({ gemini: errorResponse(429, 'You exceeded your current quota'), groq: groqOk('Groq narrative.') });
  t.after(net.restore);
  const { ai, clock } = makeEngine();
  const r = await ai.refresh(engineSnap(), fleetSnap());
  assert.equal(r.provider, 'groq');
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.degraded, false);
  assert.equal(r.error, null);
  assert.match(r.fallbackReason, /Gemini/);
  assert.match(r.model, /^groq:/);
  assert.equal(r.cooldownUntil, clock.now() + 300000);
  ai.close();
});

test('both providers fail: degraded static fallback with combined reason', async (t) => {
  const net = mockFetch({ gemini: errorResponse(429, 'quota gone'), groq: errorResponse(429, 'groq limit') });
  t.after(net.restore);
  const { ai, emitted } = makeEngine();
  const r = await ai.refresh(engineSnap({ health: 61, statuses: { cht: 'warning' } }), fleetSnap());
  assert.equal(r.degraded, true);
  assert.equal(r.provider, null);
  assert.equal(r.model, null);
  assert.equal(r.fallbackUsed, false);
  assert.match(r.error, /Gemini: .*quota gone/);
  assert.match(r.error, /Groq: .*groq limit/);
  assert.match(r.text, /attention needed on cht/);
  assert.deepEqual(r.sources, []);
  assert.ok(r.cooldownUntil > 0);
  assert.equal(emitted.length, 1);
  ai.close();
});

test('no keys: instant static fallback, no fetch, no sleeping', async (t) => {
  const net = mockFetch({});
  t.after(net.restore);
  const { ai, clock } = makeEngine({ env: {} });
  const started = Date.now();
  const r = await ai.refresh(engineSnap(), fleetSnap());
  assert.ok(Date.now() - started < 500);
  assert.equal(r.degraded, true);
  assert.equal(r.provider, null);
  assert.match(r.error, /No AI provider configured/);
  assert.equal(r.cooldownUntil, null);
  assert.equal(net.calls.length, 0);
  assert.deepEqual(clock.sleeps, []);
  ai.close();
});

test('all providers cooling down: instant fallback naming the cooldown, no request', async (t) => {
  const net = mockFetch({ gemini: errorResponse(429, 'q'), groq: errorResponse(429, 'q') });
  t.after(net.restore);
  const { ai, clock } = makeEngine();
  await ai.refresh(engineSnap(), fleetSnap());
  const calls = net.calls.length;
  clock.sleeps.length = 0;
  const r = await ai.refresh(engineSnap(), fleetSnap());
  assert.equal(net.calls.length, calls);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(r.degraded, true);
  assert.match(r.error, /cooling down/);
  ai.close();
});

test('onFleetTick throttles, re-analyzes on severity change, and retries a degraded engine when the cooldown ends', async (t) => {
  const net = mockFetch({
    gemini: [errorResponse(429, 'q', { 'Retry-After': '120' }), geminiOk('Gemini is back.')],
    groq: errorResponse(500, 'groq down'),
  });
  t.after(net.restore);
  const { ai, clock } = makeEngine({ config: { gaps: { gemini: 0, groq: 0 }, retryBackoffMs: 1 } });
  const settle = async () => { while (ai._inFlight.size) await Promise.all([...ai._inFlight.values()]); };

  ai.onFleetTick(fleetSnap());
  await settle();
  assert.equal(ai.latest('uav-01').degraded, true);
  const callsAfterFirst = net.calls.length;

  clock.advance(30000); // still cooling down, same severity: nothing new
  ai.onFleetTick(fleetSnap());
  await settle();
  assert.equal(net.calls.length, callsAfterFirst);

  clock.advance(100000); // cooldown over
  ai.onFleetTick(fleetSnap());
  await settle();
  assert.equal(ai.latest('uav-01').degraded, false);
  assert.equal(ai.latest('uav-01').text, 'Gemini is back.');

  // Same severity + fresh: no new request; severity change: new request.
  const n = net.calls.length;
  ai.onFleetTick(fleetSnap());
  await settle();
  assert.equal(net.calls.length, n);
  ai.onFleetTick(fleetSnap([engineSnap({ statuses: { cht: 'critical' } })]));
  await settle();
  assert.ok(net.calls.length > n);
  ai.close();
});

test('a forced refresh joins the analysis already in flight', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const net = mockFetch({ gemini: async () => { await gate; return geminiOk('one'); } });
  t.after(net.restore);
  const { ai } = makeEngine({ env: { GEMINI_API_KEY: GEMINI_KEY } });
  const a = ai.refresh(engineSnap(), fleetSnap());
  const b = ai.refresh(engineSnap(), fleetSnap());
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb);
  assert.equal(net.calls.length, 1);
  ai.close();
});

test('close() stops emitting and does not hang on a pending gap sleep', async (t) => {
  const net = mockFetch({ gemini: geminiOk('x') });
  t.after(net.restore);
  const emitted = [];
  const ai = new AiAnalysisEngine({
    io: { emit: (...a) => emitted.push(a) },
    env: { GEMINI_API_KEY: GEMINI_KEY },
    config: { gaps: { gemini: 60000 } },
    logger: silentLogger(),
  });
  await ai.refresh(engineSnap(), fleetSnap());
  const pending = ai.refresh(engineSnap({ id: 'uav-02' }), fleetSnap());
  await new Promise((r) => setImmediate(r));
  ai.close();
  await pending;
  assert.equal(emitted.length, 1, 'nothing emitted after close');
  ai.onFleetTick(fleetSnap()); // no-op after close
});

test('the analysis cache is bounded', () => {
  const { ai } = makeEngine({ env: {} });
  for (let i = 0; i < 300; i += 1) ai._store(`e${i}`, { text: 'x' });
  assert.equal(ai.byEngine.size, 256);
  ai.close();
});

test('emit failures do not break analysis', async (t) => {
  const net = mockFetch({ gemini: geminiOk('x') });
  t.after(net.restore);
  const ai = new AiAnalysisEngine({
    io: { emit: () => { throw new Error('socket down'); } },
    env: { GEMINI_API_KEY: GEMINI_KEY },
    logger: silentLogger(),
  });
  const r = await ai.refresh(engineSnap(), fleetSnap());
  assert.equal(r.text, 'x');
  ai.close();
});

test('prompt building tolerates missing/NaN data', () => {
  const snap = { id: 'x', health: NaN, rul: undefined, alerts: null, statuses: null };
  const prompt = buildPrompt(snap, {}, []);
  assert.match(prompt, /no specific domain notes matched/);
  assert.match(prompt, /mission reliability unknown/);
  assert.ok(!prompt.includes('NaN'));
  assert.doesNotThrow(() => buildPrompt(null, null, null));
  const bigAlerts = engineSnap({ alerts: Array.from({ length: 50 }, () => ({ message: 'a'.repeat(5000) })) });
  assert.ok(buildPrompt(bigAlerts, fleetSnap(), retrieveContext(bigAlerts)).length < 10000);
});

test('fallbackText and severityKey handle NaN health / missing fields', () => {
  assert.match(fallbackText({ id: 'u', health: NaN, statuses: {} }, 'why'), /^u: all monitored parameters nominal, health unknown\./);
  assert.match(fallbackText(engineSnap({ health: 50, statuses: { rpm: 'critical' } }), 'why'), /health 50%, attention needed on rpm/);
  assert.equal(severityKey({}), 'nominal||');
  assert.equal(severityKey(engineSnap({ statuses: { a: 'warning', b: 'critical' }, activeFault: { type: 'oilLoss' } })), 'critical|oilLoss|');
});

test('retriever: empty/unknown input still yields grounding context', () => {
  for (const snap of [null, undefined, {}, { activeFault: { type: 'martian' } }, { activeFault: {} }, { statuses: 'bad' }]) {
    const docs = retrieveContext(snap);
    assert.ok(docs.length > 0);
    assert.ok(docs.length <= 5);
  }
  assert.equal(retrieveContext({}, NaN).length, 5);
  assert.equal(retrieveContext({}, 2).length, 2);
});

test('retriever ranks the active fault and its critical sensors first', () => {
  const docs = retrieveContext(engineSnap({ activeFault: { type: 'oilLoss' }, statuses: { oilPressure: 'critical' } }));
  assert.equal(docs[0].id, 'fault-oilLoss');
  assert.ok(docs.some((d) => d.id === 'sensor-oilPressure'));
  assert.ok(Object.isFrozen(KNOWLEDGE_BASE));
});
