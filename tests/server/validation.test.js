'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('./helpers');

describe('input validation', () => {
  let s;
  // Generous limits: this file is about validation, not throttling.
  before(async () => { s = await startTestServer({ rateLimit: { windowMs: 60000, max: 10000, heavyMax: 10000 } }); });
  after(async () => { await s.ctx.stop(); });

  const run = (body) => request(s.port, { method: 'POST', path: '/api/engine-sim/run', body });

  test('engine-sim/run rejects bad engineId values', async () => {
    for (const engineId of ['../etc', 'a/b', 'a\\b', '', 'x'.repeat(65), 'a.b', 42, null, 'CON', 'nul']) {
      const r = await run({ engineId });
      assert.equal(r.status, 400, `engineId ${JSON.stringify(engineId)} -> ${r.status}`);
      assert.ok(r.json.error);
    }
  });

  test('engine-sim/run rejects unknown / prototype profile ids', async () => {
    for (const profileId of ['nope', '__proto__', 'constructor', 7]) {
      assert.equal((await run({ profileId })).status, 400, String(profileId));
    }
  });

  test('engine-sim/run rejects out-of-range or non-numeric durations and steps', async () => {
    for (const durationSeconds of [9, 14401, -5, '100', null]) {
      assert.equal((await run({ durationSeconds })).status, 400, `duration ${durationSeconds}`);
    }
    for (const dtSeconds of [0.4, 31, 0, '2']) {
      assert.equal((await run({ durationSeconds: 60, dtSeconds })).status, 400, `dt ${dtSeconds}`);
    }
  });

  test('engine-sim/run rejects bad faultTypes and non-object bodies', async () => {
    assert.equal((await run({ faultTypes: 'overheat' })).status, 400);
    assert.equal((await run({ faultTypes: ['nope'] })).status, 400);
    assert.equal((await run({ faultTypes: [1] })).status, 400);
    assert.equal((await run({ faultTypes: ['overheat', 'overheat', 'oilLoss', 'vibration', 'fuelStarvation'] })).status, 400);
    assert.equal((await run([1, 2])).status, 400);
  });

  test('recordings routes block path traversal and bad ids', async () => {
    const paths = [
      '/api/engine-sim/recordings/..%2f..%2fetc',
      '/api/engine-sim/recordings/..%5c..%5cwindows',
      '/api/engine-sim/recordings/%2e%2e',
      '/api/engine-sim/recordings/uav-01/..%2f..%2fsecret',
      '/api/engine-sim/recordings/..%2f/x',
      '/api/engine-sim/recordings/uav-01/bad.id',
      '/api/engine-sim/recordings/uav-01/%00',
    ];
    for (const p of paths) {
      const r = await request(s.port, { path: p });
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    }
    // Ones that reach the handler must specifically be validation failures.
    assert.equal((await request(s.port, { path: '/api/engine-sim/recordings/..%2f..%2fetc' })).status, 400);
    assert.equal((await request(s.port, { path: '/api/engine-sim/recordings/uav-01/..%2f..%2fsecret' })).status, 400);
    assert.equal((await request(s.port, { path: '/api/engine-sim/recordings/%2e%2e' })).status, 400);
  });

  test('valid but nonexistent recordings return 404 / empty list', async () => {
    const list = await request(s.port, { path: '/api/engine-sim/recordings/no-such-engine' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json, []);
    const one = await request(s.port, { path: '/api/engine-sim/recordings/no-such-engine/no-such-mission' });
    assert.equal(one.status, 404);
  });

  test('replay start validates ids, speed and mission existence', async () => {
    const post = (p, body) => request(s.port, { method: 'POST', path: p, body });
    assert.equal((await post('/api/engine-sim/replay/..%2fx/m1')).status, 400);
    assert.equal((await post('/api/engine-sim/replay/uav-01/..%2fx')).status, 400);
    assert.equal((await post('/api/engine-sim/replay/uav-01/m1', { speed: 0 })).status, 400);
    assert.equal((await post('/api/engine-sim/replay/uav-01/m1', { speed: 1000 })).status, 400);
    assert.equal((await post('/api/engine-sim/replay/uav-01/m1', { speed: 'fast' })).status, 400);
    assert.equal((await post('/api/engine-sim/replay/no-such-engine/m1', { speed: 2 })).status, 404);
  });

  test('replay control validates action and value before looking up a player', async () => {
    const ctl = (body, id = 'uav-01') => request(s.port, { method: 'POST', path: `/api/engine-sim/replay/${id}/control`, body });
    assert.equal((await ctl({ action: 'explode' })).status, 400);
    assert.equal((await ctl({})).status, 400);
    assert.equal((await ctl({ action: 'speed', value: 0 })).status, 400);
    assert.equal((await ctl({ action: 'speed', value: 101 })).status, 400);
    assert.equal((await ctl({ action: 'seek', value: -1 })).status, 400);
    assert.equal((await ctl({ action: 'seek', value: 'half' })).status, 400);
    assert.equal((await ctl({ action: 'pause' }, '..%2fx')).status, 400);
    assert.equal((await ctl({ action: 'pause' })).status, 404); // valid, but nothing is playing
    assert.equal((await ctl({ action: 'speed', value: 2 })).status, 404);
  });

  test('ai-analysis routes validate engine ids', async () => {
    assert.equal((await request(s.port, { path: '/api/ai-analysis/..%2fx' })).status, 400);
    assert.equal((await request(s.port, { path: '/api/ai-analysis/unknown-engine' })).status, 404);
    assert.equal((await request(s.port, { method: 'POST', path: '/api/ai-analysis/..%2fx/refresh' })).status, 400);
  });
});
