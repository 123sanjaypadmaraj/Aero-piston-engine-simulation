'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('./helpers');

describe('core API', () => {
  let s;
  before(async () => { s = await startTestServer(); });
  after(async () => { await s.ctx.stop(); });

  test('GET /api/health is cheap liveness', async () => {
    const r = await request(s.port, { path: '/api/health' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.uptime, 'number');
  });

  test('GET /api/ready reports 200 with passing checks', async () => {
    const r = await request(s.port, { path: '/api/ready' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ready: true, checks: { fleet: true, store: true } });
  });

  test('GET /api/snapshot includes numeric serverTime and engines', async () => {
    const before = Date.now();
    const r = await request(s.port, { path: '/api/snapshot' });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.serverTime, 'number');
    assert.ok(r.json.serverTime >= before - 1000 && r.json.serverTime <= Date.now() + 1000);
    assert.ok(Array.isArray(r.json.engines) && r.json.engines.length > 0);
  });

  test('existing read routes keep their shapes', async () => {
    const meta = await request(s.port, { path: '/api/meta' });
    assert.ok(meta.json.sensors && meta.json.faultTypes);
    const profiles = await request(s.port, { path: '/api/engine-sim/profiles' });
    assert.ok(Array.isArray(profiles.json) && profiles.json[0].id);
    const alerts = await request(s.port, { path: '/api/alerts' });
    assert.ok(Array.isArray(alerts.json));
    const ai = await request(s.port, { path: '/api/ai-analysis' });
    assert.deepEqual(ai.json, {});
  });

  test('serves the dashboard with security headers and no x-powered-by', async () => {
    const r = await request(s.port, { path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.text, /<html/i);
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /https:\/\/cdnjs\.cloudflare\.com/);
    assert.match(csp, /'sha256-/); // hash for the inline importmap
    assert.match(csp, /connect-src[^;]*wss:/);
  });

  test('sends X-Request-Id and echoes a sane inbound one', async () => {
    const a = await request(s.port, { path: '/api/health' });
    assert.ok(a.headers['x-request-id']);
    const b = await request(s.port, { path: '/api/health', headers: { 'X-Request-Id': 'abc-123' } });
    assert.equal(b.headers['x-request-id'], 'abc-123');
    const c = await request(s.port, { path: '/api/health', headers: { 'X-Request-Id': 'bad id!' } });
    assert.notEqual(c.headers['x-request-id'], 'bad id!');
  });

  test('unknown routes return JSON 404', async () => {
    const r = await request(s.port, { path: '/api/does-not-exist' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not found' });
    const r2 = await request(s.port, { path: '/nope' });
    assert.equal(r2.status, 404);
    assert.ok(r2.json.error);
  });

  test('malformed and oversized JSON bodies get 400 / 413 JSON errors', async () => {
    const bad = await request(s.port, { method: 'POST', path: '/api/engine-sim/run', body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'malformed JSON body');
    const big = await request(s.port, { method: 'POST', path: '/api/engine-sim/run', body: { pad: 'x'.repeat(200 * 1024) } });
    assert.equal(big.status, 413);
    assert.ok(big.json.error);
  });

  test('AI refresh: unknown engine 404, known engine passes through', async () => {
    const no = await request(s.port, { method: 'POST', path: '/api/ai-analysis/nope/refresh' });
    assert.equal(no.status, 404);
    const snap = await request(s.port, { path: '/api/snapshot' });
    const id = snap.json.engines[0].id;
    const ok = await request(s.port, { method: 'POST', path: `/api/ai-analysis/${id}/refresh` });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.text, 'stub');
  });

  test('GET /api/series validates ids', async () => {
    assert.equal((await request(s.port, { path: '/api/series/nope' })).status, 404);
    assert.equal((await request(s.port, { path: '/api/series/bad%20id' })).status, 400);
    const snap = await request(s.port, { path: '/api/snapshot' });
    const ok = await request(s.port, { path: `/api/series/${snap.json.engines[0].id}` });
    assert.equal(ok.status, 200);
  });
});

describe('lifecycle', () => {
  test('stop() is idempotent and the port closes', async () => {
    const s = await startTestServer();
    await Promise.all([s.ctx.stop(), s.ctx.stop()]);
    await assert.rejects(request(s.port, { path: '/api/health' }));
  });
});
