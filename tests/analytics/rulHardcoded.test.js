'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  HARDCODED_MODEL, loadRulModel, trainRulModel, predictRul,
  emitRulModelModule, buildFeatureVector,
} = require('../../analytics/rulRegressor');

const numerics = (m) => ({
  means: m.means, stds: m.stds, weights: m.weights,
  intercept: m.intercept, residualStd: m.residualStd, n: m.n,
});

const SAMPLE_FEATURES = [
  { currentHealth: 95, healthSlope: -0.001, healthStd: 1, healthMean: 90, anomalyMean: 0.1, anomalySlope: 0 },
  { currentHealth: 30, healthSlope: -0.4, healthStd: 8, healthMean: 40, anomalyMean: 3.8, anomalySlope: 0.12 },
  { currentHealth: 100, healthSlope: 0, healthStd: 0.5, healthMean: 99, anomalyMean: 0.05, anomalySlope: -0.01 },
];

test('HARDCODED_MODEL is a frozen, valid ridge-rul-regressor', () => {
  assert.ok(HARDCODED_MODEL && HARDCODED_MODEL.type === 'ridge-rul-regressor');
  assert.equal(HARDCODED_MODEL.source, 'hardcoded-mission-loop');
  assert.throws(() => { HARDCODED_MODEL.weights[0] = 999; }, TypeError, 'weights must be frozen');
  assert.equal(HARDCODED_MODEL.featureOrder.length, HARDCODED_MODEL.weights.length);
  assert.ok(HARDCODED_MODEL.featureOrder.every((f) => typeof f === 'string'));
  assert.ok(HARDCODED_MODEL.generatedBy === 'scripts/train-rul.js');
});

test('predictions are finite and inside [0, MAX_RUL_HOURS]', () => {
  for (const features of SAMPLE_FEATURES) {
    const p = predictRul(HARDCODED_MODEL, features);
    assert.ok(Number.isFinite(p.rul) && p.rul >= 0 && p.rul <= 900, `rul out of range: ${p.rul}`);
    assert.ok(p.confidenceLow <= p.rul && p.rul <= p.confidenceHigh);
    assert.deepEqual(Object.keys(p.contribs).sort(), [...HARDCODED_MODEL.featureOrder].sort());
  }
});

test('embedded model matches the committed mission-loop artifact exactly', () => {
  const fileModel = loadRulModel(); // default path -> analytics/models/rul-regressor.json
  assert.ok(fileModel, 'committed JSON model must load');
  assert.deepEqual(numerics(fileModel), numerics(HARDCODED_MODEL), 'numeric fields must be identical');
  for (const features of SAMPLE_FEATURES) {
    const a = predictRul(fileModel, features);
    const b = predictRul(HARDCODED_MODEL, features);
    assert.deepEqual(a, b, 'predictions must be identical');
  }
});

test('an explicitly requested missing model file still resolves to null', () => {
  const missing = path.join(os.tmpdir(), 'no-such-rul-model.json');
  assert.equal(loadRulModel(missing), null);
});

test('emitRulModelModule round-trips a freshly trained model (loop -> literals)', () => {
  const dataset = [];
  const rnd = mulberry(42);
  for (let i = 0; i < 40; i++) {
    dataset.push({
      features: {
        currentHealth: 30 + rnd() * 60,
        healthSlope: -rnd() * 0.5,
        healthStd: rnd() * 8,
        healthMean: 30 + rnd() * 60,
        anomalyMean: rnd() * 4,
        anomalySlope: rnd() * 0.2 - 0.05,
      },
      hours: 100 + rnd() * 600,
    });
  }
  const model = trainRulModel(dataset, { ridge: 1.0 });
  const file = path.join(os.tmpdir(), `rul-hardcoded-${process.pid}.js`);
  emitRulModelModule({ ...model, generatedBy: 'test' }, file);
  try {
    const { HARDCODED_MODEL: roundTripped } = require(file);
    assert.equal(roundTripped.type, 'ridge-rul-regressor');
    assert.deepEqual(numerics(roundTripped), numerics(model));
    for (const features of SAMPLE_FEATURES) {
      assert.deepEqual(predictRul(roundTripped, features), predictRul(model, features));
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('buildFeatureVector preserves the hardcoded feature order', () => {
  const v = buildFeatureVector(SAMPLE_FEATURES[0], HARDCODED_MODEL.featureOrder);
  assert.deepEqual(v, [95, -0.001, 1, 90, 0.1, 0]);
});

function mulberry(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}