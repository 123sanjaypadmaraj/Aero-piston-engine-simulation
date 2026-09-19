'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-replay-test-'));
process.env.TWIN_DATA_DIR = TMP;
const store = require('../../twin_core/store');
const { missionRunner, replayEngine } = require('../../replay');
const { runMission } = missionRunner;
const { createPlayer } = replayEngine;

test.after(() => {
  store.flushAll();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls instead of guessing a sleep: timer granularity / CPU contention make fixed sleeps flaky.
async function waitFor(cond, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}
const profileFn = (elapsedSeconds) => ({ elapsedSeconds });
const stepFn = (_c, dt) => ({ v: dt, activeFault: null });
const base = { engineId: 'e-run', profileFn, stepFn, durationSeconds: 20, dtSeconds: 2 };

// ---------------------------------------------------------------- runMission

test('runMission validates durationSeconds and dtSeconds', async () => {
  const badDurations = [undefined, null, NaN, Infinity, -1, 0, 9.99, 14400.01, '100', {}];
  for (const durationSeconds of badDurations) {
    await assert.rejects(runMission({ ...base, durationSeconds }), RangeError, `duration ${String(durationSeconds)}`);
  }
  const badDts = [NaN, Infinity, 0, -2, 0.49, 30.01, '2', null];
  for (const dtSeconds of badDts) {
    await assert.rejects(runMission({ ...base, dtSeconds }), RangeError, `dt ${String(dtSeconds)}`);
  }
});

test('runMission accepts the bounds themselves', async () => {
  const a = await runMission({ ...base, missionId: 'edge-a', durationSeconds: 10, dtSeconds: 30 });
  assert.equal(a.tickCount, 1);
  const b = await runMission({ ...base, missionId: 'edge-b', durationSeconds: 10, dtSeconds: 0.5 });
  assert.equal(b.tickCount, 20);
});

test('runMission validates collaborators and ids', async () => {
  await assert.rejects(runMission({ ...base, profileFn: undefined }), TypeError);
  await assert.rejects(runMission({ ...base, stepFn: 'nope' }), TypeError);
  await assert.rejects(runMission({ ...base, onTick: 5 }), TypeError);
  await assert.rejects(runMission({ ...base, engineId: '../evil' }), RangeError);
  await assert.rejects(runMission({ ...base, engineId: undefined }), RangeError);
  await assert.rejects(runMission({ ...base, missionId: '..\\evil' }), RangeError);
  await assert.rejects(runMission(), TypeError);
});

test('runMission records every tick and returns a summary', async () => {
  const ticks = [];
  const summary = await runMission({
    ...base,
    profileId: 'unit',
    missionId: 'sum-1',
    durationSeconds: 20,
    dtSeconds: 2,
    stepFn: (_c, dt) => ({ readings: { a: 1, b: 10, junk: NaN }, elapsedS: ticks.length * dt }),
    onTick: (_r, elapsed, n) => ticks.push([elapsed, n]),
  });
  assert.equal(summary.missionId, 'sum-1');
  assert.equal(summary.engineId, 'e-run');
  assert.equal(summary.profileId, 'unit');
  assert.equal(summary.tickCount, 10);
  assert.equal(summary.durationSeconds, 20);
  assert.equal(ticks.length, 10);
  assert.deepEqual(ticks[0], [0, 1]);
  assert.deepEqual(ticks[9], [18, 10]);
  assert.deepEqual(summary.sensorStats.a, { min: 1, max: 1, mean: 1 });
  assert.equal(summary.sensorStats.junk, undefined); // non-finite numbers never enter the stats
  assert.equal(summary.truncated, undefined);

  const recorded = await store.readMission('e-run', 'sum-1');
  assert.equal(recorded.length, 10);
  // t is stamped from simulated time so replay reproduces the original cadence
  assert.deepEqual(recorded.map((r, i) => (i ? r.t - recorded[i - 1].t : 2000)), Array(10).fill(2000));
});

test('runMission generates a safe missionId even from a hostile profileId', async () => {
  const summary = await runMission({ ...base, profileId: '../../evil profile/\\x', durationSeconds: 10, dtSeconds: 10 });
  assert.match(summary.missionId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal((await store.readMission('e-run', summary.missionId)).length, 1);
});

test('runMission builds the fault-event log from activeFault transitions', async () => {
  let n = 0;
  const summary = await runMission({
    ...base,
    durationSeconds: 20,
    dtSeconds: 2,
    stepFn: () => {
      n += 1;
      return { v: 1, activeFault: n >= 3 && n <= 5 ? { type: 'overheat' } : null };
    },
  });
  assert.equal(summary.faultEvents.length, 1);
  assert.equal(summary.faultEvents[0].type, 'overheat');
  assert.equal(summary.faultEvents[0].startedAtSeconds, 4);
  assert.equal(summary.faultEvents[0].endedAtSeconds, 10);
});

test('runMission yields to the event loop during a long run', async () => {
  let timerFiredAtTick = -1;
  let ticks = 0;
  setTimeout(() => { timerFiredAtTick = ticks; }, 0);
  const summary = await runMission({
    ...base,
    durationSeconds: 4000,
    dtSeconds: 0.5, // 8000 ticks
    stepFn: () => { ticks += 1; return { v: ticks, pad: 'x'.repeat(200) }; },
  });
  assert.equal(summary.tickCount, 8000);
  // a 0ms timer must run long before the 8000-tick run completes (i.e. the loop was not blocked)
  assert.ok(timerFiredAtTick >= 0 && timerFiredAtTick < 8000, `timer fired at tick ${timerFiredAtTick}`);
});

test('runMission surfaces stepFn errors, stops ticking and keeps partial data', async () => {
  let calls = 0;
  await assert.rejects(
    runMission({
      ...base,
      missionId: 'boom',
      durationSeconds: 100,
      stepFn: () => { calls += 1; if (calls === 4) throw new Error('sensor bus down'); return { v: calls }; },
    }),
    /sensor bus down/,
  );
  await sleep(30);
  assert.equal(calls, 4, 'no ticks after the failure');
  assert.equal((await store.readMission('e-run', 'boom')).length, 3);
});

test('runMission rejects a non-object reading', async () => {
  await assert.rejects(runMission({ ...base, stepFn: () => 42 }), TypeError);
  await assert.rejects(runMission({ ...base, stepFn: () => null }), TypeError);
});

test('runMission can be aborted (fast mode) and stops immediately', async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = runMission({
    ...base,
    missionId: 'abort-fast',
    durationSeconds: 14400,
    dtSeconds: 0.5,
    signal: ac.signal,
    stepFn: () => { calls += 1; return { v: calls }; },
  });
  await sleep(15);
  ac.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError');
  const seen = calls;
  await sleep(40);
  assert.equal(calls, seen, 'no ticks after abort');
  assert.ok(seen > 0 && seen < 28800);
  assert.equal((await store.readMission('e-run', 'abort-fast')).length, seen);
});

test('runMission with an already-aborted signal never starts', async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(runMission({ ...base, signal: ac.signal, stepFn: () => { calls += 1; return {}; } }), (e) => e.name === 'AbortError');
  assert.equal(calls, 0);
});

test('runMission realtime mode paces ticks by timers and abort clears the pending timer', async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = runMission({
    ...base,
    missionId: 'abort-rt',
    durationSeconds: 3600,
    dtSeconds: 30, // next tick would be 30s away: a leaked timer would keep the test process alive
    realtime: true,
    signal: ac.signal,
    stepFn: () => { calls += 1; return { v: 1 }; },
  });
  await sleep(20);
  assert.equal(calls, 1);
  ac.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError');
  assert.equal(calls, 1);
});

// -------------------------------------------------------------- replayEngine

// Writes a synthetic recording with `n` frames spaced `gapMs` apart.
function recordFrames(engineId, missionId, n, gapMs) {
  for (let i = 0; i < n; i++) store.appendReading(engineId, missionId, { t: 1_000_000 + i * gapMs, i });
  store.flushMission(engineId, missionId);
}

test('player emits every frame in order then reports the end', async () => {
  recordFrames('e-pl', 'm-all', 12, 100);
  const frames = [];
  let ended = null;
  const player = createPlayer('e-pl', 'm-all', { speed: 100, onEnd: (reason) => { ended = reason; } });
  await player.start((reading, index, total) => frames.push([reading.i, index, total]));
  assert.equal(player.length, 12);
  await waitFor(() => ended !== null);
  assert.deepEqual(frames.map((f) => f[0]), [...Array(12).keys()]);
  assert.ok(frames.every((f, i) => f[1] === i && f[2] === 12));
  assert.equal(ended, 'finished');
  assert.equal(player.isPlaying, false);
  assert.equal(player.position, 12);
});

test('start emits the first frame synchronously once loaded', async () => {
  recordFrames('e-pl', 'm-first', 5, 1000);
  const frames = [];
  const player = createPlayer('e-pl', 'm-first');
  await player.start((r) => frames.push(r.i));
  assert.deepEqual(frames, [0]);
  assert.equal(player.isPlaying, true);
  player.stop();
});

test('pause halts emission and resume continues from the next frame', async () => {
  recordFrames('e-pl', 'm-pause', 30, 100);
  const frames = [];
  const player = createPlayer('e-pl', 'm-pause', { speed: 5 }); // 20ms per frame
  await player.start((r) => frames.push(r.i));
  await sleep(70);
  player.pause();
  assert.equal(player.isPlaying, false);
  const atPause = frames.length;
  assert.ok(atPause >= 1 && atPause < 30);
  await sleep(120);
  assert.equal(frames.length, atPause, 'nothing emitted while paused');
  player.resume();
  assert.equal(player.isPlaying, true);
  assert.equal(frames[atPause], atPause, 'resume emits the very next frame');
  player.stop();
});

test('pause/resume when not applicable are harmless', async () => {
  const player = createPlayer('e-pl', 'm-all');
  player.pause();
  player.resume();
  player.stop();
  assert.equal(player.isPlaying, false);
  assert.equal(player.position, 0);
  assert.equal(player.length, 0);
});

test('stop clears the timer: no frame is ever emitted afterwards', async () => {
  recordFrames('e-pl', 'm-stop', 30, 100);
  const frames = [];
  const player = createPlayer('e-pl', 'm-stop', { speed: 5 });
  await player.start((r) => frames.push(r.i));
  await sleep(50);
  player.stop();
  const atStop = frames.length;
  assert.equal(player.isPlaying, false);
  assert.equal(player.position, 0);
  await sleep(120);
  assert.equal(frames.length, atStop);
});

test('stop() during the initial load cancels the start (no emit after stop)', async () => {
  recordFrames('e-pl', 'm-loadstop', 10, 10);
  const frames = [];
  const player = createPlayer('e-pl', 'm-loadstop', { speed: 100 });
  const started = player.start((r) => frames.push(r.i));
  player.stop(); // before the recording finished loading
  await started;
  await sleep(60);
  assert.deepEqual(frames, []);
  assert.equal(player.isPlaying, false);
});

test('a stop() from inside onFrame ends playback cleanly', async () => {
  recordFrames('e-pl', 'm-selfstop', 10, 10);
  const frames = [];
  const player = createPlayer('e-pl', 'm-selfstop', { speed: 100 });
  await player.start((r) => { frames.push(r.i); if (r.i === 2) player.stop(); });
  await sleep(80);
  assert.deepEqual(frames, [0, 1, 2]);
});

test('a throwing onFrame stops playback and is reported via onError', async () => {
  recordFrames('e-pl', 'm-throw', 10, 10);
  const errors = [];
  const frames = [];
  const player = createPlayer('e-pl', 'm-throw', { speed: 100, onError: (e) => errors.push(e.message) });
  await player.start((r) => { frames.push(r.i); if (r.i === 1) throw new Error('consumer bug'); });
  await sleep(80);
  assert.deepEqual(frames, [0, 1]);
  assert.deepEqual(errors, ['consumer bug']);
  assert.equal(player.isPlaying, false);
});

test('seek by fraction and by timestamp, honoured on resume', async () => {
  recordFrames('e-pl', 'm-seek', 20, 1000);
  const frames = [];
  const player = createPlayer('e-pl', 'm-seek', { speed: 1 });
  await player.start((r) => frames.push(r.i)); // frame 0 now, next in 1s
  player.pause();

  player.seek(0.5);
  assert.equal(player.position, 10);
  player.seek(1); // upper edge clamps to the last frame
  assert.equal(player.position, 19);
  player.seek(0);
  assert.equal(player.position, 0);
  player.seek(1_000_000 + 7 * 1000 + 300); // nearest recorded frame is #7
  assert.equal(player.position, 7);
  player.seek(9_999_999_999); // far beyond the end snaps to the last frame
  assert.equal(player.position, 19);

  // invalid seeks are ignored
  player.seek(NaN);
  player.seek('0.5');
  player.seek(undefined);
  player.seek(Infinity);
  assert.equal(player.position, 19);

  player.seek(0.25);
  player.resume();
  assert.equal(frames[frames.length - 1], 5);
  player.stop();
});

test('seek while playing jumps immediately', async () => {
  recordFrames('e-pl', 'm-seekplay', 20, 1000);
  const frames = [];
  const player = createPlayer('e-pl', 'm-seekplay');
  await player.start((r) => frames.push(r.i));
  player.seek(0.5);
  assert.equal(frames[frames.length - 1], 10);
  player.stop();
});

test('speed is clamped, ignores garbage, and re-times a pending frame', async () => {
  recordFrames('e-pl', 'm-speed', 6, 2000);
  const frames = [];
  const player = createPlayer('e-pl', 'm-speed', { speed: 1e9 });
  assert.equal(player.speed, 100);
  player.setSpeed(-5);
  assert.equal(player.speed, 0.1);
  player.setSpeed(0);
  assert.equal(player.speed, 0.1);
  player.setSpeed(NaN);
  player.setSpeed('fast');
  player.setSpeed(undefined);
  assert.equal(player.speed, 0.1);
  player.setSpeed(1);
  await player.start((r) => frames.push(r.i));
  assert.deepEqual(frames, [0]); // next frame is 2s away at speed 1
  player.setSpeed(100); // pending timer must be re-scheduled, not wait the original 2s
  await waitFor(() => frames.length >= 2, 1000); // far sooner than the original 2s gap
  assert.ok(frames.length >= 2);
  player.stop();
  assert.equal(createPlayer('e-pl', 'x', { speed: NaN }).speed, 1);
});

test('missing recording plays as an empty, immediately-finished mission', async () => {
  let ended = false;
  const frames = [];
  const player = createPlayer('e-pl', 'does-not-exist', { onEnd: () => { ended = true; } });
  await player.start((r) => frames.push(r));
  assert.equal(player.length, 0);
  assert.equal(player.isPlaying, false);
  assert.equal(ended, true);
  assert.deepEqual(frames, []);
  player.seek(0.5); // no-op on an empty recording
  assert.equal(player.position, 0);
});

test('load errors reject start(), or go to onError when provided', async () => {
  await assert.rejects(createPlayer('..', 'm').start(() => {}), RangeError);
  await assert.rejects(createPlayer('e-pl', 'a/b').start(() => {}), RangeError);
  await assert.rejects(createPlayer('e-pl', 'm-all').start('not a function'), TypeError);

  const errors = [];
  const player = createPlayer('..', 'm', { onError: (e) => errors.push(e) });
  await player.start(() => {}); // resolves: no unhandled rejection for fire-and-forget callers
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof RangeError);
});

test('a finished player can be restarted and replays from the beginning', async () => {
  recordFrames('e-pl', 'm-again', 4, 10);
  const frames = [];
  const player = createPlayer('e-pl', 'm-again', { speed: 100 });
  await player.start((r) => frames.push(r.i));
  await waitFor(() => frames.length === 4);
  await player.start((r) => frames.push(r.i));
  await waitFor(() => frames.length === 8);
  assert.deepEqual(frames, [0, 1, 2, 3, 0, 1, 2, 3]);
});

test('starting again while playing supersedes the previous run (no double emission)', async () => {
  recordFrames('e-pl', 'm-restart', 6, 1000);
  const a = [];
  const b = [];
  const player = createPlayer('e-pl', 'm-restart', { speed: 100 });
  await player.start((r) => a.push(r.i));
  await player.start((r) => b.push(r.i));
  await waitFor(() => b.length === 6);
  await sleep(50);
  assert.deepEqual(a, [0]);
  assert.deepEqual(b, [0, 1, 2, 3, 4, 5]);
});
