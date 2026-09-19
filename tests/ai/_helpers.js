/**
 * Shared test helpers for tests/ai: a scriptable fetch mock (never touches
 * the network), a fake clock and small snapshot factories.
 */

'use strict';

const GEMINI_KEY = 'AIzaSyFAKEKEYFORTESTS1234567890abcd';
const GROQ_KEY = 'gsk_FAKEKEYFORTESTS1234567890abcdef';

const geminiOk = (text = 'Gemini says all good.') => new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);
const groqOk = (text = 'Groq says all good.') => new Response(
  JSON.stringify({ choices: [{ message: { content: text } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);
const errorResponse = (status, message = 'boom', headers = {}, extra = {}) => new Response(
  JSON.stringify({ error: { code: status, message, ...extra } }),
  { status, statusText: 'Test', headers: { 'Content-Type': 'application/json', ...headers } },
);

/**
 * Replace global.fetch with a router: `routes` maps 'gemini' | 'groq' to a
 * function (callIndex, request) => Response | Promise<Response>, or to an
 * array of Responses/functions consumed in order (last one repeats).
 * Returns { calls, restore }.
 */
function mockFetch(routes) {
  const original = global.fetch;
  const calls = [];
  const counters = { gemini: 0, groq: 0 };
  global.fetch = async (url, init = {}) => {
    const provider = String(url).includes('generativelanguage.googleapis.com') ? 'gemini'
      : String(url).includes('api.groq.com') ? 'groq' : 'other';
    if (provider === 'other') throw new Error(`unexpected fetch to ${url}`);
    const call = {
      provider, url: String(url), headers: init.headers || {}, body: init.body, signal: init.signal,
    };
    calls.push(call);
    const idx = counters[provider]++;
    let handler = routes[provider];
    if (Array.isArray(handler)) handler = handler[Math.min(idx, handler.length - 1)];
    if (!handler) throw new Error(`no route for ${provider}`);
    return typeof handler === 'function' ? handler(idx, call) : handler.clone();
  };
  return { calls, restore: () => { global.fetch = original; } };
}

/** A fetch handler that never answers but rejects when its signal aborts (like real fetch). */
const hang = (_i, call) => new Promise((_, reject) => {
  call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

function fakeClock(start = 1_000_000) {
  const clock = {
    t: start,
    sleeps: [],
    now: () => clock.t,
    sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; },
    advance: (ms) => { clock.t += ms; },
  };
  return clock;
}

function silentLogger() {
  const lines = [];
  return {
    lines,
    warn: (m) => lines.push(`warn ${m}`),
    log: (m) => lines.push(`log ${m}`),
  };
}

const bothKeys = () => ({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY });

function engineSnap(overrides = {}) {
  return {
    id: 'uav-01',
    tail: 'RQ-M1 "Falcon"',
    engine: 'Rotax-912 iS (sim)',
    time: '2026-01-01T00:00:00.000Z',
    readings: { rpm: 5000, cht: 130 },
    statuses: { rpm: 'nominal', cht: 'nominal' },
    health: 97,
    rul: 500,
    activeFault: null,
    predictedFault: null,
    alerts: [],
    altitude: 100,
    airspeed: 90,
    hoursFlown: 1,
    ...overrides,
  };
}

const fleetSnap = (engines = [engineSnap()]) => ({
  time: '2026-01-01T00:00:00.000Z',
  engines,
  fleet: {
    avgHealth: 97, missionReliability: 97, criticalCount: 0, engineCount: engines.length,
  },
});

module.exports = {
  GEMINI_KEY,
  GROQ_KEY,
  geminiOk,
  groqOk,
  errorResponse,
  mockFetch,
  hang,
  fakeClock,
  silentLogger,
  bothKeys,
  engineSnap,
  fleetSnap,
};
