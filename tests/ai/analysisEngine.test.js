'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AiAnalysisEngine, buildPrompt, fallbackText, severityKey } = require('../../ai/analysisEngine');
const { retrieveContext, classifySignature } = require('../../ai/retriever');
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

test('refresh with a session override pool uses that pool and never the default', async (t) => {
  // The throwaway provider pool (as built by server.js for the session-only key)
  // must be the one queried, and a default-pool analysis for the same engine must
  // NOT be joined or share the override's key.
  const net = mockFetch({
    gemini: geminiOk('override pool answered'),
    groq: groqOk('default pool answered'),
  });
  t.after(net.restore);
  const clock = fakeClock();
  const ProviderPool = require('../../ai/providers').ProviderPool;
  const sessionKey = 'AIza-'.padEnd(25, 'x'); // not the env key — override only
  const sessionPool = new ProviderPool({
    env: { GEMINI_API_KEY: sessionKey, AI_PROVIDER_ORDER: 'gemini' },
    config: { gaps: { gemini: 0, groq: 0 } },
    now: clock.now, sleep: clock.sleep, logger: silentLogger(),
  });
  const { ai } = makeEngine({ env: bothKeys() }); // default pool has both env keys
  const r = await ai.refresh(engineSnap(), fleetSnap(), sessionPool);
  assert.equal(r.provider, 'gemini');
  assert.equal(r.text, 'override pool answered');
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].headers['x-goog-api-key'], sessionKey, 'override key used, not the env key');
  // A second (default) refresh on the same engine goes through the default pool.
  const r2 = await ai.refresh(engineSnap(), fleetSnap());
  assert.equal(r2.provider, 'gemini');
  assert.equal(net.calls.length, 2);
  sessionPool.close();
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

// --- runtime wiring of the deterministic verdict ---------------------------
// classifySignature() used to be exported and unit-tested but never CALLED by
// the analysis engine, so the "deterministic accident verdict" shipped as a
// documented feature that no request path actually executed. These tests pin
// the wiring: the verdict must be computed on every analysis, attached to the
// stored/emitted payload, handed to the prompt as a constraint, and survive a
// total provider failure (it is the safety floor, so it cannot depend on the
// LLM being reachable).

test('wiring: every analysis carries a deterministic verdict, LLM-free', async (t) => {
  const net = mockFetch({ gemini: geminiOk('Narrative text.') });
  t.after(net.restore);
  const { ai } = makeEngine();
  const r = await ai.refresh(engineSnap(), fleetSnap());
  assert.ok(r.verdict, 'analysis result must expose a verdict');
  assert.equal(typeof r.verdict.className, 'string');
  assert.ok(['accident', 'degradation', 'nominal'].includes(r.verdict.className));
  assert.ok(Array.isArray(r.verdict.patternIds));
  assert.ok(Array.isArray(r.verdict.evidence));
  assert.equal(r.verdict.accidentScore, 0, 'the nominal test engine must not score as an accident');
  ai.close();
});

test('wiring: accident verdict is attached when channels collapse together', async (t) => {
  const net = mockFetch({ gemini: geminiOk('Narrative text.') });
  t.after(net.restore);
  const { ai, emitted } = makeEngine();
  const crash = engineSnap({
    statuses: { rpm: 'critical', fuelFlow: 'critical', manifoldPressure: 'critical', cht: 'warning', egt: 'warning' },
  });
  const r = await ai.refresh(crash, fleetSnap());
  assert.equal(r.verdict.className, 'accident');
  assert.ok(r.verdict.accidentScore > 0);
  assert.ok(r.verdict.patternIds.includes('pattern-power-loss'));
  // it must reach the client, not just the internal store
  assert.equal(emitted.at(-1).event, 'ai-analysis');
  assert.equal(emitted.at(-1).payload.verdict.className, 'accident');
  ai.close();
});

test('wiring: verdict survives provider failure (safety floor must not need the LLM)', async (t) => {
  const net = mockFetch({ gemini: errorResponse(500, 'upstream boom'), groq: errorResponse(500, 'upstream boom') });
  t.after(net.restore);
  const { ai } = makeEngine();
  const crash = engineSnap({
    statuses: { rpm: 'critical', fuelFlow: 'critical', manifoldPressure: 'critical' },
  });
  const r = await ai.refresh(crash, fleetSnap());
  assert.equal(r.degraded, true, 'expected the rule-based fallback path');
  assert.ok(r.verdict, 'the degraded path must still carry the verdict');
  assert.equal(r.verdict.className, 'accident', 'an accident must be reported even with no LLM available');
  ai.close();
});

test('wiring: prompt carries the verdict as an explicit constraint', () => {
  const crash = engineSnap({
    statuses: { rpm: 'critical', fuelFlow: 'critical', manifoldPressure: 'critical' },
  });
  const docs = retrieveContext(crash);
  const p = buildPrompt(crash, fleetSnap(), docs, classifySignature(crash));
  assert.match(p, /DETERMINISTIC FAULT VERDICT/);
  assert.match(p, /Classification: accident/);
  assert.match(p, /pattern-power-loss/);
  assert.match(p, /treat as authoritative/i, 'the LLM must be told not to contradict the classification');
});

test('wiring: prompt still builds when no verdict is supplied (back-compat)', () => {
  const p = buildPrompt(engineSnap(), fleetSnap(), retrieveContext(engineSnap()));
  assert.doesNotThrow(() => p);
  assert.ok(!p.includes('undefined'), 'no undefined leaks into the prompt');
  assert.ok(!p.includes('NaN'));
});
