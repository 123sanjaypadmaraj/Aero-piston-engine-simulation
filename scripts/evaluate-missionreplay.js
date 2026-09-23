/**
 * scripts/evaluate-missionreplay.js
 * -----------------------------------------------------------------------
 * End-to-end check that the labeled mission-replay logs actually feed the
 * analytics L3 layer: generate a small deterministic mission library (a few
 * seeded missions with spread-out injected faults, plus one clean baseline),
 * then score the two detectors — mission-replay's own consecutive-sample
 * rules and the self-calibrated analytics health index — against the
 * injected ground truth (precision / recall / F1, per-fault detection
 * latency, margin sweep).
 *
 * Usage:
 *   node scripts/evaluate-missionreplay.js [--out <dir>] [--margin <n>]
 *     [--regenerate]           regenerate the mission library instead of reusing disk
 *     [--seed <n>]             base seed (default 11)
 *     [--duration <s>]         per-mission duration (default 6000, 1 Hz)
 *
 * Outputs a per-mission table to stdout; exits non-zero if any injected
 * event is missed by both detectors at the default margin.
 * -----------------------------------------------------------------------
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { generator, loader } = require('../missionreplay');
const { evaluateMissionReplay } = require('../analytics');

const TWIN_DATA_DIR = process.env.TWIN_DATA_DIR || path.join(__dirname, '..', 'twin_core', 'data');
const DEFAULT_OUT = path.join(TWIN_DATA_DIR, 'missionreplay');

function parseArg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const outDir = path.resolve(parseArg('--out', DEFAULT_OUT));
const margin = Number.parseFloat(parseArg('--margin', '12'));
const seedBase = Number.parseInt(parseArg('--seed', '11'), 10);
const duration = Number.parseInt(parseArg('--duration', '6000'), 10);
const regenerate = process.argv.includes('--regenerate');

const LIBRARY = [
  { missionId: 'EVAL-OIL', faults: [{ type: 'oil_pressure_degradation', onset_s: Math.floor(duration * 0.3), severity: 'moderate' }] },
  { missionId: 'EVAL-THERMAL', faults: [{ type: 'overheating', onset_s: Math.floor(duration * 0.45), severity: 'severe' }, { type: 'vibration_anomaly', onset_s: Math.floor(duration * 0.7), severity: 'moderate' }] },
  { missionId: 'EVAL-MIXED', faults: [{ type: 'sensor_dropout', onset_s: Math.floor(duration * 0.5), severity: 'moderate' }, { type: 'fuel_starvation', onset_s: Math.floor(duration * 0.65), severity: 'low' }] },
  { missionId: 'EVAL-CLEAN', faults: [] },
];

function ensure(missionId, idx) {
  const dir = path.join(outDir, missionId);
  if (!regenerate && fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  console.log(`[eval] generating ${missionId} (seed ${seedBase + idx})...`);
  generator.generateMission({
    missionId,
    outDir,
    duration,
    sampleRateHz: 1,
    seed: seedBase + idx,
    faults: LIBRARY[idx].faults,
    recordCan: true,
  });
  return dir;
}

const table = [`\nMission            injected  detected(rule)  detected(an)   rule P/R/F1          an P/R/F1`, `---                --------  ------------    ------------    ------------------  --------`];
let phantom = 0; // missed by both detectors

function pad(s, n) { return String(s).padEnd(n); }

for (let i = 0; i < LIBRARY.length; i += 1) {
  const { missionId } = LIBRARY[i];
  const record = loader.loadMission(ensure(missionId, i));
  const rep = evaluateMissionReplay(record, { baselineMargin: margin });
  const rule = rep.detectors.rule;
  const an = rep.detectors.analytics;
  const missed = rep.faultLevel.filter((f) => !f.detectedByRule && !f.detectedByAnalytics);
  phantom += missed.length;
  table.push(
    `${pad(missionId, 19)}${pad(rep.groundTruth.injectedEvents, 10)}${pad(rep.faultLevel.filter((f) => f.detectedByRule).length, 15)}`
      + `${pad(rep.faultLevel.filter((f) => f.detectedByAnalytics).length, 16)}`
      + `${pad(`${rule.precision ?? '-'}/${rule.recall ?? '-'}/${rule.f1 ?? '-'}`, 22)}`
      + `${an.precision ?? '-'}/${an.recall ?? '-'}/${an.f1 ?? '-'}`,
  );
  console.log(`[eval] ${missionId}: ${rep.evaluatedSamples} samples, ${rep.groundTruth.injectedEvents} injected / ${rep.groundTruth.emergentEvents} emergent (margin ${margin}, baseline ${rep.calibration.baselineHealth})`);
  for (const f of rep.faultLevel) {
    console.log(`  ${f.type.padEnd(24)} ${f.severity.padEnd(9)} rule:${f.detectedByRule ? `+${f.ruleLagS}s` : 'MISSED'}  an:${f.detectedByAnalytics ? `+${f.analyticLagS}s` : 'MISSED'}`);
  }
  record.close();
}
console.log(table.join('\n'));

const issue = phantom > 0 ? ` => ${phantom} event(s) missed by both detectors!` : ' => all injected events detected by at least one detector.';
console.log(`\nRESULT:${issue}`);
process.exit(phantom > 0 ? 1 : 0);