/**
 * missionreplay/faultLib.js
 * -----------------------------------------------------------------------
 * Fault taxonomy for the mission replay generator (spec §5.2 / §5.3).
 *
 * Two halves:
 *   1. INJECTION  - time-windowed degradation functions applied to the
 *                   nominal telemetry value of a parameter.
 *   2. DETECTION  - threshold rule table evaluated sample-by-sample. Each
 *                   rule keeps its own consecutive-sample counter, so a rule
 *                   fires only after N consecutive samples breach the guard.
 *
 * All functions are pure and deterministic. The generator owns counters.
 * -----------------------------------------------------------------------
 */

'use strict';

const FAULT_TYPES = {
  oil_pressure_degradation: {
    label: 'Worn oil pump',
    affectedParams: ['oil_pressure_kpa', 'oil_temp_c'],
    defaultDurationS: 900,
    defaultPrecursorS: 60,
    description: 'Gradual bleed of oil pressure from a worn pump; slight oil temp rise.',
  },
  oil_starvation: {
    label: 'Oil starvation',
    affectedParams: ['oil_pressure_kpa', 'oil_temp_c'],
    defaultDurationS: 600,
    defaultPrecursorS: 20,
    description: 'Rapid oil pressure collapse (pickup screen blocked, pump failure).',
  },
  plug_fouling: {
    label: 'Plug fouling',
    affectedParams: ['rpm', 'egt_c', 'vibration_mm_s', 'mixture_ratio'],
    defaultDurationS: 1200,
    defaultPrecursorS: 90,
    description: 'Intermittent misfire: rpm jerk, EGT dip, mild vibration rise.',
  },
  detonation_risk: {
    label: 'Detonation risk',
    affectedParams: ['cht_c', 'egt_c', 'mixture_ratio'],
    defaultDurationS: 600,
    defaultPrecursorS: 45,
    description: 'Lean mixture and hot chamber approaching knock threshold.',
  },
  overheating: {
    label: 'Cooling fault / overheating',
    affectedParams: ['cht_c', 'oil_temp_c'],
    defaultDurationS: 900,
    defaultPrecursorS: 60,
    description: 'Coolant/cooling failure; CHT climbs above structural limit.',
  },
  fuel_starvation: {
    label: 'Fuel starvation',
    affectedParams: ['fuel_flow_lph', 'fuel_remaining_l'],
    defaultDurationS: 720,
    defaultPrecursorS: 40,
    description: 'Fuel flow collapses; mixture leans and cylinder cools off.',
  },
  vibration_anomaly: {
    label: 'Vibration anomaly',
    affectedParams: ['vibration_mm_s', 'rpm'],
    defaultDurationS: 540,
    defaultPrecursorS: 30,
    description: 'Above-nominal airframe vibes, typically shaft/balance related.',
  },
  sensor_dropout: {
    label: 'Sensor dropout',
    affectedParams: ['egt_c'],
    defaultDurationS: 240,
    defaultPrecursorS: 10,
    description: 'Sensor returns out-of-range/NaN for a window.',
  },
};

const SEVERITY_MULT = { low: 0.4, moderate: 0.7, severe: 1.0, critical: 1.3 };

// Serialisable "sensor out of range" marker for dropped/NaN sensors.
// JSON has no NaN, so a dropped sensor writes -32000 (int16-ish overrange).
const OVERRANGE_SENSOR = -32000;

const FAULT_PHASE_ORDER = [
  'oil_pressure_degradation',
  'oil_starvation',
  'plug_fouling',
  'detonation_risk',
  'overheating',
  'fuel_starvation',
  'vibration_anomaly',
  'sensor_dropout',
];

/**
 * Detection rule table (spec §5.3). Each rule:
 *   fault       - fault type it declares
 *   severity    - declared on trigger (downgraded to base below guard = 'low')
 *   param       - telemetry param examined (null => composite)
 *   below/above - numeric guard (inclusive breach)
 *   consecutive - consecutive samples that must stay breached
 *   reference   - optional { param, factor } evaluated vs a running reference
 */
const DETECT_RULES = [
  { fault: 'oil_pressure_degradation', severity: 'moderate', param: 'oil_pressure_kpa', below: 350, consecutive: 10 },
  { fault: 'oil_starvation', severity: 'critical', param: 'oil_pressure_kpa', below: 250, consecutive: 3 },
  { fault: 'overheating', severity: 'moderate', param: 'cht_c', above: 240, aboveOfTarget: 20, consecutive: 5 },
  { fault: 'overheating', severity: 'critical', param: 'cht_c', above: 265, consecutive: 3 },
  { fault: 'detonation_risk', severity: 'moderate', param: 'mixture_ratio', above: 15.5, consecutive: 8 },
  { fault: 'detonation_risk', severity: 'critical', param: 'cht_c', above: 279, consecutive: 2 },
  { fault: 'vibration_anomaly', severity: 'severe', param: 'vibration_mm_s', above: 6.0, consecutive: 5 },
  { fault: 'vibration_anomaly', severity: 'critical', param: 'vibration_mm_s', above: 8.5, consecutive: 3 },
  { fault: 'fuel_starvation', severity: 'moderate', param: 'fuel_flow_lph', below: 5.0, consecutive: 10 },
  { fault: 'sensor_dropout', severity: 'low', param: 'sensor_nan', nanCheck: true, consecutive: 1 },
];

// Severity printed/serialised map: critical rule for oil_pressure keeps grade.
const DEFAULT_FALLBACK_DETECTED = { detected: false, severity: null };

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return hi;
  return Math.max(lo, Math.min(hi, x));
}
function clamp01(x) { return clamp(x, 0, 1); }

/**
 * Simple pseudo-random normal generator derived from the mission RNG (not used
 * here; provided for parity with engine_sim conventions). Kept for API parity.
 */
function normal(rand) {
  // Box-Muller, deterministic from seeded rand() in [0,1).
  let u = 0;
  let v = 0;
  do { u = rand(); } while (u === 0);
  do { v = rand(); } while (v === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Compute the *degraded* value for a single param at time t given the fault's
 * windowed age p∈[0,1] (progress through [onset, onset+duration]).
 *
 * @param type    fault type id
 * @param param   telemetry param being modified
 * @param nominal nominal (already-lagged) value
 * @param p       fault window progress 0..1
 * @param severity one of SEVERITY_MULT keys
 * @param rng     seeded ()->[0,1) function for jitter (deterministic)
 */
function applyFaultValue(type, param, nominal, p, severity, rng) {
  const mult = SEVERITY_MULT[severity] || 1;
  switch (type) {
    case 'oil_pressure_degradation': {
      const drop = 160 * mult * p;
      if (param === 'oil_pressure_kpa') return clamp(nominal - drop, 120, 500);
      if (param === 'oil_temp_c') return clamp(nominal + 2.5 * mult * p, 30, 160);
      return nominal;
    }
    case 'oil_starvation': {
      // fast collapse: within 5% of the window, drop to the severity floor
      const fast = clamp01(p / 0.05);
      const floorKpa = { moderate: 200, severe: 150, critical: 120 }[severity] || 150;
      if (param === 'oil_pressure_kpa') return clamp(nominal - (nominal - floorKpa) * fast, 80, 500);
      if (param === 'oil_temp_c') return clamp(nominal + 14 * mult * fast, 30, 170);
      return nominal;
    }
    case 'plug_fouling': {
      // intermittent misfire: square-ish dips every ~25s within the window
      const wobble = Math.abs(Math.sin(p * Math.PI * 8)) > 0.88 ? 1 : 0;
      if (param === 'rpm') return clamp(nominal + Math.sin(p * Math.PI * 8) * 28 * mult, 600, 3000);
      if (param === 'egt_c') return clamp(nominal - 70 * mult * wobble, 400, 950);
      if (param === 'vibration_mm_s') return clamp(nominal + 0.55 * mult, 0.1, 12);
      if (param === 'mixture_ratio') return clamp(nominal + 0.3 * mult * wobble, 10, 17);
      return nominal;
    }
    case 'detonation_risk': {
      if (param === 'cht_c') return clamp(nominal + 52 * mult * p, 60, 285);
      if (param === 'egt_c') return clamp(nominal + 30 * mult * p, 400, 950);
      if (param === 'mixture_ratio') return clamp(nominal + 0.55 * mult * p, 10, 17);
      return nominal;
    }
    case 'overheating': {
      if (param === 'cht_c') return clamp(nominal + 62 * mult * p, 60, 295);
      if (param === 'oil_temp_c') return clamp(nominal + 28 * mult * p, 30, 175);
      return nominal;
    }
    case 'fuel_starvation': {
      if (param === 'fuel_flow_lph') return clamp(nominal * (1 - 0.78 * mult * clamp01(p / 0.15)), 0, 60);
      if (param === 'fuel_remaining_l') return clamp(nominal - 1.4 * mult * p, 0, 9999);
      if (param === 'egt_c') return clamp(nominal + 22 * mult * clamp01(p / 0.2), 400, 950);
      return nominal;
    }
    case 'vibration_anomaly': {
      if (param === 'vibration_mm_s') return clamp(nominal + 4.5 * mult * clamp01(p / 0.2), 0.1, 14);
      if (param === 'rpm') return clamp(nominal + (rng ? (rng() - 0.5) * 30 * mult : 0), 600, 3000);
      return param === 'vibration_mm_s' ? nominal + (rng ? rng() * 0.2 : 0) : nominal;
    }
    case 'sensor_dropout': {
      // only affect the configured sensor param -> out-of-range marker
      return OVERRANGE_SENSOR;
    }
    default:
      return nominal;
  }
}

/**
 * Apply the configured fault set to a single nominal telemetry object.
 *
 * @param nominal  { t_s, flight:{...}, mechanical:{...}, thermal:{...}, fuel:{...} }
 * @param faults   array of active faults: { type, onset_s, duration_s, severity,
 *                 sampleValue(param, t, rng) => degraded param value }
 *
 * We pre-bind the driver via faultLib.bindActiveFaults so sampleValue can be
 * introspected by the generator without churn. Pure function otherwise.
 */
function bindActiveFaults(active) {
  return active.map((f) => ({
    type: f.type,
    onset_s: f.onset_s,
    severity: f.severity,
    sampleValue(param, t, rng) {
      const dur = f.duration_s || FAULT_TYPES[f.type].defaultDurationS;
      const p = dur > 0 ? clamp01((t - f.onset_s) / dur) : 1;
      return applyFaultValue(f.type, param, 0, p, f.severity, rng);
    },
  }));
}

/**
 * Evaluate the DETECT_RULES table against a freshly generated sample.
 *
 * @param sample    the sample object (fields already set incl. fault overlays)
 * @param refs      { nominal: {param: nominalValue}, referenceValue(param) }
 * @param counters  state map keyed by rule.fault+param guard string; counters
 *                  increment on breach, reset otherwise
 * @returns [{ fault, severity }] of rules that just crossed their count
 */
function evaluateDetectionRules(sample, refs, counters) {
  const params = Object.assign(
    {},
    sample.flight, sample.mechanical, sample.thermal, sample.fuel, sample,
  );
  const out = [];
  for (const rule of DETECT_RULES) {
    const key = [rule.fault, rule.param, rule.below, rule.above].join(':');
    let breached = false;
    if (rule.nanCheck) {
      let anyNaN = false;
      for (const k of Object.keys(params)) {
        const v = params[k];
        if (Number.isNaN(v) || v === OVERRANGE_SENSOR) anyNaN = true;
      }
      breached = anyNaN;
    } else if (rule.param && rule.param in params) {
      const v = params[rule.param];
      if (rule.below !== undefined && Number.isFinite(v)) breached = v < rule.below;
      if (rule.above !== undefined && Number.isFinite(v)) {
        // relative guard: rule fires sooner when the phase target itself runs
        // hot (e.g. CHT on climb), later when the target is cold (cruise)
        if (rule.aboveOfTarget && refs.targets && Number.isFinite(refs.targets[rule.param])) {
          breached = v > Math.max(rule.above, refs.targets[rule.param] + rule.aboveOfTarget);
        } else {
          breached = v > rule.above;
        }
      }
    }
    const n = (counters[key] || 0) + (breached ? 1 : 0);
    counters[key] = breached ? n : 0;
    if (breached && n >= (rule.consecutive || 1)) {
      out.push({ fault: rule.fault, severity: rule.severity || 'low' });
      counters[key] = 0;
    }
  }
  return out;
}

/** Optional strict severity fallback for a given reading (used by detector). */
function severityOf(faultId, pValue) {
  return faultId === 'oil_pressure_kpa' && pValue < 280 ? 'critical'
    : faultId === 'cht_c' && pValue > 260 ? 'critical'
      : SEVERITY_MULT[Object.keys(SEVERITY_MULT)[0]] ? 'moderate' : 'low';
}

module.exports = {
  FAULT_TYPES,
  SEVERITY_MULT,
  DETECT_RULES,
  FAULT_PHASE_ORDER,
  OVERRANGE_SENSOR,
  applyFaultValue,
  bindActiveFaults,
  evaluateDetectionRules,
  normal,
  severityOf,
  DEFAULT_FALLBACK_DETECTED,
};