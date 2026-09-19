'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startTestServer, request } = require('./helpers');

describe('ADMIN_API_KEY guard', () => {
  const KEY = 'test-admin-key-123';

  test('off: mutating routes are open', async () => {
    const s = await startTestServer();
    try {
      const r = await request(s.port, { method: 'POST', path: '/api/engine-sim/run', body: { durationSeconds: 1 } });
      assert.equal(r.status, 400); // validation, not 401
    } finally { await s.ctx.stop(); }
  });

  test('on: POST requires a matching x-api-key; GET stays open', async () => {
    const s = await startTestServer({ adminApiKey: KEY });
    try {
      const post = (headers) => request(s.port, { method: 'POST', path: '/api/engine-sim/run', body: { durationSeconds: 1 }, headers });
      assert.equal((await post({})).status, 401);
      assert.equal((await post({ 'x-api-key': 'wrong-key-000000' })).status, 401);
      assert.equal((await post({ 'x-api-key': KEY.slice(0, -1) })).status, 401);
      assert.equal((await post({ 'x-api-key': KEY })).status, 400); // passed the guard, failed validation
      const denied = await post({});
      assert.equal(denied.json.error, 'unauthorized');
      assert.equal((await request(s.port, { path: '/api/snapshot' })).status, 200);
      assert.equal((await request(s.port, { path: '/api/health' })).status, 200);
      assert.equal((await request(s.port, { method: 'POST', path: '/api/ai-analysis/x/refresh' })).status, 401);
    } finally { await s.ctx.stop(); }
  });
});

describe('rate limiting', () => {
  test('general limiter returns 429 JSON with RateLimit headers; probes are exempt', async () => {
    const s = await startTestServer({ rateLimit: { windowMs: 60000, max: 3, heavyMax: 100 } });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await request(s.port, { path: '/api/meta' })).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      const limited = await request(s.port, { path: '/api/meta' });
      assert.equal(limited.json.error, 'too many requests');
      assert.ok(limited.headers.ratelimit || limited.headers['ratelimit-policy']);
      for (let i = 0; i < 6; i++) assert.equal((await request(s.port, { path: '/api/health' })).status, 200);
      assert.equal((await request(s.port, { path: '/api/ready' })).status, 200);
    } finally { await s.ctx.stop(); }
  });

  test('heavy limiter is stricter on expensive POST routes', async () => {
    const s = await startTestServer({ rateLimit: { windowMs: 60000, max: 1000, heavyMax: 2 } });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await request(s.port, { method: 'POST', path: '/api/ai-analysis/nope/refresh' })).status);
      }
      assert.deepEqual(statuses, [404, 404, 429, 429]);
      assert.equal((await request(s.port, { path: '/api/meta' })).status, 200);
    } finally { await s.ctx.stop(); }
  });
});

describe('CORS allowlist', () => {
  test('allowlisted origin gets ACAO; others do not', async () => {
    const s = await startTestServer({ corsOrigins: ['http://allowed.example'] });
    try {
      const ok = await request(s.port, { path: '/api/meta', headers: { Origin: 'http://allowed.example' } });
      assert.equal(ok.headers['access-control-allow-origin'], 'http://allowed.example');
      const bad = await request(s.port, { path: '/api/meta', headers: { Origin: 'http://evil.example' } });
      assert.equal(bad.headers['access-control-allow-origin'], undefined);
      const none = await request(s.port, { path: '/api/meta' });
      assert.equal(none.status, 200);
      const pre = await request(s.port, {
        method: 'OPTIONS',
        path: '/api/engine-sim/run',
        headers: { Origin: 'http://allowed.example', 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(pre.headers['access-control-allow-origin'], 'http://allowed.example');
    } finally { await s.ctx.stop(); }
  });

  test('empty allowlist (production default) is same-origin only', async () => {
    const s = await startTestServer({ corsOrigins: [] });
    try {
      const r = await request(s.port, { path: '/api/meta', headers: { Origin: 'http://anything.example' } });
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    } finally { await s.ctx.stop(); }
  });

  test('permissive mode (null) allows any origin', async () => {
    const s = await startTestServer({ corsOrigins: null });
    try {
      const r = await request(s.port, { path: '/api/meta', headers: { Origin: 'http://anything.example' } });
      assert.equal(r.headers['access-control-allow-origin'], '*');
    } finally { await s.ctx.stop(); }
  });
});

// Raw engine.io/socket.io wire protocol over `ws` (no socket.io-client dependency).
function openSocket(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { headers });
    const packets = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === '2') return ws.send('3'); // ping -> pong
      if (msg.startsWith('0')) return ws.send('40'); // engine.io open -> connect default namespace
      packets.push(msg);
      return waiters.splice(0).forEach((w) => w());
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    const next = (pred) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for packet')), 3000);
      const check = () => {
        const hit = packets.find(pred);
        if (hit) { clearTimeout(t); res(hit); } else waiters.push(check);
      };
      check();
    });
    ws.on('open', () => resolve({ ws, next }));
  });
}

describe('Socket.IO', () => {
  test('new clients get a snapshot with serverTime', async () => {
    const s = await startTestServer();
    try {
      const { ws, next } = await openSocket(s.port);
      const pkt = await next((m) => m.startsWith('42["snapshot"'));
      const [, payload] = JSON.parse(pkt.slice(2));
      assert.equal(typeof payload.serverTime, 'number');
      assert.ok(Array.isArray(payload.engines));
      ws.close();
    } finally { await s.ctx.stop(); }
  });

  test('live ticks also carry serverTime', async () => {
    const s = await startTestServer({ tickMs: 50 });
    try {
      const { ws, next } = await openSocket(s.port);
      await next((m) => m.startsWith('42["snapshot"'));
      // a second snapshot can only come from the tick loop
      const seen = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no tick snapshot')), 3000);
        let count = 0;
        ws.on('message', (d) => {
          const m = d.toString();
          if (m.startsWith('42["snapshot"') && ++count >= 1) { clearTimeout(t); resolve(JSON.parse(m.slice(2))[1]); }
        });
      });
      assert.equal(typeof seen.serverTime, 'number');
      ws.close();
    } finally { await s.ctx.stop(); }
  });

  test('per-IP connection cap refuses excess sockets', async () => {
    const s = await startTestServer({ socketMaxPerIp: 1 });
    try {
      const a = await openSocket(s.port);
      await a.next((m) => m.startsWith('40{'));
      const b = await openSocket(s.port);
      const err = await b.next((m) => m.startsWith('44'));
      assert.match(err, /too many connections/);
      a.ws.close();
      b.ws.close();
    } finally { await s.ctx.stop(); }
  });

  test('websocket upgrade from a non-allowlisted origin is rejected', async () => {
    const s = await startTestServer({ corsOrigins: ['http://allowed.example'] });
    try {
      await assert.rejects(openSocket(s.port, { Origin: 'http://evil.example' }));
      const ok = await openSocket(s.port, { Origin: 'http://allowed.example' });
      await ok.next((m) => m.startsWith('40{'));
      ok.ws.close();
    } finally { await s.ctx.stop(); }
  });
});

describe('graceful stop', () => {
  test('stop() disconnects live sockets, clears timers and closes the server', async () => {
    const s = await startTestServer();
    const { ws, next } = await openSocket(s.port);
    await next((m) => m.startsWith('40{'));
    const closed = new Promise((resolve) => ws.on('close', resolve));
    await s.ctx.stop();
    await closed;
    assert.equal(s.ctx.server.listening, false);
    // node:test only finishes if no handle (tick interval, open socket) keeps the event loop alive.
  });
});
