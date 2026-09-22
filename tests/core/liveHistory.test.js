'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the live-history store at a throwaway directory BEFORE first require.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-live-test-'));
process.env.TWIN_DATA_DIR = TMP;
const live = require('../../twin_core/liveHistoryStore');

test.after(() => {
  live.flushAll();
  delete process.env.TWIN_LIVE_HISTORY_MAX_LINES;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const BAD_IDS = ['..', '../x', 'a/b', 'a\\b', '', ' ', 'a b', 'x'.repeat(65), 'a.b', '.', 'con', 'NUL', 'com1', null, undefined, 42, {}, ['a']];

function readFileLines(engineId) {
  const file = path.join(TMP, 'live', `${engineId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  // corrupt/partial lines are production-skipped too; mirror that tolerance
  return fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

test('LIVE_DIR follows TWIN_DATA_DIR', () => {
  assert.equal(live.LIVE_DIR, path.resolve(TMP, 'live'));
});

test('invalid engineIds are rejected everywhere', () => {
  for (const bad of BAD_IDS) {
    assert.throws(() => live.append(bad, { a: 1 }), RangeError, `append(${String(bad)})`);
    assert.throws(() => live.read(bad), RangeError);
    assert.throws(() => live.flush(bad), RangeError);
    assert.throws(() => live.stats(bad), RangeError);
    assert.throws(() => live.clear(bad), RangeError);
  }
});

test('read() for a never-seen engine is empty and created nothing on disk', () => {
  assert.deepEqual(live.read('nobody'), []);
  assert.equal(fs.existsSync(path.join(TMP, 'live')), false);
});

test('append rejects non-object readings', () => {
  for (const bad of [null, undefined, 5, 'x', [1, 2]]) {
    assert.throws(() => live.append('e-obj', bad), TypeError);
  }
});

test('roundtrip: order and content survive; unit-test flush leaves no file', async () => {
  for (let i = 0; i < 25; i++) assert.equal(live.append('e-rt', { i, v: i * 1.5 }), true);
  // read-your-writes: no flush needed to see the data
  const before = live.read('e-rt');
  assert.equal(before.length, 25);
  assert.deepEqual(before.map((r) => r.i), [...Array(25).keys()]);
  assert.ok(before.every((r) => typeof r.t === 'number' && r.v === r.i * 1.5));
  // nothing on disk until flush
  assert.deepEqual(readFileLines('e-rt'), []);
  live.flush('e-rt');
  const onDisk = readFileLines('e-rt');
  assert.equal(onDisk.length, 25);
  assert.deepEqual(onDisk.map((r) => r.i), [...Array(25).keys()]);
  assert.equal(live.stats('e-rt').buffered, 0);
});

test('explicit reading.t wins over the append timestamp', () => {
  live.append('e-t', { t: 12345, x: 1 });
  live.flush('e-t');
  assert.equal(readFileLines('e-t')[0].t, 12345);
});

test('rolling window keeps only the newest N lines, in memory and on disk', () => {
  process.env.TWIN_LIVE_HISTORY_MAX_LINES = '5';
  for (let i = 0; i < 8; i++) live.append('e-cap', { i });
  const mem = live.read('e-cap').map((r) => r.i);
  assert.deepEqual(mem, [3, 4, 5, 6, 7]);
  assert.equal(live.stats('e-cap').count, 5);
  live.flush('e-cap');
  assert.deepEqual(readFileLines('e-cap').map((r) => r.i), [3, 4, 5, 6, 7]);
  delete process.env.TWIN_LIVE_HISTORY_MAX_LINES;
});

test('interleaved flushes never let the file exceed the cap', () => {
  process.env.TWIN_LIVE_HISTORY_MAX_LINES = '10';
  for (let i = 0; i < 30; i++) {
    live.append('e-fl', { i });
    if (i % 7 === 0) live.flush('e-fl'); // flush mid-stream to exercise append+roll paths
  }
  live.flush('e-fl');
  const onDisk = readFileLines('e-fl').map((r) => r.i);
  const mem = live.read('e-fl').map((r) => r.i);
  assert.equal(onDisk.length, 10);
  assert.deepEqual(onDisk, mem); // disk mirrors the memory ring exactly
  assert.deepEqual(onDisk, [...Array(30).keys()].slice(20)); // newest 10
  delete process.env.TWIN_LIVE_HISTORY_MAX_LINES;
});

test('crash recovery: an existing file is re-hydrated, corrupt lines skipped', (t) => {
  t.mock.method(console, 'error', () => {});
  const file = path.join(TMP, 'live', 'e-crash.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ t: 1, a: 1 }),
    'not json',
    JSON.stringify({ t: 2, a: 2 }),
    '{"t":3,"a":', // truncated mid-line
  ].join('\n');
  fs.writeFileSync(file, lines);
  assert.deepEqual(live.read('e-crash').map((r) => r.a), [1, 2]);
  assert.equal(live.stats('e-crash').persistedCount, 2);
  // appends continue after the recovered prefix
  live.append('e-crash', { a: 3 });
  live.flush('e-crash');
  assert.deepEqual(readFileLines('e-crash').map((r) => r.a), [1, 2, 3]);
});

test('clear removes memory and disk and is idempotent', () => {
  live.append('e-clr', { a: 1 });
  live.flush('e-clr');
  assert.equal(live.clear('e-clr'), true);
  assert.deepEqual(live.read('e-clr'), []);
  assert.equal(fs.existsSync(path.join(TMP, 'live', 'e-clr.jsonl')), false);
  assert.equal(live.clear('e-clr'), true);
});

test('flushAll flushes every pending buffer; flush is best-effort and never throws', () => {
  live.append('e-fa', { a: 1 });
  live.append('e-fb', { a: 2 });
  live.flushAll();
  assert.deepEqual(readFileLines('e-fa').map((r) => r.a), [1]);
  assert.deepEqual(readFileLines('e-fb').map((r) => r.a), [2]);
  assert.doesNotThrow(() => live.flush('e-fa'));
});