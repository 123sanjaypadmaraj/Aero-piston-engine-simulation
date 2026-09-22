'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DigitalTwinFleet, SENSORS, FAULT_TYPES, FLEET, PHYSICAL_RANGE } = require('../../simulator');

const SENSOR_KEYS = Object.keys(SENSORS);
const STATUSES = new Set(['nominal', 'warning', 'critical']);

// Clock advancing one minute per call so alert cooldowns (15s) never suppress a repeat.
function steppingClock(startMs = 1_700_000_000_000, stepMs = 60_000) {
  let now = startMs;
  return () => (now += stepMs);
}

function assertSnapshotSane(engine) {
  assert.deepEqual(Object.keys(engine.readings).sort(), [...SENSOR_KEYS].sort());
  for (const k of SENSOR_KEYS) {
    assert.ok(Number.isFinite(engine.readings[k]), `${k} reading finite`);
    assert.ok(STATUSES.has(engine.statuses[k]), `${k} status ${engine.statuses[k]}`);
    assert.ok(['ok', 'invalid', 'stale'].includes(engine.validity[k]));
  }
  assert.ok(Number.isInteger(engine.health) && engine.health >= 0 && engine.health <= 100, `health ${engine.health}`);
  assert.ok(Number.isFinite(engine.rul) && engine.rul >= 0 && engine.rul <= 900, `rul ${engine.rul}`);
  assert.ok(Number.isFinite(engine.analytics.healthScore) && engine.analytics.healthScore >= 0 && engine.analytics.healthScore <= 100);
  assert.ok(Number.isFinite(engine.analytics.anomalyScore) && engine.analytics.anomalyScore >= 0);
  const { rul, confidenceLow, confidenceHigh } = engine.analytics.rul;
  assert.ok(rul >= 0 && confidenceLow >= 0 && confidenceLow <= rul && rul <= confidenceHigh && confidenceHigh <= 900);
  assert.ok(Number.isFinite(engine.altitude) && Number.isFinite(engine.airspeed) && Number.isFinite(engine.hoursFlown));
  // must survive JSON (a NaN would silently become null on the wire)
  assert.equal(JSON.stringify(engine).includes('null,') && /"(health|rul|altitude)":null/.test(JSON.stringify(engine)), false);
}

test('exports keep their contract', () => {
  assert.equal(typeof DigitalTwinFleet, 'function');
  assert.equal(SENSOR_KEYS.length, 13); // 9 legacy + lambda, injectorPulseWidth, injectionTiming, alternatorCurrent
  assert.deepEqual(
    Object.keys(FAULT_TYPES).sort(),
    ['fuelStarvation', 'overheat', 'oilLoss', 'vibration', 'sensorDrift', 'coking', 'injectorAbnormality', 'misfire', 'combustionInstability'].sort(),
  );
  assert.ok(Array.isArray(FLEET) && FLEET.length >= 1);
  for (const k of SENSOR_KEYS) assert.ok(PHYSICAL_RANGE[k], `physical range for ${k}`);
});

test('default construction (no options) still works and yields the documented snapshot shape', () => {
  const fleet = new DigitalTwinFleet();
  const snap = fleet.step();
  assert.equal(snap.engines.length, FLEET.length);
  assert.deepEqual(Object.keys(snap.fleet).sort(), ['avgHealth', 'criticalCount', 'engineCount', 'missionReliability']);
  const e = snap.engines[0];
  for (const key of ['id', 'tail', 'engine', 'time', 'readings', 'statuses', 'altitude', 'airspeed', 'hoursFlown', 'health', 'rul', 'activeFault', 'predictedFault', 'alerts', 'analytics']) {
    assert.ok(key in e, `snapshot has ${key}`);
  }
  assert.ok(!Number.isNaN(Date.parse(e.time)));
  snap.engines.forEach(assertSnapshotSane);
});

test('same seed + clock => identical runs; different seed => different run', () => {
  const run = (seed) => {
    const fleet = new DigitalTwinFleet({ seed, clock: steppingClock() });
    const out = [];
    for (let i = 0; i < 120; i++) out.push(fleet.step());
    return out;
  };
  const a = run(42);
  const b = run(42);
  assert.deepEqual(a, b);
  const c = run(43);
  assert.notDeepEqual(a[119].engines[0].readings, c[119].engines[0].readings);
  // engines within one fleet do not share a random stream
  assert.notDeepEqual(a[50].engines[0].readings, a[50].engines[1].readings);
});

test('string and numeric seeds are both accepted', () => {
  const a = new DigitalTwinFleet({ seed: 'alpha', clock: steppingClock() });
  const b = new DigitalTwinFleet({ seed: 'alpha', clock: steppingClock() });
  assert.deepEqual(a.step(), b.step());
  assert.doesNotThrow(() => new DigitalTwinFleet({ seed: 0 }).step());
});

test('an unseeded run is not deterministic (default behaviour preserved)', () => {
  const a = new DigitalTwinFleet();
  const b = new DigitalTwinFleet();
  assert.notDeepEqual(a.step().engines[0].readings, b.step().engines[0].readings);
});

test('every snapshot stays sane over a long run (finite values, health 0..100, RUL >= 0)', () => {
  const fleet = new DigitalTwinFleet({ seed: 7, clock: steppingClock() });
  for (let i = 0; i < 1500; i++) {
    const snap = fleet.step();
    if (i % 50 === 0 || i > 1490) snap.engines.forEach(assertSnapshotSane);
    for (const e of snap.engines) {
      assert.ok(e.health >= 0 && e.health <= 100);
      assert.ok(e.rul >= 0);
    }
    assert.ok(snap.fleet.missionReliability >= 0 && snap.fleet.missionReliability <= 100);
    assert.ok(snap.fleet.avgHealth >= 0 && snap.fleet.avgHealth <= 100);
  }
});

test('all per-engine history structures stay bounded over a long run', () => {
  const fleet = new DigitalTwinFleet({ seed: 99, clock: steppingClock() });
  for (let i = 0; i < 2500; i++) {
    // keep faults + sensor failures firing so alerts and cooldown maps are exercised
    if (i % 60 === 0) {
      for (const [n, e] of fleet.engines.entries()) {
        e.forceFault(Object.keys(FAULT_TYPES)[(i / 60 + n) % 4], 30);
      }
    }
    fleet.step();
  }
  for (const e of fleet.engines) {
    assert.ok(e.alerts.length <= 40, `alerts ${e.alerts.length}`);
    assert.ok(e.healthScoreHistory.length <= 60);
    assert.ok(e.anomalyScoreHistory.length <= 60);
    assert.ok(e.warmupSamples.length <= 40);
    assert.ok(Object.keys(e._alertCooldowns || {}).length <= SENSOR_KEYS.length * 2 + Object.keys(FAULT_TYPES).length);
    for (const k of SENSOR_KEYS) {
      assert.ok(e.history[k].length <= 30);
      assert.ok(e.series[k].length <= 120);
    }
  }
  assert.ok(fleet.allAlerts(9999).length <= fleet.engines.length * 40);
});

test('series() returns a defensive copy and null for unknown engines', () => {
  const fleet = new DigitalTwinFleet({ seed: 5 });
  for (let i = 0; i < 10; i++) fleet.step();
  const s = fleet.series('uav-01');
  assert.deepEqual(Object.keys(s).sort(), [...SENSOR_KEYS].sort());
  assert.equal(s.rpm.length, 10);
  s.rpm.length = 0;
  s.rpm.push(-1);
  assert.equal(fleet.series('uav-01').rpm.length, 10);
  assert.ok(fleet.series('uav-01').rpm.every((v) => v > 0));
  assert.equal(fleet.series('nope'), null);
  assert.equal(fleet.series(undefined), null);
  assert.equal(fleet.series({ toString: () => 'uav-01' }), null);
});

test('each fault type is reported as the active fault and eventually raises alerts', () => {
  for (const type of Object.keys(FAULT_TYPES)) {
    const fleet = new DigitalTwinFleet({ seed: 11, clock: steppingClock() });
    fleet.injectFault('uav-02', type, 45);
    let snap;
    let sawActive = false;
    let sawPredicted = false;
    for (let i = 0; i < 40; i++) {
      snap = fleet.step();
      const e = snap.engines[1];
      if (e.activeFault && e.activeFault.type === type) sawActive = true;
      if (e.predictedFault && e.predictedFault.type === type) sawPredicted = true;
    }
    const alerts = snap.engines[1].alerts;
    assert.ok(sawActive, `${type} shows as activeFault`);
    assert.ok(sawPredicted, `${type} is predicted`);
    assert.ok(alerts.length > 0, `${type} raised alerts`);
    assert.ok(alerts.every((a) => a.engineId === 'uav-02' && ['info', 'warning', 'critical'].includes(a.severity)));
    // the untouched engines stay quiet on the same clock/seed
    assert.ok(snap.engines[0].health >= 50);
  }
});

test('an overheat fault drives cht/egt up and health down; it resolves with an info alert', () => {
  const fleet = new DigitalTwinFleet({ seed: 3, clock: steppingClock() });
  for (let i = 0; i < 25; i++) fleet.step();
  const before = fleet.step().engines[0];
  fleet.engines[0].faultCooldown = 999; // no random faults interfering
  fleet.injectFault('uav-01', 'overheat', 40);
  let peakEgt = 0;
  let minHealth = 100;
  let last;
  const seenAlerts = []; // the snapshot only carries the newest 8 alerts, so collect across ticks
  for (let i = 0; i < 45; i++) {
    last = fleet.step().engines[0];
    seenAlerts.push(...last.alerts);
    peakEgt = Math.max(peakEgt, last.readings.egt);
    minHealth = Math.min(minHealth, last.health);
  }
  assert.ok(peakEgt > before.readings.egt + 40, `egt rose: ${before.readings.egt} -> ${peakEgt}`);
  assert.ok(minHealth < before.health, `health fell: ${before.health} -> ${minHealth}`);
  assert.equal(last.activeFault, null);
  assert.ok(seenAlerts.some((a) => a.severity === 'info' && /resolved/.test(a.message)));
  assert.ok(seenAlerts.some((a) => a.severity === 'critical' || a.severity === 'warning'));
});

test('alert ids are unique even when several fire within the same millisecond', () => {
  const fixed = () => 1_700_000_000_000;
  const fleet = new DigitalTwinFleet({ seed: 8, clock: fixed });
  fleet.injectFault('uav-01', 'oilLoss', 3);
  for (let i = 0; i < 6; i++) fleet.step();
  const ids = fleet.engines[0].alerts.map((a) => a.id);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
});

test('a critical alert is de-duplicated within its cooldown window', () => {
  const fixed = () => 1_700_000_000_000; // frozen clock: cooldown never elapses
  const fleet = new DigitalTwinFleet({ seed: 8, clock: fixed });
  fleet.injectFault('uav-01', 'overheat', 60);
  for (let i = 0; i < 55; i++) fleet.step();
  const crit = fleet.engines[0].alerts.filter((a) => a.severity === 'critical');
  const keys = crit.map((a) => a.message);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate critical message inside cooldown');
});

test('allAlerts is newest-first, honours limit and tolerates bad limits', () => {
  const fleet = new DigitalTwinFleet({ seed: 21, clock: steppingClock() });
  for (const [i, type] of Object.keys(FAULT_TYPES).entries()) fleet.injectFault(FLEET[i % FLEET.length].id, type, 30);
  for (let i = 0; i < 40; i++) fleet.step();
  const all = fleet.allAlerts(500);
  assert.ok(all.length > 5);
  for (let i = 1; i < all.length; i++) assert.ok(Date.parse(all[i - 1].time) >= Date.parse(all[i].time));
  assert.equal(fleet.allAlerts(3).length, 3);
  assert.equal(fleet.allAlerts().length, Math.min(30, all.length));
  assert.equal(fleet.allAlerts(0).length, 0);
  assert.equal(fleet.allAlerts(-5).length, 0);
  assert.equal(fleet.allAlerts(NaN).length, Math.min(30, all.length));
  assert.equal(fleet.allAlerts('7').length, Math.min(30, all.length));
  assert.ok(fleet.allAlerts(1e12).length <= 500);
});

test('injection hooks validate their arguments', () => {
  const fleet = new DigitalTwinFleet({ seed: 1 });
  assert.throws(() => fleet.injectFault('uav-01', 'nope', 10), RangeError);
  assert.throws(() => fleet.injectFault('uav-01', 'constructor', 10), RangeError);
  assert.throws(() => fleet.injectFault('ghost', 'overheat', 10), RangeError);
  assert.throws(() => fleet.injectFault('uav-01', 'overheat', 0), RangeError);
  assert.throws(() => fleet.injectFault('uav-01', 'overheat', 1.5), RangeError);
  assert.throws(() => fleet.injectSensorFault('uav-01', 'nope', 'nan', 5), RangeError);
  assert.throws(() => fleet.injectSensorFault('uav-01', 'cht', 'melt', 5), RangeError);
  assert.throws(() => fleet.injectSensorFault('ghost', 'cht', 'nan', 5), RangeError);
  assert.throws(() => fleet.injectSensorFault('uav-01', 'cht', 'nan', 0), RangeError);
});

test('NaN / out-of-range sensor samples are marked invalid, never silently nominal', () => {
  for (const mode of ['nan', 'outOfRange']) {
    const fleet = new DigitalTwinFleet({ seed: 2, clock: steppingClock() });
    for (let i = 0; i < 40; i++) fleet.step();
    const healthy = fleet.step().engines[0];
    assert.equal(healthy.validity.cht, 'ok');
    fleet.injectSensorFault('uav-01', 'cht', mode, 3);
    for (let i = 0; i < 3; i++) {
      const e = fleet.step().engines[0];
      assert.equal(e.validity.cht, 'invalid', `${mode} tick ${i}`);
      assert.notEqual(e.statuses.cht, 'nominal');
      assert.ok(STATUSES.has(e.statuses.cht), 'statuses only ever holds values existing consumers understand');
      assert.ok(Number.isFinite(e.readings.cht) && e.readings.cht < 300, 'held last valid value, not the garbage');
      assert.equal(e.validity.rpm, 'ok', 'other sensors unaffected');
      assertSnapshotSane(e);
    }
    const recovered = fleet.step().engines[0];
    assert.equal(recovered.validity.cht, 'ok');
    assert.ok(recovered.alerts.some((a) => /Cylinder Head Temp sensor INVALID/.test(a.message)));
  }
});

test('a sensor dropout becomes stale after consecutive missing samples', () => {
  const fleet = new DigitalTwinFleet({ seed: 4, clock: steppingClock() });
  for (let i = 0; i < 30; i++) fleet.step();
  fleet.injectSensorFault('uav-01', 'oilPressure', 'dropout', 4);
  const v = [];
  for (let i = 0; i < 5; i++) v.push(fleet.step().engines[0]);
  assert.deepEqual(v.map((e) => e.validity.oilPressure), ['ok', 'stale', 'stale', 'stale', 'ok']);
  assert.notEqual(v[1].statuses.oilPressure, 'nominal');
  assert.equal(v[1].readings.oilPressure, v[0].readings.oilPressure, 'last value held');
  v.forEach(assertSnapshotSane);
});

test('invalid samples do not corrupt the rolling statistics', () => {
  const fleet = new DigitalTwinFleet({ seed: 6, clock: steppingClock() });
  for (let i = 0; i < 30; i++) fleet.step();
  fleet.injectSensorFault('uav-01', 'egt', 'nan', 5);
  for (let i = 0; i < 10; i++) fleet.step();
  const eng = fleet.engines[0];
  assert.ok(eng.history.egt.every(Number.isFinite));
  assert.ok(eng.series.egt.every(Number.isFinite));
  assert.ok(eng.warmupSamples.every((s) => Object.values(s).every(Number.isFinite)));
});

test('physical state never leaves the clamped envelope', () => {
  const fleet = new DigitalTwinFleet({ seed: 13, clock: steppingClock() });
  for (let i = 0; i < 800; i++) {
    if (i % 40 === 0) fleet.engines.forEach((e, n) => e.forceFault(Object.keys(FAULT_TYPES)[(i / 40 + n) % 4], 35));
    const snap = fleet.step();
    for (const e of snap.engines) {
      for (const k of SENSOR_KEYS) {
        const [lo, hi] = PHYSICAL_RANGE[k];
        assert.ok(e.readings[k] >= lo && e.readings[k] <= hi, `${k}=${e.readings[k]}`);
        assert.equal(e.validity[k], 'ok');
      }
      assert.ok(e.altitude >= 2500 && e.altitude <= 7500);
      assert.ok(e.airspeed >= 90 && e.airspeed <= 200);
    }
  }
});

test('custom fleet metadata and an empty-safe fleet', () => {
  const fleet = new DigitalTwinFleet({ fleet: [{ id: 'x-1', tail: 'T1', engine: 'E' }], seed: 1 });
  const snap = fleet.step();
  assert.equal(snap.engines.length, 1);
  assert.equal(snap.engines[0].id, 'x-1');
  assert.equal(fleet.series('x-1').rpm.length, 1);
  // null / non-object options fall back to defaults instead of throwing
  assert.doesNotThrow(() => new DigitalTwinFleet(null));
});
