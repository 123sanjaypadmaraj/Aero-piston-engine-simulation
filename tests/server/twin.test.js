'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the live-history writes from the repo's twin_core/data (lazy-read env).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-server-test-'));
process.env.TWIN_DATA_DIR = TMP;

const { startTestServer, request } = require('./helpers');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('twin persistence surface', async () => {
  const s = await startTestServer();
  try {
    const snap = await request(s.port, { path: '/api/snapshot' });
    const id = snap.json.engines[0].id;

    // history accumulates per fleet engine and is bounded/structured
    const hist = await request(s.port, { path: `/api/history/${id}` });
    assert.equal(hist.status, 200);
    assert.equal(hist.json.engineId, id);
    assert.ok(Array.isArray(hist.json.readings) && hist.json.readings.length >= 1);
    assert.ok(Number.isFinite(hist.json.updatedAt));
    assert.ok(hist.json.readings.every((r) => typeof r.readings === 'object' && Number.isFinite(r.health)));
    assert.ok(hist.json.readings.every((r) => typeof r.time === 'string'));

    // path/traversal + unknown-engine handling matches /api/series
    assert.equal((await request(s.port, { path: '/api/history/nope' })).status, 404);
    assert.equal((await request(s.port, { path: '/api/history/bad%20id' })).status, 400);

    // maintenance digest covers every fleet engine with a stable shape
    const maint = await request(s.port, { path: '/api/maintenance' });
    assert.equal(maint.status, 200);
    assert.equal(maint.json.engines.length, snap.json.engines.length);
    const first = maint.json.engines[0];
    assert.ok(first.engineId && first.tail);
    assert.ok(Number.isFinite(first.health));
    assert.ok(Array.isArray(first.flags));
    assert.ok(first.recommendation === null || typeof first.recommendation === 'string');
    assert.ok(first.forecast && Array.isArray(first.forecast.sensors));
    assert.ok('eolHours' in first.forecast && 'healthEolHours' in first.forecast);

    // the in-memory stateStore cache is populated per engine (exposed for tests)
    const cache = s.ctx.stateStore.getAll();
    assert.deepEqual(Object.keys(cache).sort(), snap.json.engines.map((e) => e.id).sort());
    assert.ok(Number.isFinite(cache[id].health) && cache[id].readings.rpm);

    // persistence actually lands on disk under the pinned data dir
    s.ctx.liveHistory.flush(id);
    const file = path.join(TMP, 'live', `${id}.jsonl`);
    assert.equal(fs.existsSync(file), true);
    assert.ok(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length >= 1);
  } finally {
    await s.ctx.stop();
  }
});

test('live history honours TWIN_LIVE_HISTORY_ENABLED=false', async () => {
  const s = await startTestServer({ liveHistoryEnabled: false });
  try {
    const snap = await request(s.port, { path: '/api/snapshot' });
    const id = snap.json.engines[0].id;
    // The previous server in this process shares the module-global store: clear
    // its leftover memory/disk state so this test only sees its own (empty) ring.
    s.ctx.liveHistory.clear(id);
    const hist = await request(s.port, { path: `/api/history/${id}` });
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.json.readings, []);
    // give the live tick a chance; persistence stays off, so the history must
    // remain empty and nothing may be written to disk
    await new Promise((resolve) => setTimeout(resolve, 150));
    const later = await request(s.port, { path: `/api/history/${id}` });
    assert.deepEqual(later.json.readings, []);
    assert.equal(fs.existsSync(path.join(TMP, 'live', `${id}.jsonl`)), false);
    // stateStore cache is still populated even with persistence off
    assert.ok(s.ctx.stateStore.get(id));
  } finally {
    await s.ctx.stop();
  }
});