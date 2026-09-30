/**
 * Calibrate the MISSION LAB replay bands against the real generator.
 * Run: node scripts/calibrate-missionlab-bands.js
 * Prints the deviation table so the constants baked into
 * public/js/missionlab.js can be justified rather than guessed.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mr = require('../missionreplay');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcal-'));
const SCH = [
  { phase: 'taxi', start_s: 0, end_s: 60 },
  { phase: 'takeoff', start_s: 60, end_s: 100 },
  { phase: 'climb', start_s: 100, end_s: 400 },
  { phase: 'cruise', start_s: 400, end_s: 1200 },
  { phase: 'loiter', start_s: 1200, end_s: 1500 },
  { phase: 'descent', start_s: 1500, end_s: 1600 },
  { phase: 'landing', start_s: 1600, end_s: 1700 },
];

const CHANNELS = [
  { key: 'cht', param: 'cht_c', read: (s) => s.thermal.cht_c, dir: 'high' },
  { key: 'egt', param: 'egt_c', read: (s) => s.thermal.egt_c, dir: 'high' },
  { key: 'oilTemp', param: 'oil_temp_c', read: (s) => s.thermal.oil_temp_c, dir: 'high' },
  { key: 'vibration', param: 'vibration_mm_s', read: (s) => s.mechanical.vibration_mm_s, dir: 'high' },
  { key: 'oilPressure', param: 'oil_pressure_kpa', read: (s) => s.mechanical.oil_pressure_kpa, dir: 'low' },
  { key: 'fuelFlow', param: 'fuel_flow_lph', read: (s) => s.fuel.fuel_flow_lph, dir: 'low' },
  { key: 'rpm', param: 'rpm', read: (s) => s.mechanical.rpm, dir: 'two' },
];

function mission(name, faults) {
  mr.generator.generateMission({ missionId: name, outDir: T, duration: 1700, sampleRateHz: 1, seed: 11, phases: SCH, faults });
  const rec = mr.loader.loadMission(path.join(T, name));
  return new mr.replay.MissionReplay(rec);
}

const PROFILES = require('../missionreplay/profiles.js');
const ORDER = PROFILES.PROFILE_PHASES;

function envelope(param, phase) {
  const i = ORDER.indexOf(phase);
  const near = [ORDER[i - 1], phase, ORDER[i + 1]].filter(Boolean).map((p) => PROFILES.PHASE_PROFILES[p][param]);
  return { lo: Math.min(...near), hi: Math.max(...near) };
}

for (const c of CHANNELS) {
  c.sigma = PROFILES.PARAM_DEFS[c.param].sigma;
}

// tol multiplier applied to sigma, plus an absolute floor per channel.
const TOL = { cht: 6, egt: 6, oilTemp: 16, vibration: 10, oilPressure: 6, fuelFlow: 6, rpm: 20 };

function statusOf(ch, phase, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const { lo, hi } = envelope(ch.param, phase);
  const tol = Math.max(ch.sigma * TOL[ch.key], hi - lo, 1) * 0.5;
  if (ch.dir === 'high') {
    if (value > hi + 2 * tol) return 'critical';
    if (value > hi + tol) return 'warning';
    return 'nominal';
  }
  if (ch.dir === 'low') {
    if (value < lo - 2 * tol) return 'critical';
    if (value < lo - tol) return 'warning';
    return 'nominal';
  }
  if (value < lo - 2 * tol || value > hi + 2 * tol) return 'critical';
  if (value < lo - tol || value > hi + tol) return 'warning';
  return 'nominal';
}

function report(label, faults) {
  const pl = mission(label.replace(/\W+/g, '_'), faults);
  const counts = { nominal: 0, degradation: 0, accident: 0 };
  const byChannel = {};
  const worst = {};
  for (let t = 0; t <= 1700; t += 1) {
    const s = pl.stateAt(t);
    const off = [];
    for (const c of CHANNELS) {
      const st = statusOf(c, s.phase, c.read(s));
      if (st === 'warning' || st === 'critical') {
        off.push(c.key);
        byChannel[c.key] = byChannel[c.key] || { warn: 0, crit: 0 };
        byChannel[c.key][st === 'critical' ? 'crit' : 'warn'] += 1;
        const key = `${s.phase}.${c.key}`;
        worst[key] = Math.max(worst[key] || 0, st === 'critical' ? 2 : 1);
      }
    }
    // same two-leg logic as ai/retriever.js
    const has = (k) => off.includes(k);
    const all = (...k) => k.every(has);
    const any = (...k) => k.some(has);
    let cls = 'nominal';
    if ((all('rpm', 'fuelFlow') || all('rpm', 'fuelFlow', 'vibration')) && (has('cht') || has('egt'))) cls = 'accident';
    else if (all('cht', 'egt') || any('cht', 'egt', 'vibration', 'rpm', 'fuelFlow', 'oilPressure', 'oilTemp')) cls = 'degradation';
    counts[cls] += 1;
  }
  console.log(`\n=== ${label}`);
  console.log('  ', JSON.stringify(counts));
  console.log('   off-nominal by channel:', JSON.stringify(byChannel));
}

report('clean', []);
report('lookalike', [
  { type: 'overheating', onset_s: 420, duration_s: 300, severity: 'moderate' },
  { type: 'vibration_anomaly', onset_s: 480, duration_s: 260, severity: 'moderate' },
]);
report('cascade', [
  { type: 'overheating', onset_s: 420, duration_s: 240, severity: 'critical' },
  { type: 'vibration_anomaly', onset_s: 620, duration_s: 200, severity: 'severe' },
  { type: 'fuel_starvation', onset_s: 700, duration_s: 200, severity: 'critical' },
]);
