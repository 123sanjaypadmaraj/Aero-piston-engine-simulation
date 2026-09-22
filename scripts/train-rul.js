/**
 * scripts/train-rul.js
 * -----------------------------------------------------------------------
 * Offline trainer for the fitted RUL regressor (analytics/rulRegressor.js).
 *
 * It runs deterministic PhysicsEngine missions across every fault profile,
 * samples the health-index + anomaly telemetry trajectories, and labels each
 * checkpoint with the hours-to-threshold projection the engine's own trend
 * implies (time until health crosses a hard floor). The labelled dataset then
 * trains a ridge-linear regressor that maps derivative-style features
 * (current health, worsening slope, anomaly level, ...) to remaining life —
 * the "fitted RUL model + label generator" the master plan asks for, derived
 * from the same physics twin that powers the rest of the pipeline.
 *
 * Usage:
 *   node scripts/train-rul.js [--out <path>] [--seed <n>] [--runs <n>]
 *
 * Writes analytics/models/rul-regressor.json (committed with the repo).
 * Deterministic: same seed → same model.
 * -----------------------------------------------------------------------
 */

'use strict';

const path = require('path');
const { PhysicsEngine } = require('../engine_sim');
const { computeHealthIndex } = require('../analytics/healthIndex');
const { deriveRulFeatures, MAX_RUL_HOURS } = require('../analytics/rulModel');
const { hoursToHealthFloor } = require('../analytics/trendForecast');
const { trainRulModel, saveRulModel, emitRulModelModule, RUL_MODEL_PATH, RUL_HARDCODED_PATH } = require('../analytics/rulRegressor');

const FLIGHT_SECONDS_PER_TICK = 2; // physics default dt
const SAMPLES_PER_HOUR = 3600 / FLIGHT_SECONDS_PER_TICK;
const HEALTH_FLOOR = 25; // hard "needs inspection" health level
const TICKS_PER_RUN = 900; // 30 sim-minutes; long enough for most fault ramps to peak
const WARMUP_TICKS = 90;
const CHECKPOINT_FRACTIONS = [0.5, 0.7, 0.9];
const RUN_KEYS = ['rpm', 'cht', 'egt', 'oilPressure', 'oilTemp', 'fuelFlow', 'vibration', 'manifoldPressure', 'batteryVoltage', 'lambda', 'injectorPulseWidth', 'injectionTiming', 'alternatorCurrent'];

const PROFILES = ['climbCruiseDescent', 'hotWeather', 'rapidThrottleTransients', 'highAltitudeLongEndurance'];
const FAULT_POOL = ['overheat', 'oilLoss', 'vibration', 'fuelStarvation', 'sensorDrift', 'coking', 'injectorAbnormality', 'misfire', 'combustionInstability'];

function parseArg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

function maxAbsZ(historyBySensor) {
  let z = 0;
  for (const key of RUN_KEYS) {
    const h = historyBySensor[key];
    if (!h || h.length < 10) continue;
    const tail = h.slice(-30);
    const mu = tail.reduce((a, v) => a + v, 0) / tail.length;
    const sd = Math.sqrt(tail.reduce((a, v) => a + (v - mu) ** 2, 0) / tail.length) || 1;
    const last = h[h.length - 1];
    const thisZ = Math.abs((last - mu) / sd);
    if (thisZ > z) z = thisZ;
  }
  return z;
}

function runMission(seed, profileId, faultTypes, ticks) {
  const engine = new PhysicsEngine({ missionName: profileId, faultTypes, seed, seedAltitude: 150 + (seed % 5) * 200 });
  const historyBySensor = {};
  for (const k of RUN_KEYS) historyBySensor[k] = [];
  const healthHist = [];
  const zHist = [];

  const checkpoints = CHECKPOINT_FRACTIONS.map((f) => Math.floor(ticks * f));
  const samples = [];

  for (let t = 0; t < ticks; t++) {
    const out = engine.step(FLIGHT_SECONDS_PER_TICK);
    for (const k of RUN_KEYS) {
      historyBySensor[k].push(out[k]);
      if (historyBySensor[k].length > 90) historyBySensor[k].shift();
    }
    if (t < WARMUP_TICKS) continue;
    const health = computeHealthIndex(historyBySensor).healthScore;
    healthHist.push(health);
    zHist.push(maxAbsZ(historyBySensor));

    if (checkpoints.includes(t) && healthHist.length >= 30) {
      const features = deriveRulFeatures(healthHist, zHist);
      const hours = hoursToHealthFloor(healthHist, SAMPLES_PER_HOUR, HEALTH_FLOOR);
      if (hours !== null && Number.isFinite(hours)) {
        samples.push({ features, hours });
      }
    }
  }
  return samples;
}

function main() {
  const seedBase = Number.parseInt(parseArg('--seed', '7'), 10);
  const runs = Number.parseInt(parseArg('--runs', '90'), 10);
  const outFile = parseArg('--out', RUL_MODEL_PATH);

  console.log(`[train-rul] generating labeled severity runs (seed ${seedBase}, ${runs} runs)...`);
  const runSamples = [];
  let withFault = 0;
  let runNo = 0;
  for (let i = 0; i < runs; i++) {
    const profileId = PROFILES[i % PROFILES.length];
    // mix of single faults, pairs, empty (baseline) and full-taxonomy runs
    const combo = i % 5 === 0 ? [] : i % 5 === 1 ? [FAULT_POOL[i % FAULT_POOL.length]] : i % 5 === 2
      ? [FAULT_POOL[i % FAULT_POOL.length], FAULT_POOL[(i + 3) % FAULT_POOL.length]]
      : i % 2 ? [FAULT_POOL[(i * 7) % FAULT_POOL.length]] : FAULT_POOL.slice(i % 3, i % 3 + 2);
    const samples = runMission(seedBase * 1000 + i, profileId, combo.length ? combo : null, TICKS_PER_RUN);
    runNo++;
    if (combo.length) withFault++;
    runSamples.push(samples);
  }

  // keep only labelled, finite samples per run
  const cleanRuns = runSamples
    .map((samples) => samples.filter((d) => d && d.features && Number.isFinite(d.hours)))
    .filter((samples) => samples.length >= 1);

  const flattened = cleanRuns.reduce((a, s) => a.concat(s), []);
  if (flattened.length < 20) {
    console.error('[train-rul] not enough labelled samples — tune TICKS_PER_RUN / HEALTH_FLOOR');
    process.exit(1);
  }

  // Split by RUN (not by sample) so checkpoints from the same mission never
  // leak across train/test — the reported error is a genuine hold-out.
  const train = [];
  const test = [];
  cleanRuns.forEach((samples, idx) => {
    const bucket = idx % 2 === 0 ? train : test;
    bucket.push(...samples);
  });
  console.log(`[train-rul] ${flattened.length} labelled samples across ${cleanRuns.length} runs (${train.length} train / ${test.length} test), ${withFault}/${runNo} runs with faults`);

  const model = trainRulModel(train, { ridge: 1.5 });

  // report test-set error + per-feature weight ranking
  const { predictRul } = require('../analytics/rulRegressor');
  let mae = 0;
  for (const s of test) mae += Math.abs(predictRul(model, s.features).rul - s.hours) / test.length;
  console.log(`[train-rul] test MAE = ${mae.toFixed(1)}h (label range up to ${MAX_RUL_HOURS}h)`);
  const ranked = model.featureOrder.map((f, i) => ({ f, w: model.weights[i] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  console.log('[train-rul] feature weights (std-normalized):');
  for (const { f, w } of ranked) console.log(`   ${f.padEnd(16)} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`);

  const saved = saveRulModel({ ...model, generatedBy: 'scripts/train-rul.js', params: { seedBase, runs, healthFloor: HEALTH_FLOOR, ticksPerRun: TICKS_PER_RUN } }, outFile);
  console.log(`[train-rul] wrote ${path.relative(process.cwd(), saved)}`);

  // Bake the same fitted model into the source tree (deterministic literals),
  // so runtime inference never needs the JSON artifact or a retraining pass.
  const embedded = emitRulModelModule({ ...model, generatedBy: 'scripts/train-rul.js', params: { seedBase, runs, healthFloor: HEALTH_FLOOR, ticksPerRun: TICKS_PER_RUN } }, RUL_HARDCODED_PATH);
  console.log(`[train-rul] embedded model literals in ${path.relative(process.cwd(), embedded)}`);
}

main();