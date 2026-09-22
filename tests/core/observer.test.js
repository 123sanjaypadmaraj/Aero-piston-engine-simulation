'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KalmanObserver, steadyStateGain, DEFAULT_CHANNELS, MIN_TRACKING_SAMPLES } = require('../../engine_sim/observer');
const { PhysicsEngine } = require('../../engine_sim');

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

test('DEFAULT_CHANNELS covers the 13 emitted sensors', () => {
  assert.equal(DEFAULT_CHANNELS.length, 13);
  assert.ok(DEFAULT_CHANNELS.includes('rpm') && DEFAULT_CHANNELS.includes('alternatorCurrent'));
});

test('steady-state gain lives in (0,1) and steepens with noise-model changes', () => {
  const g = steadyStateGain(0.3, 1);
  assert.ok(g > 0 && g < 1);
  assert.ok(steadyStateGain(10, 1) > g, 'more process noise -> higher gain');
  assert.ok(steadyStateGain(0.3, 0.01) > g, 'less measurement noise -> higher gain');
  assert.ok(steadyStateGain(0.3, 100) < g, 'more measurement noise -> lower gain');
});

test('initializes on the first sample and becomes ready after warmup', () => {
  const obs = new KalmanObserver();
  const first = obs.update({ rpm: 5000 });
  assert.equal(first.ready, false);
  assert.equal(first.channels.rpm.est, 5000);
  assert.equal(first.channels.rpm.innov, 0);
  let last;
  for (let i = 0; i < MIN_TRACKING_SAMPLES + 1; i++) last = obs.update({ rpm: 5000 });
  assert.equal(last.ready, true);
  assert.equal(obs.samples, MIN_TRACKING_SAMPLES + 2);
});

test('smooths a noisy constant signal (estimate variance below raw variance)', () => {
  const obs = new KalmanObserver({ q: 0.3, r: 1 });
  const raw = [];
  const smoothed = [];
  for (let i = 0; i < 80; i++) {
    const z = 100 + (Math.random() - 0.5) * 20;
    raw.push(z);
    smoothed.push(obs.update({ cht: z }).channels.cht.est);
  }
  const rawVar = mean(raw.map((z) => (z - mean(raw)) ** 2));
  const smoothVar = mean(smoothed.map((e) => (e - mean(smoothed)) ** 2));
  assert.ok(smoothVar < rawVar * 0.5, `smooth variance ${smoothVar} should be well below raw ${rawVar}`);
  const mse = (xs) => mean(xs.map((x) => (x - 100) ** 2));
  assert.ok(mse(smoothed) < mse(raw), `smoothed MSE (${mse(smoothed).toFixed(2)}) should beat raw MSE (${mse(raw).toFixed(2)})`);
});

test('tracks a step change without instantly following it', () => {
  const obs = new KalmanObserver({ q: 0.3, r: 1 });
  for (let i = 0; i < 20; i++) obs.update({ rpm: 5000 });
  const afterJump1 = obs.update({ rpm: 5200 }).channels.rpm;
  assert.ok(afterJump1.est < 5200, 'first response is smoothed, not equal to the new level');
  assert.ok(afterJump1.innov > 0, 'the jump registers as innovation');
  let est = afterJump1.est;
  for (let i = 0; i < 40; i++) est = obs.update({ rpm: 5200 }).channels.rpm.est;
  assert.ok(est > 5160, `estimate should converge to the new level, got ${est}`);
});

test('skips non-finite / non-numeric and unknown channels', () => {
  const obs = new KalmanObserver({ channels: ['rpm', 'cht'] });
  const r = obs.update({ rpm: NaN, cht: 5, egt: 700, oilPressure: 'x' });
  assert.deepEqual(Object.keys(r.channels).sort(), ['cht']);
});

test('reset clears estimates and warmup', () => {
  const obs = new KalmanObserver();
  for (let i = 0; i < 10; i++) obs.update({ rpm: 5000 });
  obs.reset();
  assert.equal(obs.samples, 0);
  assert.deepEqual(Object.keys(obs.est), []);
  const r = obs.update({ rpm: 4800 });
  assert.equal(r.channels.rpm.est, 4800); // re-initialized on the fresh sample
});

test('observer option on PhysicsEngine keeps / omits the field', () => {
  const withObserver = new PhysicsEngine({ missionName: 'climbCruiseDescent', seed: 1 });
  const reading = withObserver.step(2);
  assert.ok(reading.observer, 'observer attached by default');
  assert.ok(Number.isFinite(reading.observer.channels.rpm.est));
  assert.ok(Number.isFinite(reading.observer.channels.egt.est));
  assert.equal(Object.keys(reading.observer.channels).length, 13);

  const without = new PhysicsEngine({ missionName: 'climbCruiseDescent', seed: 1, faultTypes: [], observer: false });
  assert.equal(without.step(2).observer, undefined);
});