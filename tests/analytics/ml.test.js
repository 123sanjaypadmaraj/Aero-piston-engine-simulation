'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IsolationForest, avgPathLength } = require('../../analytics/isolationForest');
const { forecastSensor, forecastEngine, hoursToHealthFloor } = require('../../analytics/trendForecast');
const { trainRulModel, predictRul, saveRulModel, loadRulModel } = require('../../analytics/rulRegressor');
const { shapAttribution } = require('../../analytics/shap');
const { estimateRUL, deriveRulFeatures } = require('../../analytics/rulModel');

test('avgPathLength normalization constant grows logarithmically', () => {
  assert.equal(avgPathLength(0), 0);
  assert.equal(avgPathLength(1), 0);
  assert.ok(avgPathLength(8) < avgPathLength(64));
  assert.ok(avgPathLength(64) < avgPathLength(256));
  assert.ok(avgPathLength(64) > 0);
});

test('IsolationForest ranks displaced points above cluster members', () => {
  const rnd = mulberry(123);
  const normal = [];
  for (let i = 0; i < 600; i++) {
    const side = i % 2;
    normal.push({ a: 5 + side * 90 + rnd() * 10, b: 5 + side * 90 + rnd() * 10 }); // two tight clusters
  }
  const forest = new IsolationForest({ nTrees: 128, subsample: 128, seed: 42 }).fit(normal);
  assert.ok(forest.fitted);

  const meanScore = (pts) => pts.reduce((a, p) => a + forest.score(p), 0) / pts.length;
  const clusterPts = [];
  const gapPts = [];
  const farPts = [];
  for (let i = 0; i < 120; i++) {
    clusterPts.push({ a: 5 + rnd() * 10, b: 5 + rnd() * 10 });
    gapPts.push({ a: 48 + rnd() * 4, b: 48 + rnd() * 4 }); // between the clusters, in-range
    farPts.push({ a: 500, b: 500 }); // far outside every branch
  }
  const cluster = meanScore(clusterPts);
  const gap = meanScore(gapPts);
  const far = meanScore(farPts);
  assert.ok(gap > cluster + 0.05, `gap ${gap.toFixed(3)} vs cluster ${cluster.toFixed(3)}`);
  assert.ok(far > cluster + 0.05, `far ${far.toFixed(3)} vs cluster ${cluster.toFixed(3)}`);
  assert.ok(gap <= 1 && far <= 1);
});

test('missing/non-finite features fall back to 0 without throwing', () => {
  const forest = new IsolationForest({ seed: 1 }).fit([{ a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 4 }]);
  const s = forest.score({ a: null }); // b missing + a null => both 0
  assert.ok(Number.isFinite(s) && s >= 0 && s <= 1);
});

test('forecastSensor extrapolates a linear ramp to warn/crit hours', () => {
  // rpm rising 20 per sample from 5000..5800, 1800 samples/hour, warn at 5800
  const history = [];
  for (let i = 0; i < 30; i++) history.push(5000 + 20 * i); // last = 5580, slope 20
  const f = forecastSensor('rpm', history, { samplesPerHour: 1800 });
  assert.ok(f.projectable, 'projectable');
  // (warn 5800 - last 5580) / (slope 20 * 1800/hr) = 220/36000 h
  assert.ok(Math.abs(f.hoursToWarn - 220 / 36000) < 1e-6, `hoursToWarn ${f.hoursToWarn}`);
  assert.ok(Math.abs(f.hoursToCrit - (6100 - 5580) / 36000) < 1e-6, `hoursToCrit ${f.hoursToCrit}`);
  assert.equal(f.direction, 'rising');
});

test('forecastSensor is not projectable on flat or improving history', () => {
  const flat = new Array(30).fill(5100);
  const improving = [];
  for (let i = 0; i < 30; i++) improving.push(5600 - i * 5); // falling toward nominal
  assert.equal(forecastSensor('cht', flat, { samplesPerHour: 1800 }).projectable, false);
  assert.equal(forecastSensor('cht', improving, { samplesPerHour: 1800 }).projectable, false);
});

test('hoursToHealthFloor projects a declining health index to a floor', () => {
  const h = [];
  for (let i = 0; i < 40; i++) h.push(100 - i); // last 60, slope -1 /sample
  const hours = hoursToHealthFloor(h, 1800, 25);
  // last value = 100 - 39 = 61 -> (61 - 25) / 1 / 1800 hr
  assert.ok(Math.abs(hours - 36 / 1800) < 1e-6, `hours ${hours}`);
  assert.ok(hoursToHealthFloor(new Array(30).fill(92), 1800, 25) === null); // flat: no EOL
});

test('forecastEngine aggregates the earliest EOL across sensors', () => {
  const histories = {
    cht: [],
    egt: [],
  };
  for (let i = 0; i < 30; i++) {
    histories.cht.push(100 + i); // creeping up slowly
    histories.egt.push(660 + 4 * i); // reaching EGT crit faster
  }
  const eng = forecastEngine(histories, { samplesPerHour: 1800, healthHistory: new Array(30).fill(90) });
  assert.ok(eng.sensors.length >= 1);
  assert.ok(eng.eolHours !== null);
  const egt = eng.sensors.find((s) => s.sensor === 'egt');
  assert.ok(egt && egt.hoursToCrit !== null);
  assert.ok(Math.abs(egt.hoursToCrit - (800 - 776) / (4 * 1800)) < 1e-6, `egt crit ${egt.hoursToCrit}`);
});

test('ridge RUL regressor learns a monotone health->RUL mapping', () => {
  const dataset = [];
  for (let h = 0; h <= 100; h += 5) {
    for (const slope of [-8, -2, 0]) {
      dataset.push({
        features: { currentHealth: h, healthSlope: slope / 1800, healthStd: 2, healthMean: h + 4, anomalyMean: 0.2, anomalySlope: 0.001 },
        hours: 40 + h * 4,
      });
    }
  }
  const model = trainRulModel(dataset, { ridge: 0.1 });
  assert.ok(model.n === dataset.length);
  const healthy = predictRul(model, { currentHealth: 95, healthSlope: -0.001, healthStd: 1, healthMean: 90, anomalyMean: 0.1, anomalySlope: 0 });
  const sick = predictRul(model, { currentHealth: 30, healthSlope: -0.01, healthStd: 5, healthMean: 40, anomalyMean: 1.5, anomalySlope: 0.01 });
  assert.ok(sick.rul < healthy.rul, `sick ${sick.rul}h < healthy ${healthy.rul}h`);
  assert.ok(sick.rul >= 0 && sick.rul <= 900);
  assert.ok(sick.confidenceLow <= sick.rul && sick.rul <= sick.confidenceHigh);
});

test('RUL regressor save/load round-trips through a temp file', () => {
  const model = trainRulModel([
    { features: { currentHealth: 90, healthSlope: 0, healthStd: 1, healthMean: 88, anomalyMean: 0, anomalySlope: 0 }, hours: 460 },
    { features: { currentHealth: 70, healthSlope: -0.01, healthStd: 4, healthMean: 75, anomalyMean: 1, anomalySlope: 0.01 }, hours: 280 },
    { features: { currentHealth: 50, healthSlope: -0.02, healthStd: 6, healthMean: 58, anomalyMean: 2, anomalySlope: 0.02 }, hours: 180 },
    { features: { currentHealth: 40, healthSlope: -0.03, healthStd: 7, healthMean: 46, anomalyMean: 3, anomalySlope: 0.03 }, hours: 120 },
    { features: { currentHealth: 20, healthSlope: -0.05, healthStd: 8, healthMean: 30, anomalyMean: 4, anomalySlope: 0.04 }, hours: 60 },
  ]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rul-model-')), 'model.json');
  saveRulModel(model, file);
  const loaded = loadRulModel(file);
  assert.ok(loaded && loaded.type === 'ridge-rul-regressor');
  assert.deepEqual(loaded.featureOrder, model.featureOrder);
  const p1 = predictRul(model, { currentHealth: 66, healthSlope: -0.015, healthStd: 3, healthMean: 72, anomalyMean: 1.8, anomalySlope: 0.02 });
  const p2 = predictRul(loaded, { currentHealth: 66, healthSlope: -0.015, healthStd: 3, healthMean: 72, anomalyMean: 1.8, anomalySlope: 0.02 });
  assert.equal(p1.rul, p2.rul);
  assert.equal(loadRulModel(path.join(file, '..', 'missing.json')), null);
});

test('SHAP attributes an additive linear model approximately by its weights', () => {
  const weights = [2, 3, -1];
  const predict = (vec) => 10 + weights[0] * vec[0] + weights[1] * vec[1] + weights[2] * vec[2];
  const out = shapAttribution({
    predict,
    sample: { x: 6, y: 4, z: 2 },
    background: { x: 1, y: 1, z: 1 },
    featureOrder: ['x', 'y', 'z'],
    nCoalitions: 48,
    seed: 5,
  });
  // sum of attributions ≈ prediction - base
  const sum = out.attributions.reduce((a, c) => a + c.shap, 0);
  assert.ok(Math.abs(sum - (out.prediction - out.expected)) < 1e-4, `additive check ${sum} vs ${out.prediction - out.expected}`);
  const byFeature = Object.fromEntries(out.attributions.map((a) => [a.feature, a.shap]));
  // true contribution of each feature: weight_i * (sample_i - bg_i)
  assert.ok(Math.abs(byFeature.x - 2 * 5) < 0.5, `x ${byFeature.x}`);
  assert.ok(Math.abs(byFeature.y - 3 * 3) < 0.5, `y ${byFeature.y}`);
  assert.ok(Math.abs(byFeature.z - -1 * 1) < 0.5, `z ${byFeature.z}`);
});

test('estimateRUL stays the non-regressed fallback (backwards-compatible)', () => {
  const f = deriveRulFeatures([100, 99, 98, 97, 96], [0, 0.1, 0.2, 0.3, 0.4]);
  const r = estimateRUL(f);
  assert.ok(r.rul >= 0 && r.rul <= 900);
  assert.ok(r.confidenceLow <= r.rul && r.rul <= r.confidenceHigh);
});

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}