'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the store at a throwaway directory BEFORE anything can write.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-store-test-'));
process.env.TWIN_DATA_DIR = TMP;
const store = require('../../twin_core/store');

test.after(() => {
  store.flushAll();
  delete process.env.TWIN_MAX_MISSIONS_PER_ENGINE;
  delete process.env.TWIN_MAX_READINGS_PER_MISSION;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const BAD_IDS = ['..', '../x', '../../etc/passwd', 'a/b', 'a\\b', '', ' ', 'a b', 'x'.repeat(65), 'a.b', '.', 'con', 'NUL', 'com1', null, undefined, 42, {}, ['a']];

test('DATA_DIR follows TWIN_DATA_DIR', () => {
  assert.equal(store.DATA_DIR, path.resolve(TMP));
});

test('path traversal / malformed ids are rejected everywhere', async () => {
  for (const bad of BAD_IDS) {
    assert.throws(() => store.listMissions(bad), RangeError, `listMissions(${String(bad)})`);
    assert.throws(() => store.appendReading(bad, 'm1', { a: 1 }), RangeError);
    assert.throws(() => store.appendReading('e1', bad, { a: 1 }), RangeError);
    assert.throws(() => store.flushMission(bad, 'm1'), RangeError);
    assert.throws(() => store.flushMission('e1', bad), RangeError);
    await assert.rejects(store.readMission(bad, 'm1'), RangeError);
    await assert.rejects(store.readMission('e1', bad), RangeError);
  }
  // nothing was created outside (or inside) the data dir by the attempts above
  assert.deepEqual(fs.readdirSync(TMP), []);
  assert.equal(fs.existsSync(path.join(TMP, '..', 'x')), false);
});

test('valid ids of max length and with - and _ are accepted', () => {
  assert.doesNotThrow(() => store.listMissions('A_b-9'));
  assert.doesNotThrow(() => store.listMissions('z'.repeat(64)));
});

test('appendReading rejects non-object readings', () => {
  for (const bad of [null, undefined, 5, 'x', [1, 2]]) {
    assert.throws(() => store.appendReading('e-obj', 'm-obj', bad), TypeError);
  }
});

test('roundtrip: order and content survive, listMissions reports the file', async () => {
  for (let i = 0; i < 25; i++) assert.equal(store.appendReading('e-rt', 'm-rt', { i, v: i * 1.5 }), true);
  // readMission sees buffered-but-unflushed data (read-your-writes)
  const before = await store.readMission('e-rt', 'm-rt');
  assert.equal(before.length, 25);
  store.flushMission('e-rt', 'm-rt');
  const readings = await store.readMission('e-rt', 'm-rt');
  assert.equal(readings.length, 25);
  assert.deepEqual(readings.map((r) => r.i), [...Array(25).keys()]);
  assert.ok(readings.every((r) => typeof r.t === 'number' && r.v === r.i * 1.5));
  const list = store.listMissions('e-rt');
  assert.equal(list.length, 1);
  assert.equal(list[0].missionId, 'm-rt');
  assert.ok(list[0].sizeBytes > 0);
  assert.ok(!Number.isNaN(Date.parse(list[0].modifiedAt)));
});

test('explicit reading.t wins over the append timestamp', async () => {
  store.appendReading('e-t', 'm-t', { t: 12345, x: 1 });
  store.flushMission('e-t', 'm-t');
  assert.equal((await store.readMission('e-t', 'm-t'))[0].t, 12345);
});

test('unknown engine/mission read as empty', async () => {
  assert.deepEqual(store.listMissions('nobody'), []);
  assert.deepEqual(await store.readMission('nobody', 'nothing'), []);
  assert.deepEqual(await store.readMission('e-rt', 'nothing'), []);
});

test('corrupt, partial and non-object lines are skipped, not thrown', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = path.join(TMP, 'e-bad');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ t: 1, ok: 1 }),
    '{"t":2,"ok":',            // truncated mid-write
    'not json at all',
    '',
    '   ',
    'null',
    '42',
    '[1,2,3]',
    JSON.stringify({ t: 3, ok: 3 }),
    '{"t":4,"ok":4',           // partial last line, no trailing newline
  ];
  fs.writeFileSync(path.join(dir, 'm-bad.jsonl'), lines.join('\n'));
  const readings = await store.readMission('e-bad', 'm-bad');
  assert.deepEqual(readings.map((r) => r.ok), [1, 3]);
});

test('CRLF files are read correctly', async () => {
  const dir = path.join(TMP, 'e-crlf');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'm.jsonl'), '{"a":1}\r\n{"a":2}\r\n');
  assert.deepEqual((await store.readMission('e-crlf', 'm')).map((r) => r.a), [1, 2]);
});

test('iterateMission streams readings one at a time', async () => {
  for (let i = 0; i < 10; i++) store.appendReading('e-it', 'm-it', { i });
  store.flushMission('e-it', 'm-it');
  let n = 0;
  for await (const r of store.iterateMission('e-it', 'm-it')) {
    assert.equal(r.i, n++);
    if (n === 3) break; // early exit must release the file handle without throwing
  }
  assert.equal(n, 3);
});

test('retention: only the newest N missions per engine are kept', () => {
  process.env.TWIN_MAX_MISSIONS_PER_ENGINE = '3';
  const base = Date.now() / 1000 - 1000;
  for (let i = 0; i < 6; i++) {
    store.appendReading('e-ret', `m${i}`, { i });
    store.flushMission('e-ret', `m${i}`);
    // give each recording a distinct, increasing mtime regardless of fs timestamp resolution
    fs.utimesSync(path.join(TMP, 'e-ret', `m${i}.jsonl`), base + i, base + i);
  }
  const ids = store.listMissions('e-ret').map((m) => m.missionId).sort();
  assert.deepEqual(ids, ['m3', 'm4', 'm5']);
  // another engine is unaffected
  assert.ok(store.listMissions('e-rt').length >= 1);
  delete process.env.TWIN_MAX_MISSIONS_PER_ENGINE;
});

test('retention never deletes the mission being written', () => {
  process.env.TWIN_MAX_MISSIONS_PER_ENGINE = '1';
  const old = Date.now() / 1000 + 5000; // pre-existing file with a *newer* mtime than the active one
  const dir = path.join(TMP, 'e-prot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'future.jsonl'), '{"a":1}\n');
  fs.utimesSync(path.join(dir, 'future.jsonl'), old, old);
  store.appendReading('e-prot', 'active', { a: 2 });
  store.flushMission('e-prot', 'active');
  assert.ok(store.listMissions('e-prot').some((m) => m.missionId === 'active'));
  delete process.env.TWIN_MAX_MISSIONS_PER_ENGINE;
});

test('per-mission reading cap drops extra readings', async () => {
  process.env.TWIN_MAX_READINGS_PER_MISSION = '5';
  const results = [];
  for (let i = 0; i < 8; i++) results.push(store.appendReading('e-cap', 'm-cap', { i }));
  assert.deepEqual(results, [true, true, true, true, true, false, false, false]);
  store.flushMission('e-cap', 'm-cap');
  assert.equal((await store.readMission('e-cap', 'm-cap')).length, 5);
  // the cap also counts what is already on disk when a mission is appended to later
  assert.equal(store.appendReading('e-cap', 'm-cap', { i: 99 }), false);
  store.flushMission('e-cap', 'm-cap');
  delete process.env.TWIN_MAX_READINGS_PER_MISSION;
});

test('interleaved concurrent missions stay complete and ordered', async () => {
  const ids = ['ma', 'mb', 'mc'];
  const N = 2500; // crosses the internal auto-flush batch size
  for (let i = 0; i < N; i++) for (const id of ids) store.appendReading('e-cc', id, { i, id });
  store.flushAll();
  for (const id of ids) {
    const readings = await store.readMission('e-cc', id);
    assert.equal(readings.length, N, id);
    assert.ok(readings.every((r, idx) => r.i === idx && r.id === id), `${id} ordered`);
  }
});

test('flushAll flushes everything pending and is idempotent', async () => {
  store.appendReading('e-fa', 'm', { a: 1 });
  store.flushAll();
  store.flushAll();
  assert.equal((await store.readMission('e-fa', 'm')).length, 1);
});

test('ensureDir / isWritable report on the data directory', () => {
  assert.equal(store.ensureDir(), path.resolve(TMP));
  assert.equal(store.isWritable(), true);
  assert.deepEqual(fs.readdirSync(TMP).filter((n) => n.startsWith('.write-probe')), []);

  // a data dir that cannot be created (its parent is a regular file) is "not writable", not an exception
  const blocker = path.join(TMP, 'blocker.txt');
  fs.writeFileSync(blocker, 'x');
  const saved = process.env.TWIN_DATA_DIR;
  process.env.TWIN_DATA_DIR = path.join(blocker, 'sub');
  try {
    assert.equal(store.isWritable(), false);
    assert.throws(() => store.ensureDir());
  } finally {
    process.env.TWIN_DATA_DIR = saved;
  }
  assert.equal(store.isWritable(), true);
});

test('a failing flush is logged, not thrown', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const saved = process.env.TWIN_DATA_DIR;
  const blocker = path.join(TMP, 'blocker2.txt');
  fs.writeFileSync(blocker, 'x');
  process.env.TWIN_DATA_DIR = path.join(blocker, 'sub');
  try {
    store.appendReading('e-fail', 'm', { a: 1 });
    assert.doesNotThrow(() => store.flushMission('e-fail', 'm'));
    assert.equal(err.mock.callCount(), 1);
  } finally {
    process.env.TWIN_DATA_DIR = saved;
  }
});
