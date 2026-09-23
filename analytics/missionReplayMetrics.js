/**
 * analytics/missionReplayMetrics.js
 * -----------------------------------------------------------------------
 * Closes the loop between the two pipelines: run the analytics L3 layer
 * (rate-aware health index from analytics/healthIndex.js) over a generated
 * mission-replay log and score it against the log's ground truth.
 *
 * Ground truth  = the operator-injected fault events (record.faults where
 *                 injected === true), active between onset_s and resolved_s.
 * Detector 1    = mission-replay's own consecutive-sample detection rules
 *                 (the events' detected_s .. resolved_s window).
 * Detector 2    = the analytics health index, SELF-CALIBRATED to the
 *                 mission: analytics/healthIndex's absolute bands are tuned
 *                 to simulator.js's live fleet, so we baseline the health
 *                 score from the mission's own known-good pre-fault segment
 *                 and flag any sample that drops below baseline - margin
 *                 (or reports an invalid reading — the dropout sentinel).
 *
 * The absolute threshold mode (healthThreshold set) is supported as an
 * override but defaults to self-calibration, which is what makes the health
 * knob meaningful on data with a different operating regime.
 *
 * Output is a sample-level precision/recall/F1 report per detector, a
 * per-fault-type breakdown with detection latency (onset -> detected), a
 * margin sweep, and a list of emergent (rule-declared-but-not-injected)
 * events — i.e. false alarms. Deterministic: same record -> same report.
 * -----------------------------------------------------------------------
 */

'use strict';

const { computeHealthIndex } = require('./healthIndex');

const KPA_TO_PSI = 1 / 6.89476;
const DEFAULT_BASELINE_MARGIN = 12;
const DEFAULT_WARMUP_SAMPLES = 30; // let the rate-aware windows fill before scoring
const HISTORY_CAP = 120;

// Transfer the mission-replay grouped sample into analytics/healthIndex's
// per-sensor scheme (converting oil pressure kPa -> psi so the SENSOR_DEFS
// bands apply). Missing sensors are skipped by computeHealthIndex.
function toAnalyticValues(sample) {
  const v = {};
  const m = sample && sample.mechanical;
  const th = sample && sample.thermal;
  const f = sample && sample.fuel;
  const fl = sample && sample.flight;
  if (m) {
    v.rpm = m.rpm;
    v.vibration = m.vibration_mm_s;
    v.oilPressure = (typeof m.oil_pressure_kpa === 'number' && Number.isFinite(m.oil_pressure_kpa))
      ? m.oil_pressure_kpa * KPA_TO_PSI : null;
  }
  if (th) {
    v.cht = th.cht_c;
    v.egt = th.egt_c;
    v.oilTemp = th.oil_temp_c;
  }
  if (f) {
    v.fuelFlow = f.fuel_flow_lph;
    v.lambda = f.mixture_ratio; // AFR, matches the lambda band
  }
  if (fl && fl.manifold_pressure_kpa !== undefined) v.manifoldPressure = fl.manifold_pressure_kpa;
  if (fl && fl.battery_voltage_v !== undefined) v.batteryVoltage = fl.battery_voltage_v;
  return v;
}

// Null-safe precision/recall/F1 (null when the denominator is zero, so the
// caller can distinguish "perfect on nothing" from "not computable").
function prf(tp, fp, fn) {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  let f1 = null;
  if (precision !== null && recall !== null && precision + recall > 0) {
    f1 = (2 * precision * recall) / (precision + recall);
  }
  return { tp, fp, fn, precision: r2(precision), recall: r2(recall), f1: r2(f1) };
}

function r2(x) { return x === null || x === undefined ? null : Math.round(x * 1000) / 1000; }

function medianSorted(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function activeInWindow(t, evt) {
  return t >= evt.onset_s && (evt.resolved_s === null || t < evt.resolved_s);
}
function inDetectedWindow(t, evt) {
  return evt.detected_s !== null && t >= evt.detected_s && (evt.resolved_s === null || t < evt.resolved_s);
}

/**
 * Evaluate one loaded mission record.
 * @param {object} record - a missionreplay/loader.js record (manifest, faults,
 *   readRangeLines, rate, t0, duration, sampleCount).
 * @param {object} [opts]
 * @param {number} [opts.baselineMargin=12] self-calibrated detection: any
 *   sample with health < baselineHealth - margin counts as anomalous. The
 *   baseline is the median health over the known-good pre-fault segment.
 * @param {number} [opts.healthThreshold] absolute-mode override: flag any
 *   sample with health below this value (blunt; bands are fleet-tuned).
 * @param {number} [opts.warmupSamples=30] samples skipped at the mission start.
 * @returns {object} the evaluation report (deterministic).
 */
function evaluateMissionReplay(record, opts = {}) {
  const warmup = Math.max(0, Number(opts.warmupSamples) || DEFAULT_WARMUP_SAMPLES);
  const margin = Math.max(0, Number(opts.baselineMargin) === 0 ? 0 : (Number(opts.baselineMargin) || DEFAULT_BASELINE_MARGIN));
  const absolute = opts.healthThreshold === undefined ? null : Math.min(100, Math.max(0, Number(opts.healthThreshold)));

  const events = Array.isArray(record.faults) ? record.faults : [];
  const injected = events.filter((f) => f.injected === true);
  const emergent = events.filter((f) => f.injected === false);
  const earliestOnset = injected.length ? Math.min(...injected.map((f) => f.onset_s)) : null;

  const history = {};
  const perSample = []; // evaluated samples only: { t, truth, rule, health, invalid }
  let evaluated = 0;

  const count = Number(record.sampleCount) || 0;
  const samples = count ? record.readRangeLines(0, count - 1) : [];

  for (let i = 0; i < count; i += 1) {
    const raw = samples[i];
    if (!raw || typeof raw.t_s !== 'number') continue;
    const t = raw.t_s;
    const values = toAnalyticValues(raw);
    for (const key of Object.keys(values)) {
      if (values[key] === null || values[key] === undefined) continue;
      const h = history[key] || (history[key] = []);
      h.push(values[key]);
      if (h.length > HISTORY_CAP) h.shift();
    }
    if (i < warmup) continue;

    const health = computeHealthIndex(history);
    // Dropout is a distinct, deliberate signal: an invalid reading gets only a
    // small health penalty, so catch it directly (the -32000 sentinel).
    const invalidReading = health.flags.some((f) => /invalid/i.test(f.evidence));
    const rule = events.some((f) => inDetectedWindow(t, f));
    const truth = injected.some((f) => activeInWindow(t, f));
    perSample.push({ t, truth, rule, health: health.healthScore, invalidReading });
    evaluated += 1;
  }

  // Self-calibrated baseline: median health over the known-good segment,
  // i.e. everything before the earliest injected onset (or the whole mission
  // when the log is clean). Needs a decent sample count to be stable.
  const preOnset = earliestOnset === null
    ? perSample
    : perSample.filter((s) => s.t < earliestOnset);
  const baselineHealth = preOnset.length >= 12 ? medianSorted(preOnset.map((s) => s.health)) : null;

  const isAnomalous = (s, m) => s.invalidReading
    || (absolute !== null ? s.health < absolute : baselineHealth !== null && s.health < baselineHealth - m);

  const one = (truthArr, ruleArr) => {
    let tp = 0; let fp = 0; let fn = 0;
    for (let i = 0; i < truthArr.length; i += 1) {
      if (truthArr[i]) { if (ruleArr[i]) tp += 1; else fn += 1; }
      else if (ruleArr[i]) fp += 1;
    }
    return prf(tp, fp, fn);
  };

  const truthArr = perSample.map((s) => s.truth);
  const ruleArr = perSample.map((s) => s.rule);
  const analyticArr = perSample.map((s) => isAnomalous(s, margin));
  const combinedArr = perSample.map((s, i) => ruleArr[i] || analyticArr[i]);

  // fault-level: does each injected event get seen by each detector, and after
  // how much latency from onset_s?
  const faultLevel = injected.map((evt) => {
    const evtSamples = perSample.filter((s) => activeInWindow(s.t, evt));
    const firstAn = evtSamples.find((s) => isAnomalous(s, margin));
    return {
      fault_id: evt.fault_id,
      type: evt.type,
      label: evt.label,
      severity: evt.severity,
      onset_s: evt.onset_s,
      resolved_s: evt.resolved_s,
      detectedByRule: evt.detected_s !== null,
      ruleLagS: evt.detected_s !== null ? r2(evt.detected_s - evt.onset_s) : null,
      detectedByAnalytics: Boolean(firstAn),
      analyticLagS: firstAn ? r2(firstAn.t - evt.onset_s) : null,
    };
  });

  const byFaultType = {};
  for (const fl of faultLevel) {
    const b = byFaultType[fl.type] || (byFaultType[fl.type] = { events: 0, detectedByRule: 0, detectedByAnalytics: 0, severities: {} });
    b.events += 1;
    if (fl.detectedByRule) b.detectedByRule += 1;
    if (fl.detectedByAnalytics) b.detectedByAnalytics += 1;
    b.severities[fl.severity] = (b.severities[fl.severity] || 0) + 1;
  }

  // margin sweep over the self-calibrated detector
  const sweep = [];
  for (const m of [6, 8, 10, 12, 14, 16, 20]) {
    const scored = one(truthArr, perSample.map((s) => isAnomalous(s, m)));
    sweep.push({ margin: m, precision: scored.precision, recall: scored.recall, f1: scored.f1, fp: scored.fp, fn: scored.fn });
  }

  return {
    missionId: record.missionId,
    generator: record.manifest && record.manifest.generator,
    rate: record.rate,
    durationS: record.duration,
    sampleCount: count,
    evaluatedSamples: evaluated,
    warmupSamples: warmup,
    calibration: {
      mode: absolute !== null ? 'absolute' : 'self-calibrated',
      baselineHealth: baselineHealth === null ? null : r2(baselineHealth),
      baselineMargin: margin,
      healthThreshold: absolute,
      knownGoodSamples: preOnset.length,
    },
    groundTruth: {
      injectedEvents: injected.length,
      emergentEvents: emergent.length,
      emergent: emergent.map((e) => ({ fault_id: e.fault_id, type: e.type, onset_s: e.onset_s })),
    },
    detectors: {
      rule: one(truthArr, ruleArr),
      analytics: one(truthArr, analyticArr),
      combined: one(truthArr, combinedArr),
      truthPositive: truthArr.filter(Boolean).length,
    },
    faultLevel,
    byFaultType,
    marginSweep: sweep,
  };
}

module.exports = {
  evaluateMissionReplay, toAnalyticValues,
  DEFAULT_BASELINE_MARGIN, DEFAULT_WARMUP_SAMPLES,
};