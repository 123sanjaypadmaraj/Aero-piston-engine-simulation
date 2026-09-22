/**
 * fatigueRul.js
 * -----------------------------------------------------------------------
 * Fatigue-based Remaining Useful Life ("Damage accumulation -> Miner's rule
 * -> hours to D=1, validated against TBO"). Sits on top of the part &
 * material DB (materialDB.js) and the rainflow counter (rainflow.js).
 *
 * Two consumption modes:
 *  - Duty-cycle (online): each telemetry tick advances `cyclesPerSecond*dt`
 *    reversed cycles at the current alternating amplitude, accumulated per
 *    part. This is deterministic and cheap enough to run on every live tick.
 *  - Mission / rainflow (offline): a recorded stress time series is run
 *    through rainflow counting, then Miner's rule aggregates per-cycle
 *    damage. Used for post-flight part reports.
 *
 * Determinism: every nominal path below is free of randomness. The only
 * stochastic step is the optional Monte Carlo uncertainty band, which uses a
 * fixed seed (createRng) so the same state + seed always produces the same
 * percentile band — the default "confidence" band is a closed-form
 * log-normal scatter interval, so the live report needs no sampling at all.
 * -----------------------------------------------------------------------
 */

'use strict';

const { createRng } = require('../engine_sim/rng');
const { clamp, mean } = require('./mathUtils');
const { PARTS, kfOf, damagePerCycle, materialFor } = require('./materialDB');
const { rainflowCount } = require('./rainflow');

const MAX_FATIGUE_HOURS = 8000; // reporting cap for remaining fatigue life
const DEFAULT_SCATTER = 0.10; // log-normal scatter of damage per cycle
const MONTE_CARLO_SEED = 'fatigue-monte-carlo';

/** @returns {Object} fresh per-engine fatigue accumulator */
function createFatigueState() {
  const parts = {};
  for (const p of PARTS) {
    // accumHours = flight hours during which damage actually accrued, used to
    // estimate the governing damage RATE (hours-of-cruise with zero damage must
    // not dilute a fault episode into nothing).
    parts[p.id] = { damage: 0, cycles: 0, peakSa: 0, accumHours: 0, governedBy: 'design' };
  }
  return { parts, consumedHours: 0, peakDuty: 0 };
}

// Alternating stress amplitude + mean stress + cycle rate for one part/sample.
function partDutyStress(part, reading, opts = {}) {
  const kf = kfOf(part);
  const raw = Number.isFinite(reading[part.stressKey]) ? reading[part.stressKey] : NaN;
  const sa = Number.isFinite(raw)
    ? kf * part.stressFactor * Math.max(0, raw - part.stressBias)
    : 0;
  let sm = Number.isFinite(part.groundMean) ? part.groundMean : 0;
  if (part.meanKey) {
    const mr = Number.isFinite(reading[part.meanKey]) ? reading[part.meanKey] : NaN;
    if (Number.isFinite(mr)) sm += part.meanFactor * Math.max(0, mr - part.meanBias);
  }
  const dt = Number.isFinite(opts.dtSeconds) && opts.dtSeconds > 0 ? opts.dtSeconds : 2;
  const cycles = part.cyclesPerSecond * dt;
  return { sa, sm, cycles, kf };
}

/**
 * Advance a per-engine fatigue state by one telemetry reading (duty-cycle mode).
 * Mutates `state` (returns it for chaining). Deterministic.
 */
function advanceFatigue(state, readings, opts = {}) {
  if (!state || !state.parts) throw new TypeError('advanceFatigue requires a fatigue state (createFatigueState)');
  const dtSeconds = Number.isFinite(opts.dtSeconds) && opts.dtSeconds > 0 ? opts.dtSeconds : 2;
  const dtHours = dtSeconds / 3600;
  for (const p of PARTS) {
    const st = state.parts[p.id];
    if (!st) continue;
    const { sa, sm, cycles } = partDutyStress(p, readings, { dtSeconds });
    const damage = cycles * damagePerCycle(p, sa, sm, readings);
    st.damage += damage;
    st.cycles += cycles;
    if (damage > 0) st.accumHours += dtHours;
    if (sa > st.peakSa) st.peakSa = sa;
  }
  if (Number.isFinite(opts.hoursFlown)) state.consumedHours = opts.hoursFlown;
  return state;
}

// Effective remaining-life hours for a part: fatigue-governed when damage has
// accrued across any meaningful duty time, otherwise the design/TBO budget.
function partHoursToD1(part, st, consumedHours) {
  const tboHours = part.tboHours;
  const designLeft = Math.max(0, tboHours - consumedHours);
  if (st.damage > 0 && st.accumHours > 0) {
    const rate = st.damage / st.accumHours;
    const fatigueRemaining = Math.max(0, (1 - st.damage) / rate);
    if (fatigueRemaining < designLeft) return { hoursToD1: fatigueRemaining, governedBy: 'fatigue' };
    return { hoursToD1: designLeft, governedBy: 'design' };
  }
  return { hoursToD1: designLeft, governedBy: 'design' };
}

function partStatus(hoursToD1, tboHours, consumedHours, damage) {
  if (damage >= 0.999999) return 'critical-fatigue';
  if (consumedHours >= tboHours) return 'over-tbo';
  if (consumedHours >= tboHours * 0.98) return 'at-tbo';
  if (hoursToD1 <= 0) return 'critical-fatigue';
  if (hoursToD1 <= tboHours * 0.2) return 'watch';
  return 'ok';
}

const STATUS_RANK = { ok: 0, watch: 1, 'at-tbo': 2, 'over-tbo': 3, 'critical-fatigue': 4 };

/**
 * Deterministic fatigue report for one engine.
 * @param {Object} state - result of createFatigueState()/advanceFatigue()
 * @param {Object} [opts] @param {number} [opts.scatter=0.10]
 * @returns {{
 *   parts: Array, consumedHours, rulHours, dominantPart, status,
 *   confidence: { low, high }, scatter, designTbo,
 * }}
 */
function fatigueReport(state, opts = {}) {
  const scatter = Number.isFinite(opts.scatter) ? Math.max(0, opts.scatter) : DEFAULT_SCATTER;
  const consumedHours = Number.isFinite(state.consumedHours) ? state.consumedHours : 0;
  const rows = [];
  let overall = MAX_FATIGUE_HOURS;
  let dominantPart = null;
  let worstRank = 0;

  for (const p of PARTS) {
    const st = state.parts[p.id] || { damage: 0, cycles: 0, peakSa: 0 };
    const mat = materialFor(p);
    const { hoursToD1, governedBy } = partHoursToD1(p, st, consumedHours);
    const h = clamp(hoursToD1, 0, MAX_FATIGUE_HOURS);
    const status = partStatus(h, p.tboHours, consumedHours, st.damage);
    if (h < overall) { overall = h; dominantPart = p.id; }
    const rank = STATUS_RANK[status] || 0;
    if (rank > worstRank) worstRank = rank;
    rows.push({
      id: p.id,
      name: p.name,
      material: mat ? mat.name : p.materialId,
      damage: Number(st.damage.toFixed(6)),
      damagePercent: Number((Math.min(1, st.damage) * 100).toFixed(2)),
      cycles: Math.round(st.cycles),
      peakSa: Number(st.peakSa.toFixed(1)),
      hoursToD1: Math.round(h),
      cyclesToD1: Math.round(h * (st.cycles > 0 && consumedHours > 0 ? st.cycles / consumedHours : 0)),
      tboHours: p.tboHours,
      governedBy,
      status,
    });
  }

  const row = rows.find((x) => STATUS_RANK[x.status] === worstRank) || rows[0];
  const status = row ? row.status : 'ok';

  // Closed-form log-normal band (no sampling): median at nominal, spread by
  // the cycle scatter. Deterministic by construction.
  const kLow = 1 + 2 * scatter;
  const kHigh = Math.max(1e-6, 1 - 2 * scatter);
  const confidence = {
    low: Math.round(clamp(overall / kLow, 0, MAX_FATIGUE_HOURS)),
    high: Math.round(clamp(overall / kHigh, overall, MAX_FATIGUE_HOURS)),
  };

  return {
    parts: rows,
    consumedHours: Number(consumedHours.toFixed(3)),
    rulHours: Math.round(overall),
    confidence,
    scatter: Number(scatter.toFixed(4)),
    dominantPart,
    status,
    statusLabel: statusLabel(status),
    designTbo: Math.max(...PARTS.map((p) => p.tboHours)),
  };
}

const STATUS_LABELS = {
  ok: 'Within design life',
  watch: 'Watch — approaching fatigue limit',
  'at-tbo': 'At scheduled TBO',
  'over-tbo': 'Beyond scheduled TBO',
  'critical-fatigue': 'Critical — fatigue damage consumed',
};

function statusLabel(status) {
  return STATUS_LABELS[status] || 'ok';
}

// ---- Mission / rainflow (offline) -----------------------------------------

/**
 * Rainflow-based damage analysis of ONE recorded part over a stress series.
 * @param {Array<Object>} readings - ordered telemetry snapshots
 * @param {Object} part - part def from materialDB
 * @param {Object} [opts] @param {number} [opts.dtSeconds=60] per-sample cruise time
 * @param {number} [opts.hoursPerSample] per-sample flight hours (default dt/3600)
 * @returns {{
 *   part, cycles, halfCycles, histogram, damage, consumedHours,
 *   damagePerHour, hoursToD1, cyclesToD1, tboHours, status,
 * }} deterministic for equal input + opts
 */
function missionFatigue(readings, part, opts = {}) {
  const dtSeconds = Number.isFinite(opts.dtSeconds) && opts.dtSeconds > 0 ? opts.dtSeconds : 60;
  const hoursPerSample = Number.isFinite(opts.hoursPerSample) ? opts.hoursPerSample : dtSeconds / 3600;
  const kf = kfOf(part);

  const stressSeries = [];
  const meanSeries = [];
  for (const r of readings || []) {
    const raw = r && Number.isFinite(r[part.stressKey]) ? r[part.stressKey] : NaN;
    stressSeries.push(Number.isFinite(raw) ? kf * part.stressFactor * Math.max(0, raw - part.stressBias) : 0);
    let sm = Number.isFinite(part.groundMean) ? part.groundMean : 0;
    if (part.meanKey && r && Number.isFinite(r[part.meanKey])) {
      sm += part.meanFactor * Math.max(0, r[part.meanKey] - part.meanBias);
    }
    meanSeries.push(sm);
  }

  const { cycles, halfCycles, histogram } = rainflowCount(stressSeries);

  let damage = 0;
  for (const c of cycles) {
    const smCycle = opts.ignoreMean ? 0 : mean(meanSeries);
    damage += c.count * damagePerCycle(part, c.amp, smCycle, {});
  }
  for (const c of halfCycles) {
    const smCycle = opts.ignoreMean ? 0 : mean(meanSeries);
    damage += c.count * damagePerCycle(part, c.amp, smCycle, {});
  }

  const consumedHours = (readings || []).length * hoursPerSample;
  const damagePerHour = consumedHours > 0 ? damage / consumedHours : 0;
  const fullCycles = cycles.length + (halfCycles.length ? halfCycles.length * 0.5 : 0);
  const designLeft = Math.max(0, part.tboHours - consumedHours);

  let hoursToD1;
  let cyclesToD1 = 0;
  let governedBy = 'design';
  if (damage >= 1) {
    hoursToD1 = 0;
    governedBy = 'fatigue';
  } else if (damage > 0 && consumedHours > 0) {
    const fatigueHours = (1 - damage) / damagePerHour;
    if (fatigueHours < designLeft) {
      hoursToD1 = fatigueHours;
      cyclesToD1 = designLeft > 0 ? Math.ceil((1 - damage) * fullCycles / damage) : 0;
      governedBy = 'fatigue';
    } else {
      hoursToD1 = designLeft;
    }
  } else {
    hoursToD1 = designLeft;
  }

  const status = damage >= 1 ? 'critical-fatigue'
    : consumedHours >= part.tboHours ? 'over-tbo'
      : hoursToD1 <= part.tboHours * 0.2 ? 'watch'
        : 'ok';

  return {
    part: part.id,
    name: part.name,
    tboHours: part.tboHours,
    stressSeries,
    cycles,
    halfCycles,
    histogram,
    damage, // raw Miner damage (kept full-precision for downstream checks)
    damagePercent: Number((Math.min(1, damage) * 100).toFixed(2)),
    consumedHours: Number(consumedHours.toFixed(3)),
    damagePerHour: Number(damagePerHour.toExponential(3)),
    cyclesCount: Math.round(fullCycles),
    cyclesToD1: Math.round(cyclesToD1),
    governedBy,
    hoursToD1: Math.round(clamp(hoursToD1, 0, MAX_FATIGUE_HOURS)),
    status,
    statusLabel: statusLabel(status),
  };
}

/**
 * Multi-part mission report: rainflow + Miner per part, plus the aggregate.
 */
function missionReport(readings, parts = PARTS, opts = {}) {
  const perPart = parts.map((p) => missionFatigue(readings, p, opts));
  let overall = MAX_FATIGUE_HOURS;
  let dominantPart = null;
  for (const r of perPart) {
    if (r.hoursToD1 < overall) { overall = r.hoursToD1; dominantPart = r.part; }
  }
  const overallStatus = perPart.reduce(
    (worst, r) => (STATUS_RANK[r.status] > STATUS_RANK[worst] ? r.status : worst),
    'ok',
  );
  return { parts: perPart, rulHours: overall, dominantPart, status: overallStatus, statusLabel: statusLabel(overallStatus) };
}

// ---- Monte Carlo uncertainty (seeded, deterministic) ----------------------

/**
 * Percentiles of hours-to-D=1 under log-normal damage scatter, sampled with a
 * fixed seed so identical (state, seed, draws) always reproduces the same band.
 * @param {Object} state - fatigue state (createFatigueState result)
 * @param {Object} [opts]
 * @param {number} [opts.draws=4000] @param {number|string} [opts.seed]
 * @param {number} [opts.scatter=0.10]
 * @param {Array<number>} [opts.quantiles=[0.05,0.5,0.95]]
 * @returns {{ p05,p50,p95, mean, scatter, draws, quantiles }}
 */
function monteCarloFatigue(state, opts = {}) {
  const draws = Math.max(100, Math.min(100000, Math.floor(opts.draws || 4000)));
  const scatter = Number.isFinite(opts.scatter) ? Math.max(0, opts.scatter) : DEFAULT_SCATTER;
  const seed = opts.seed === undefined ? MONTE_CARLO_SEED : opts.seed;
  const quantiles = Array.isArray(opts.quantiles) ? opts.quantiles : [0.05, 0.5, 0.95];

  const report = fatigueReport(state, { scatter });
  const medianHours = report.rulHours >= MAX_FATIGUE_HOURS ? MAX_FATIGUE_HOURS : report.rulHours;

  const rng = createRng(seed);
  const samples = [];
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  for (let i = 0; i < draws; i++) {
    const factor = Math.exp(scatter * gauss());
    if (factor <= 1e-9) continue;
    samples.push(clamp(medianHours / factor, 0, Number.MAX_SAFE_INTEGER));
  }
  samples.sort((a, b) => a - b);
  const atQ = (q) => {
    if (!samples.length) return 0;
    const idx = clamp(Math.floor(q * (samples.length - 1)), 0, samples.length - 1);
    return samples[idx];
  };
  const summary = {};
  const qLabels = { 0.05: 'p05', 0.5: 'p50', 0.95: 'p95' };
  for (const q of quantiles) {
    const key = qLabels[q];
    if (key) summary[key] = Math.round(atQ(q));
  }
  summary.mean = Math.round(mean(samples));
  return {
    ...summary,
    quantiles,
    scatter: Number(scatter.toFixed(4)),
    draws: samples.length,
  };
}

module.exports = {
  createFatigueState,
  partDutyStress,
  advanceFatigue,
  fatigueReport,
  missionFatigue,
  missionReport,
  monteCarloFatigue,
  partHoursToD1,
  partStatus,
  statusLabel,
  MAX_FATIGUE_HOURS,
  DEFAULT_SCATTER,
  PARTS,
};