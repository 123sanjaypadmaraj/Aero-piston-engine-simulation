/**
 * tests/analytics/missionReplayMetrics.test.js
 * ---------------------------------------------------------------------------
 * Cross-pipeline evaluation tests: run analytics/healthIndex over generated
 * mission-replay logs and score detectors against injected ground truth.
 * Deterministic end-to-end (seeded generator -> verify report reproducibility).
 * ---------------------------------------------------------------------------
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { generator, loader } = require('../../missionreplay');
const { evaluateMissionReplay } = require('../../analytics');

const DURATION = 1200; // condensed schedule stays cheap; 1 Hz
const OUT = path.join(os.tmpdir(), `mr-metrics-${process.pid}`);
const FAULTY = 'METRICS-FAULTY';
const DROPOUT = 'METRICS-DROPOUT';
const CLEAN = 'METRICS-CLEAN';

before(() => {
  generator.generateMission({
    missionId: FAULTY,
    outDir: OUT,
    duration: DURATION,
    seed: 23,
    faults: [
      { type: 'oil_pressure_degradation', onset_s: 300, severity: 'moderate' },
      { type: 'vibration_anomaly', onset_s: 600, severity: 'severe' },
    ],
  });
  generator.generateMission({
    missionId: DROPOUT,
    outDir: OUT,
    duration: DURATION,
    seed: 24,
    faults: [{ type: 'sensor_dropout', onset_s: 400, severity: 'moderate' }],
  });
  generator.generateMission({ missionId: CLEAN, outDir: OUT, duration: DURATION, seed: 25, faults: [] });
});

after(() => {
  for (const id of [FAULTY, DROPOUT, CLEAN]) {
    try { fs.rmSync(path.join(OUT, id), { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const loadAndEval = (id, opts) => {
  const record = loader.loadMission(path.join(OUT, id));
  const report = evaluateMissionReplay(record, opts);
  record.close();
  return report;
};

test('self-calibrated analytics scores a faulted mission with nonzero recall', () => {
  const rep = loadAndEval(FAULTY);
  assert.equal(rep.calibration.mode, 'self-calibrated');
  assert.equal(rep.groundTruth.injectedEvents, 2);
  assert.ok(rep.calibration.baselineHealth !== null, 'baseline should be computed');
  assert.ok(rep.detectors.rule.recall !== null && rep.detectors.rule.recall >= 0);
  assert.ok(rep.detectors.analytics.recall !== null && rep.detectors.analytics.recall >= 0);
  assert.ok(rep.detectors.combined.recall !== null);
  for (const fl of rep.faultLevel) {
    assert.ok(Number.isFinite(fl.onset_s));
    assert.ok('detectedByRule' in fl && 'detectedByAnalytics' in fl);
    assert.ok(fl.detectedByRule || fl.detectedByAnalytics, `${fl.type} must be caught by at least one detector`);
  }
});

test('clean mission has no ground-truth positives and stays quiet', () => {
  const rep = loadAndEval(CLEAN);
  assert.equal(rep.groundTruth.injectedEvents, 0);
  assert.equal(rep.groundTruth.emergentEvents, 0);
  assert.equal(rep.detectors.truthPositive, 0);
  assert.equal(rep.detectors.rule.tp, 0);
  assert.equal(rep.detectors.rule.fp, 0);
  assert.equal(rep.faultLevel.length, 0);
});

test('evaluation is deterministic: two scores of the same log are identical', () => {
  const a = loadAndEval(FAULTY);
  const b = loadAndEval(FAULTY);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.detectors.combined.f1 !== null);
});

test('sensor dropout is caught immediately by the rules', () => {
  const rep = loadAndEval(DROPOUT);
  assert.equal(rep.groundTruth.injectedEvents, 1);
  const evt = rep.faultLevel[0];
  assert.equal(evt.type, 'sensor_dropout');
  assert.equal(evt.detectedByRule, true);
  assert.equal(evt.ruleLagS, 0);
});

test('tighter baseline margin is at least as sensitive as a looser one', () => {
  const tight = loadAndEval(FAULTY, { baselineMargin: 6 }).detectors.analytics;
  const loose = loadAndEval(FAULTY, { baselineMargin: 30 }).detectors.analytics;
  assert.ok((tight.recall ?? 0) >= (loose.recall ?? 0), `recall@6 (${tight.recall}) should be >= recall@30 (${loose.recall})`);
  assert.ok((loose.fp ?? 0) <= (tight.fp ?? 0), 'looser margin should flag fewer non-fault samples');
});

test('absolute threshold mode is reported and respected', () => {
  const rep = loadAndEval(FAULTY, { healthThreshold: 0 });
  assert.equal(rep.calibration.mode, 'absolute');
  assert.equal(rep.calibration.healthThreshold, 0);
  assert.ok(Array.isArray(rep.marginSweep) && rep.marginSweep.length === 7);
});

test('fault-level report carries per-fault latency for whichever detector fired', () => {
  const rep = loadAndEval(FAULTY);
  for (const fl of rep.faultLevel) {
    if (fl.detectedByRule) assert.ok(Number.isFinite(fl.ruleLagS) && fl.ruleLagS >= 0);
    if (fl.detectedByAnalytics) assert.ok(Number.isFinite(fl.analyticLagS) && fl.analyticLagS >= 0);
  }
  // every event appears under byFaultType with detector counts
  for (const type of Object.keys(rep.byFaultType)) {
    const b = rep.byFaultType[type];
    assert.ok(b.events >= 1);
    assert.ok(b.detectedByRule <= b.events && b.detectedByAnalytics <= b.events);
  }
});