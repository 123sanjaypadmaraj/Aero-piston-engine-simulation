/**
 * missionreplay/profiles.js
 * -----------------------------------------------------------------------
 * Mission phase definitions and per-phase parameter models for the synthetic
 * telemetry generator (spec §3.1 / §5.1). Pure data + pure helpers: no
 * randomness, no file I/O.
 *
 * Every telemetry parameter maps to a phase target. Ramped parameters
 * (altitude_m, airspeed_ms) interpolate linearly across the phase; the rest
 * hold a steady target. The generator adds first-order lag (thermal params
 * slow), process noise and fault overlays on top of these targets.
 * -----------------------------------------------------------------------
 */

'use strict';

const SCHEMA_VERSION = '1.0';
const DEFAULT_SAMPLE_RATE_HZ = 1.0;
const DEFAULT_DURATION_S = 21600;
const TRANSITION_WINDOW_S = 15;

const DEFAULT_PHASES = [
  { phase: 'taxi', start_s: 0, end_s: 120 },
  { phase: 'takeoff', start_s: 120, end_s: 180 },
  { phase: 'climb', start_s: 180, end_s: 1200 },
  { phase: 'cruise', start_s: 1200, end_s: 5000 },
  { phase: 'loiter', start_s: 5000, end_s: 19000 },
  { phase: 'descent', start_s: 19000, end_s: 20800 },
  { phase: 'landing', start_s: 20800, end_s: 21600 },
];

// Per-phase steady targets (spec §5.1 table, hit at midfield range values).
// altitude_m / airspeed_ms are [startOfPhase, endOfPhase] ramps.
const PHASE_PROFILES = {
  taxi: {
    rpm: 1100, throttle_pct: 18, egt_c: 575, cht_c: 100, oil_temp_c: 50,
    oil_pressure_kpa: 365, fuel_flow_lph: 6, vibration_mm_s: 1.0,
    mixture_ratio: 14.0, altitude_m: [0, 0], airspeed_ms: [0, 0],
  },
  takeoff: {
    rpm: 2780, throttle_pct: 100, egt_c: 825, cht_c: 230, oil_temp_c: 90,
    oil_pressure_kpa: 435, fuel_flow_lph: 34, vibration_mm_s: 2.8,
    mixture_ratio: 13.8, altitude_m: [0, 200], airspeed_ms: [0, 40],
  },
  climb: {
    rpm: 2500, throttle_pct: 85, egt_c: 780, cht_c: 218, oil_temp_c: 93,
    oil_pressure_kpa: 415, fuel_flow_lph: 26, vibration_mm_s: 2.2,
    mixture_ratio: 14.2, altitude_m: [200, 4800], airspeed_ms: [40, 42],
  },
  cruise: {
    rpm: 2300, throttle_pct: 65, egt_c: 740, cht_c: 198, oil_temp_c: 92,
    oil_pressure_kpa: 405, fuel_flow_lph: 18, vibration_mm_s: 2.0,
    mixture_ratio: 14.4, altitude_m: [4800, 4800], airspeed_ms: [42, 42],
  },
  loiter: {
    rpm: 2000, throttle_pct: 50, egt_c: 700, cht_c: 182, oil_temp_c: 89,
    oil_pressure_kpa: 385, fuel_flow_lph: 12.5, vibration_mm_s: 1.8,
    mixture_ratio: 14.6, altitude_m: [4800, 4800], airspeed_ms: [38, 38],
  },
  descent: {
    rpm: 1650, throttle_pct: 25, egt_c: 625, cht_c: 160, oil_temp_c: 84,
    oil_pressure_kpa: 375, fuel_flow_lph: 9, vibration_mm_s: 1.5,
    mixture_ratio: 14.1, altitude_m: [4800, 300], airspeed_ms: [38, 34],
  },
  landing: {
    rpm: 1200, throttle_pct: 15, egt_c: 575, cht_c: 140, oil_temp_c: 80,
    oil_pressure_kpa: 365, fuel_flow_lph: 6.5, vibration_mm_s: 1.2,
    mixture_ratio: 14.0, altitude_m: [300, 0], airspeed_ms: [34, 0],
  },
};

// Process-noise sigma / sanity bounds per parameter.
const PARAM_DEFS = {
  rpm: { sigma: 15, min: 600, max: 3000 },
  throttle_pct: { sigma: 1, min: 0, max: 100 },
  egt_c: { sigma: 8, min: 400, max: 950 },
  cht_c: { sigma: 4, min: 60, max: 280 },
  oil_temp_c: { sigma: 1.5, min: 30, max: 160 },
  oil_pressure_kpa: { sigma: 5, min: 150, max: 500 },
  fuel_flow_lph: { sigma: 0.4, min: 0, max: 60 },
  vibration_mm_s: { sigma: 0.25, min: 0.1, max: 12 },
  mixture_ratio: { sigma: 0.08, min: 10, max: 17 },
  altitude_m: { sigma: 10, min: 0, max: 8000 },
  airspeed_ms: { sigma: 0.6, min: 0, max: 200 },
};

// First-order lag gains per parameter. Thermal parameters use a small gain:
// metal heats/cools far slower than the engine spins up, so egt/cht/oil temps
// trail throttle/rpm changes by design (spec §5.1 step 2).
const LAG_GAIN = {
  rpm: 0.5,
  throttle_pct: 0.6,
  egt_c: 0.3,
  cht_c: 0.14,
  oil_temp_c: 0.1,
  oil_pressure_kpa: 0.4,
  fuel_flow_lph: 0.35,
  vibration_mm_s: 0.25,
  mixture_ratio: 0.35,
  altitude_m: 0.35,
  airspeed_ms: 0.35,
};

// Fuel tank capacity and start level (L) for fuel_remaining_l (pure clock).
const FUEL_TANK_L = 320;

const RAMPED_PARAM = new Set(['altitude_m', 'airspeed_ms']);

/**
 * Target value of a param inside a phase at progress p∈[0,1].
 * Ramps interpolate [start,end]; steady params return their constant.
 */
function targetAt(phaseId, param, p) {
  const profile = PHASE_PROFILES[phaseId];
  if (!profile || !(param in profile)) {
    // unknown/undefined param -> a physically neutral default
    if (param === 'fuel_remaining_l') return FUEL_TANK_L;
    return 0;
  }
  const v = profile[param];
  if (RAMPED_PARAM.has(param) && Array.isArray(v)) {
    return v[0] + (v[1] - v[0]) * clamp01(p);
  }
  return typeof v === 'number' ? v : 0;
}

/** Which phase id contains t_s (null when outside every phase). */
function phaseAt(phases, t) {
  for (const seg of phases || []) {
    if (t >= seg.start_s && t < seg.end_s) return seg.phase;
  }
  return null;
}

/** Progress (0..1) within the phase containing t_s. */
function phaseProgress(phases, t) {
  for (const seg of phases || []) {
    if (t >= seg.start_s && t < seg.end_s) {
      const span = Math.max(1, seg.end_s - seg.start_s);
      return clamp01((t - seg.start_s) / span);
    }
  }
  return null;
}

/** Cosine ease over [0,1]. */
function ease(t) {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Linear interpolation straddling a value. */
function lerp(a, b, t) { return a + (b - a) * clamp01(t); }

function buildPhaseSchedule(template) {
  return Array.isArray(template) && template.length
    ? template.map((s) => ({ phase: s.phase, start_s: s.start_s, end_s: s.end_s }))
    : DEFAULT_PHASES.map((s) => ({ ...s }));
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_PHASES,
  DEFAULT_DURATION_S,
  DEFAULT_SAMPLE_RATE_HZ,
  TRANSITION_WINDOW_S,
  PHASE_PROFILES,
  PARAM_DEFS,
  LAG_GAIN,
  FUEL_TANK_L,
  targetAt,
  phaseAt,
  phaseProgress,
  ease,
  lerp,
  clamp01,
  buildPhaseSchedule,
  RAMPED_PARAM,
  PARAM_NAMES: Object.keys(PARAM_DEFS),
  PROFILE_PHASES: Object.keys(PHASE_PROFILES),
};