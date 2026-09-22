/**
 * missionreplay/generator.js
 * -----------------------------------------------------------------------
 * Synthetic telemetry generator (spec §5).
 *
 * Produces, per mission:
 *   manifest.json      - mission metadata (§3.1), phases, schema version
 *   telemetry.jsonl    - one §3.2 sample per line (flight/mechanical/thermal/
 *                        fuel + fault_flags)
 *   faults.json        - sparse fault-event table (onset vs detected vs
 *                        resolved + precursor window + injected flag)
 *   telemetry.idx      - byte offset per telemetry line (line i -> byte of
 *                        line i), enables O(1) seek
 *   can.jsonl          - optional artificial-CAN frame captures per sample
 *
 * Determinism: the RNG is seeded from mission_id + configured inputs, so the
 * same inputs regenerate byte-identical logs.
 *
 * Pipeline per tick (spec §5.1):
 *   phase target -> cosine-eased blend across the 15s transition window
 *                -> first-order lag (thermal params slow) -> process noise
 *                -> fault overlay (windowed degradation) -> clamps
 * -----------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createRng } = require('../engine_sim/rng');
const {
  SCHEMA_VERSION, DEFAULT_DURATION_S, DEFAULT_SAMPLE_RATE_HZ,
  TRANSITION_WINDOW_S, PHASE_PROFILES, PARAM_DEFS, LAG_GAIN, FUEL_TANK_L,
  targetAt, phaseAt, phaseProgress, ease, lerp, clamp01, buildPhaseSchedule,
} = require('./profiles');
const {
  FAULT_TYPES, SEVERITY_MULT, applyFaultValue,
  evaluateDetectionRules, OVERRANGE_SENSOR,
} = require('./faultLib');
const { createCanBus, seedFromString } = require('./can');

const ENGINE_MODEL = 'Aeropiston-4C-115hp-Sim';
const UAV_TYPE = 'MALE';

function gauss(rand) {
  let u = 0; let v = 0;
  do { u = rand(); } while (u === 0);
  do { v = rand(); } while (v === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function rnd(x) { return Number(x.toFixed(3)); }

function clamp(v, lo, hi) {
  if (v !== v) return v; // preserve NaN marker
  return Math.max(lo, Math.min(hi, v));
}

/** Validate + normalise a fault injection config. */
function normalizeFault(cfg, durationS, index) {
  const type = cfg.type;
  if (!FAULT_TYPES[type]) throw new Error(`unknown fault type '${type}'`);
  const meta = FAULT_TYPES[type];
  const onset = Number(cfg.onset_s);
  if (!Number.isFinite(onset) || onset < 0 || onset >= durationS) {
    throw new Error(`fault ${index} onset_s must be within [0, ${durationS})`);
  }
  const severity = cfg.severity && SEVERITY_MULT[cfg.severity] ? cfg.severity : 'moderate';
  const duration = Number(cfg.duration_s) || meta.defaultDurationS;
  const precursor = Math.max(0, Number(cfg.params && cfg.params.precursor_s) || meta.defaultPrecursorS);
  return {
    type,
    severity,
    onset_s: onset,
    duration_s: Math.max(1, duration),
    precursor_s: precursor,
    injected: true,
    description: cfg.description || meta.description,
  };
}

/** Group a flat param map into the §3.2 grouped sample shape. */
function groupSample(t, phase, flat, flags) {
  return {
    t_s: rnd(t),
    phase,
    flight: {
      altitude_m: round1(flat.altitude_m),
      airspeed_ms: round1(flat.airspeed_ms),
      throttle_pct: Math.round(flat.throttle_pct),
    },
    mechanical: {
      rpm: Math.round(flat.rpm),
      vibration_mm_s: round2(flat.vibration_mm_s),
      oil_pressure_kpa: round1(flat.oil_pressure_kpa),
    },
    thermal: {
      egt_c: round1(flat.egt_c),
      cht_c: round1(flat.cht_c),
      oil_temp_c: round1(flat.oil_temp_c),
    },
    fuel: {
      fuel_flow_lph: round2(flat.fuel_flow_lph),
      mixture_ratio: round2(flat.mixture_ratio),
      fuel_remaining_l: round2(flat.fuel_remaining_l),
    },
    fault_flags: flags.slice(),
  };
}

function defaultSeed(missionId, opts) {
  const payload = [missionId, opts.duration || DEFAULT_DURATION_S,
    opts.sampleRateHz || DEFAULT_SAMPLE_RATE_HZ,
    JSON.stringify(opts.faults || []), JSON.stringify(opts.phases || [])].join('|');
  return seedFromString(payload);
}

/**
 * Main entry. Writes all mission files into outDir/<missionId>.
 *
 * @returns summary object with missionId, dir, sampleCount, seed, manifest,
 *          faults (events), files
 */
function generateMission(opts) {
  __faultSeq = 0; // mission-local fault numbering keeps logs reproducible
  if (!opts || !opts.missionId) throw new Error('generateMission requires opts.missionId');
  const missionId = String(opts.missionId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(missionId)) {
    throw new Error('missionId must match [A-Za-z0-9_-]{1,64}');
  }
  const duration = Number(opts.duration) || DEFAULT_DURATION_S;
  const sampleRateHz = Number(opts.sampleRateHz) || DEFAULT_SAMPLE_RATE_HZ;
  const phases = buildPhaseSchedule(opts.phases);
  const seed = opts.seed !== undefined ? opts.seed : defaultSeed(missionId, opts);
  const rng = createRng(seed);
  const dir = path.join(opts.outDir || path.join(process.cwd(), 'missionreplay', 'missions'), missionId);
  fs.mkdirSync(dir, { recursive: true });

  const faults = (opts.faults || []).map((f, i) => normalizeFault(f, duration, i));
  const events = []; // output spare events (injected + emergent)
  const byTypeFaultId = {}; // injected: type -> fault_id

  const canBus = opts.canBus || (opts.recordCan ? createCanBus({ seed }) : null);

  const teleFn = path.join(dir, 'telemetry.jsonl');
  const idxFn = path.join(dir, 'telemetry.idx');
  const fauFn = path.join(dir, 'faults.json');
  const manFn = path.join(dir, 'manifest.json');
  const canFn = path.join(dir, 'can.jsonl');
  const teOut = fs.openSync(teleFn, 'w');
  const idxOut = fs.openSync(idxFn, 'w');
  const canOutFd = canBus ? fs.openSync(canFn, 'w') : null;
  let teleBytes = 0;

  const sampleCount = Math.round(duration * sampleRateHz);
  const dt = 1 / sampleRateHz;

  // rolling state
  const flat = {};
  for (const param of Object.keys(PARAM_DEFS)) flat[param] = null;
  flat.fuel_remaining_l = FUEL_TANK_L;

  const history = {};
  const counters = {};
  let prevPhase = null;
  let phaseElapsed = 0;
  let blendFrom = {}; // steady-param target snapshot at phase boundary

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i * dt;
    const phase = phaseAt(phases, t);
    const p = phaseProgress(phases, t);

    if (phase !== prevPhase) {
      prevPhase = phase;
      phaseElapsed = 0;
      if (i === 0) {
        blendFrom = {};
        for (const param of Object.keys(PHASE_PROFILES[phase] || {})) {
          blendFrom[param] = targetAt(phase, param, 0);
        }
      } else {
        blendFrom = {};
        for (const param of Object.keys(PARAM_DEFS)) blendFrom[param] = flat[param];
      }
    }
    phaseElapsed += dt;

    // 1. phase target (blend steady params across the transition window)
    const targets = {};
    for (const param of Object.keys(PARAM_DEFS)) {
      const tgt = targetAt(phase, param, p);
      if ((param === 'altitude_m' || param === 'airspeed_ms')) {
        targets[param] = tgt; // ramped params keep piecewise-linear target
      } else if (phaseElapsed <= TRANSITION_WINDOW_S && blendFrom[param] !== undefined) {
        targets[param] = lerp(blendFrom[param], tgt, ease(phaseElapsed / TRANSITION_WINDOW_S));
      } else {
        targets[param] = tgt;
      }
    }

    // 2. first-order lag toward targets
    for (const param of Object.keys(PARAM_DEFS)) {
      const gain = LAG_GAIN[param] || 0.3;
      if (flat[param] === null) flat[param] = targets[param];
      flat[param] = flat[param] + (targets[param] - flat[param]) * gain;
    }
    // fuel remaining is a pure clock
    flat.fuel_remaining_l = Math.max(0, (flat.fuel_remaining_l || FUEL_TANK_L) - (targets.fuel_flow_lph || 0) * dt / 3600);

    // 3. process noise + clamps (before fault overlay: faults get their own physics)
    const noisy = {};
    for (const param of Object.keys(PARAM_DEFS)) {
      const def = PARAM_DEFS[param];
      const v = flat[param] + gauss(rng) * def.sigma;
      noisy[param] = clamp(v, def.min, def.max);
      flat[param] = noisy[param];
    }
    noisy.fuel_remaining_l = Math.max(0, flat.fuel_remaining_l);

    // 4. fault overlay (windowed degradation over the noisy nominal)
    const activeFaults = faults.filter((f) => t >= f.onset_s && t < f.onset_s + f.duration_s);
    const activeIds = [];
    for (const f of activeFaults) {
      const fid = byTypeFaultId[f.type] || assignFaultId(f, events, byTypeFaultId);
      activeIds.push(fid);
    }
    for (const f of activeFaults) {
      const pFault = (t - f.onset_s) / f.duration_s;
      for (const param of fAffectedParams(f.type)) {
        const cur = noisy[param];
        if (param && cur !== undefined) {
          const applied = applyFaultValue(f.type, param, cur, clamp01(pFault), f.severity, rng);
          noisy[param] = applied === OVERRANGE_SENSOR ? OVERRANGE_SENSOR : clamp(applied, PARAM_DEFS[param] ? PARAM_DEFS[param].min : -32000, PARAM_DEFS[param] ? PARAM_DEFS[param].max : 32000);
        }
      }
    }

    const sample = groupSample(t, phase, noisy, activeIds);

    // rolling history for rule evaluation
    for (const param of Object.keys(PARAM_DEFS)) {
      if (!history[param]) history[param] = [];
      history[param].push(noisy[param]);
      if (history[param].length > 60) history[param].shift();
    }

    // 5. detection rules (targets supplied for relative guards)
    const fired = evaluateDetectionRules(sample, { history, targets }, counters);
    for (const hit of fired) {
      declareDetection(hit, t, events, byTypeFaultId, activeFaults);
    }
    // keep emergent faults active until they recover long enough
    tickEmergent(events, fired, t, noisy);

    if (canBus) {
      canBus.publishSample(sample, Math.round(t * 1000));
      fs.writeSync(canOutFd, Buffer.from(JSON.stringify({ frames: canBus.frames.slice(-20) }) + '\n'));
    }

    // 6. write telemetry + idx (idx stores the byte offset of each line)
    const line = JSON.stringify(sample) + '\n';
    const buf = Buffer.from(line);
    fs.writeSync(teOut, buf, 0, buf.length, teleBytes);
    fs.writeSync(idxOut, `${teleBytes}\n`);
    teleBytes += buf.length;
  }

  fs.closeSync(teOut);
  fs.closeSync(idxOut);
  if (canBus) fs.closeSync(canOutFd);

  // finalise emergent; sort events by onset
  events.sort((a, b) => a.onset_s - b.onset_s);

  const manifest = {
    schema_version: SCHEMA_VERSION,
    mission_id: missionId,
    uav_type: UAV_TYPE,
    engine_model: ENGINE_MODEL,
    generator: 'aeropiston missionreplay/v1',
    start_time_utc: opts.startTimeUtc || '2026-06-01T00:00:00.000Z',
    sample_rate_hz: sampleRateHz,
    duration_s: duration,
    sample_count: sampleCount,
    seed,
    profile_phases: phases,
    transition_window_s: TRANSITION_WINDOW_S,
    files: { telemetry: 'telemetry.jsonl', manifest: 'manifest.json', faults: 'faults.json', idx: 'telemetry.idx', can: canBus ? 'can.jsonl' : null },
  };

  fs.writeFileSync(manFn, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(fauFn, JSON.stringify(events, null, 2) + '\n');

  return {
    missionId, dir, seed, sampleCount, durationS: duration, phases, manifest,
    faults: events, files: { telemetry: teleFn, idx: idxFn, faults: fauFn, manifest: manFn, can: canBus ? canFn : null },
    canBus,
  };
}

function fAffectedParams(type) {
  const meta = FAULT_TYPES[type];
  return meta ? meta.affectedParams : ['egt_c'];
}

let __faultSeq = 0;
function freshFaultId() {
  __faultSeq += 1;
  return `FLT-${String(__faultSeq).padStart(4, '0')}`;
}

function assignFaultId(f, events, byType) {
  const meta = FAULT_TYPES[f.type];
  const evt = {
    fault_id: freshFaultId(),
    type: f.type,
    label: meta.label,
    severity: f.severity,
    onset_s: f.onset_s,
    detected_s: null,
    resolved_s: Math.round((f.onset_s + f.duration_s) * 100) / 100,
    precursor_window_s: [Math.max(0, f.onset_s - f.precursor_s), f.onset_s],
    affected_parameters: meta.affectedParams.slice(),
    description: f.description || meta.description,
    injected: true,
  };
  events.push(evt);
  byType[f.type] = evt.fault_id;
  return evt.fault_id;
}

function declareDetection(hit, t, events, byType, activeFaults) {
  // Injected fault of same type currently active? -> set its detected_s.
  const active = activeFaults.find((f) => f.type === hit.fault);
  if (active) {
    const evt = events.find((e) => e.fault_id === byType[hit.fault]);
    if (evt && evt.detected_s === null) evt.detected_s = t;
    return;
  }
  // Emergent: create one event per type (dedupe while within its window).
  const open = events.find((e) => e.injected === false && e.type === hit.fault && (e.resolved_s === null || t < e.resolved_s));
  if (open) return;
  const meta = FAULT_TYPES[hit.fault];
  const evt = {
    fault_id: freshFaultId(),
    type: hit.fault,
    label: meta.label,
    severity: hit.severity,
    onset_s: t,
    detected_s: t,
    resolved_s: null,
    precursor_window_s: null,
    affected_parameters: meta.affectedParams.slice(),
    description: meta.description,
    injected: false,
  };
  events.push(evt);
  // register under a synthetic key so flags carry it
  byType[hit.fault + ':emergent'] = evt.fault_id;
}

const RECOVERY_WINDOW = 60;
function tickEmergent(events, fired, t, _noisy) {
  for (const evt of events) {
    if (evt.injected || evt.resolved_s !== null) continue;
    const still = fired.some((h) => h.fault === evt.type);
    if (still) { evt.__recover = 0; } else { evt.__recover = (evt.__recover || 0) + 1; if (evt.__recover >= RECOVERY_WINDOW) evt.resolved_s = t; }
  }
  for (const evt of events) delete evt.__recover;
}

module.exports = { generateMission, ENGINE_MODEL, UAV_TYPE, defaultSeed };