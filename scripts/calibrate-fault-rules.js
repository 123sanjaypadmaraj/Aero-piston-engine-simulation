/**
 * scripts/calibrate-fault-rules.js
 * ---------------------------------------------------------------------------
 * Measures, for every fault class, the real per-phase telemetry envelope the
 * generator produces, and reports the guard values that separate a faulted
 * flight from a clean one.
 *
 * Hand-picked thresholds do not survive contact with a 7-phase profile: rpm
 * alone spans 1100 (taxi) to 2780 (takeoff), so any fixed rpm floor fires on
 * taxi and never on climb. This script prints the observed per-phase extremes so
 * DETECT_RULES can be set from evidence, and it FAILS if a clean mission raises
 * any event at all — the one property that must hold.
 *
 * Run: node scripts/calibrate-fault-rules.js
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mr = require('../missionreplay');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'faultcal-'));
const DURATION = 1700;
const SCHEDULE = [
  { phase: 'taxi', start_s: 0, end_s: 60 },
  { phase: 'takeoff', start_s: 60, end_s: 100 },
  { phase: 'climb', start_s: 100, end_s: 400 },
  { phase: 'cruise', start_s: 400, end_s: 1200 },
  { phase: 'loiter', start_s: 1200, end_s: 1500 },
  { phase: 'descent', start_s: 1500, end_s: 1600 },
  { phase: 'landing', start_s: 1600, end_s: 1700 },
];
const PHASES = SCHEDULE.map((p) => p.phase);

const CHANNELS = [
  'rpm', 'egt_c', 'cht_c', 'oil_temp_c', 'oil_pressure_kpa',
  'fuel_flow_lph', 'vibration_mm_s', 'mixture_ratio',
];

function generate(id, faults) {
  mr.generator.generateMission({
    missionId: id, outDir: T, duration: DURATION, sampleRateHz: 1, seed: 11,
    phases: SCHEDULE, faults,
  });
  const rec = mr.loader.loadMission(path.join(T, id));
  const pl = new mr.replay.MissionReplay(rec);
  const rows = [];
  for (let t = 0; t <= DURATION; t += 1) {
    const s = pl.stateAt(t);
    const flat = { ...s.mechanical, ...s.thermal, ...s.fuel, ...s.flight };
    rows.push({ t, phase: s.phase, flat });
  }
  return { rows, events: rec.faults || [] };
}

/** min / max per channel, grouped by phase. */
function envelope(rows) {
  const out = {};
  for (const phase of PHASES) {
    const sub = rows.filter((r) => r.phase === phase);
    const e = {};
    for (const c of CHANNELS) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of sub) {
        const v = r.flat[c];
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      e[c] = { lo, hi };
    }
    out[phase] = e;
  }
  return out;
}

function fmt(n) { return (Math.round(n * 100) / 100).toFixed(2).padStart(8); }

const clean = generate('clean', []);

// --- gate 1: a clean mission must be completely silent ---------------------
if (clean.events.length !== 0) {
  console.error('FAIL: a clean mission raised emergent events:');
  for (const e of clean.events) console.error(`  ${e.type} @${e.onset_s}s (${e.severity})`);
  process.exitCode = 1;
} else {
  console.log('PASS  a clean mission raises no events at all');
}

console.log('\n--- clean per-phase envelope (the bounds a guard must not cross) ---\n');
const cleanEnv = envelope(clean.rows);
console.log('phase     ' + CHANNELS.map((c) => c.slice(0, 8).padStart(8)).join(' '));
for (const phase of PHASES) {
  console.log(phase.padEnd(10)
    + CHANNELS.map((c) => `${fmt(cleanEnv[phase][c].lo)}/${fmt(cleanEnv[phase][c].hi)}`).join(' '));
}
console.log('\n(min/max per phase)\n');

// --- per-fault behaviour ---------------------------------------------------
const TYPES = Object.keys(mr.faultLib.FAULT_TYPES);
const ONSET = 600;
const DURATION_S = 400;

console.log('--- per-fault excursion during its window, vs the clean envelope ---\n');
let undetected = [];
for (const type of TYPES) {
  const { rows, events } = generate(`f-${type}`, [
    { type, onset_s: ONSET, duration_s: DURATION_S, severity: 'critical' },
  ]);
  const injected = events.filter((e) => e.injected);
  const inWindow = rows.filter((r) => r.t >= ONSET && r.t < ONSET + DURATION_S);
  const env = envelope(inWindow);

  // widest breach of the clean band, per channel
  const breaches = [];
  for (const c of CHANNELS) {
    let worst = 0;
    for (const phase of PHASES) {
      const cell = env[phase][c];
      const cc = cleanEnv[phase][c];
      if (!Number.isFinite(cell.lo) || !Number.isFinite(cc.lo)) continue;
      const up = cell.hi - cc.hi;
      const down = cc.lo - cell.lo;
      const mag = Math.max(up, down);
      if (mag > worst) {
        worst = mag;
        breaches.push({ channel: c, phase, dir: up >= down ? 'above' : 'below', mag });
      }
    }
  }
  breaches.sort((a, b) => b.mag - a.mag);
  const top = breaches.slice(0, 3)
    .map((b) => `${b.channel} ${b.dir} ${b.phase} by ${b.mag.toFixed(1)}`).join(' | ');
  const detected = injected.length > 0 && injected[0].detected_s != null;
  if (!detected) undetected.push(type);
  console.log(`${detected ? 'ok  ' : 'MISS'} ${type.padEnd(26)} ${top}`);
}

console.log('');
if (undetected.length) {
  console.log('UNDETECTED: ' + undetected.join(', '));
  console.log('These need a level guard that the clean envelope above permits.');
} else {
  console.log(`All ${TYPES.length} fault classes cross at least one guard.`);
}
if (process.exitCode) console.log('\nGATE FAILED');
