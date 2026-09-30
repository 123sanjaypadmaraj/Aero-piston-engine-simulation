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

  // --- second-wave classes -------------------------------------------------
  // Added so the generator can express a wider set of real piston-engine
  // failure modes, and so the detectors can be scored against more than one
  // shape of ground truth. Each still has to be detectably separable from
  // nominal flight by the rule table below.

  carburetor_icing: {
    label: 'Carburettor icing',
    affectedParams: ['fuel_flow_lph', 'mixture_ratio', 'egt_c', 'rpm'],
    defaultDurationS: 480,
    defaultPrecursorS: 30,
    description: 'Venturi ice restricts fuel delivery: flow sags, mixture goes rich, EGT follows.',
  },
  fuel_filter_blockage: {
    label: 'Fuel filter blockage',
    affectedParams: ['fuel_flow_lph', 'egt_c', 'rpm'],
    defaultDurationS: 900,
    defaultPrecursorS: 60,
    description: 'Progressive filter clog: rising restriction with falling flow at fixed throttle.',
  },
  water_ingestion: {
    label: 'Water ingestion',
    affectedParams: ['egt_c', 'rpm', 'cht_c'],
    defaultDurationS: 360,
    defaultPrecursorS: 25,
    description: 'Contaminated fuel: violent EGT swing, rpm stumble, brief CHT rise.',
  },
  prop_imbalance: {
    label: 'Propeller imbalance',
    affectedParams: ['vibration_mm_s', 'rpm'],
    defaultDurationS: 1200,
    defaultPrecursorS: 120,
    description: 'Slowly growing once-per-revolution vibration with a small rpm wobble.',
  },
  bearing_wear: {
    label: 'Bearing wear',
    affectedParams: ['vibration_mm_s', 'oil_temp_c', 'oil_pressure_kpa'],
    defaultDurationS: 1800,
    defaultPrecursorS: 180,
    description: 'Bearing degradation: vibration climbs slowly as oil temp rises and pressure decays.',
  },
  clutch_slip: {
    label: 'Clutch slip',
    affectedParams: ['rpm', 'vibration_mm_s', 'fuel_flow_lph'],
    defaultDurationS: 600,
    defaultPrecursorS: 40,
    description: 'Clutch slips under load: commanded rpm falls short while vibration rises.',
  },
  turbo_overboost: {
    label: 'Overboost / wastegate stuck',
    affectedParams: ['mixture_ratio', 'egt_c', 'cht_c', 'fuel_flow_lph'],
    defaultDurationS: 540,
    defaultPrecursorS: 35,
    description: 'Excess charge from a stuck wastegate: rich mixture, high EGT and CHT.',
  },
  exhaust_leak: {
    label: 'Exhaust leak',
    affectedParams: ['egt_c', 'rpm', 'mixture_ratio'],
    defaultDurationS: 1080,
    defaultPrecursorS: 90,
    description: 'Leaking manifold washes out the EGT probe and unloads the engine.',
  },
  magneto_failure: {
    label: 'Ignition / magneto failure',
    affectedParams: ['rpm', 'egt_c', 'vibration_mm_s'],
    defaultDurationS: 300,
    defaultPrecursorS: 20,
    description: 'Intermittent loss of ignition: repeated rpm dropouts with EGT collapse.',
  },
  battery_fault: {
    label: 'Charging / electrical fault',
    // A mission-replay frame has no battery-voltage channel, so this class is
    // expressed through what a failing alternator or harness does to the
    // engine: charge voltage droops, the engine hunts, and vibration picks up.
    affectedParams: ['rpm', 'vibration_mm_s', 'fuel_flow_lph'],
    defaultDurationS: 1500,
    defaultPrecursorS: 150,
    description: 'Charging fault: unstable charge makes the engine hunt and vibrate.',
  },
  air_filter_clog: {
    label: 'Air filter blockage',
    affectedParams: ['mixture_ratio', 'egt_c', 'rpm'],
    defaultDurationS: 1200,
    defaultPrecursorS: 100,
    description: 'Starved intake air: mixture enriches, charge temperature rises, rpm droops.',
  },
  static_discharge: {
    label: 'Static / electrical noise',
    // No battery channel in a replay frame, so this is the false-vibration
    // signature such noise produces on the mechanical side.
    affectedParams: ['vibration_mm_s'],
    defaultDurationS: 420,
    defaultPrecursorS: 20,
    description: 'Transient electrical noise shows up as short, sharp vibration spikes.',
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
  'carburetor_icing',
  'fuel_filter_blockage',
  'water_ingestion',
  'prop_imbalance',
  'bearing_wear',
  'clutch_slip',
  'turbo_overboost',
  'exhaust_leak',
  'magneto_failure',
  'battery_fault',
  'air_filter_clog',
  'static_discharge',
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

  // --- second wave ---------------------------------------------------------
  // The calibration run against the full 7-phase envelope drove every one of
  // these numbers: a fixed egt/fuel_flow/rpm floor that sounds on cruise will
  // also sound on a cold taxi, and a floor that stays silent on taxi will miss
  // a cruise fault. The guards therefore split responsibility:
  //
  //   phases[]          - only evaluate the rule in the listed phases. Taxi,
  //                       takeoff and landing legitimately run cold EGT, low
  //                       fuel flow and low rpm, so low-signal rules are gated
  //                       to climb/cruise/loiter/descent flight.
  //   belowOfTarget     - rpm floors are expressed relative to the *phase
  //                       target* (takeoff spools up through idle rpms, so an
  //                       absolute floor fires during that transition). The
  //                       effective floor is min(below, target - belowOfTarget).
  //   variance          - unused: the first-order lag makes rpm swing well
  //                       outside a variance band on every phase transition,
  //                       so a variance detector fires on a clean takeoff.
  //                       Variance-based health stays in the per-phase L3 model
  //                       (analytics/missionReplayMetrics.js); the cheap rule
  //                       table here stays level- and phase-based.
  //
  // Calibrated clean bounds (phases gated to flight): cruise egt min ~702,
  // loiter min ~672, descent min ~601; cruise rpm min ~2242, loiter ~1949,
  // descent ~1623; cruise fuel-flow min ~16.7, loiter ~11.3; mixture max ~14.9.
  { fault: 'plug_fouling', severity: 'moderate', param: 'egt_c', below: 620, consecutive: 3, phases: ['climb', 'cruise', 'loiter'] },
  { fault: 'carburetor_icing', severity: 'moderate', param: 'fuel_flow_lph', below: 6.5, consecutive: 12, phases: ['climb', 'cruise', 'loiter'] },
  { fault: 'carburetor_icing', severity: 'critical', param: 'egt_c', below: 620, consecutive: 6, phases: ['climb', 'cruise', 'loiter'] },
  { fault: 'fuel_filter_blockage', severity: 'moderate', param: 'fuel_flow_lph', below: 6.5, consecutive: 20, phases: ['climb', 'cruise', 'loiter'] },
  { fault: 'water_ingestion', severity: 'severe', param: 'egt_c', above: 860, consecutive: 2 },
  { fault: 'prop_imbalance', severity: 'moderate', param: 'vibration_mm_s', above: 4.4, consecutive: 15 },
  { fault: 'bearing_wear', severity: 'moderate', param: 'vibration_mm_s', above: 4.6, consecutive: 25 },
  { fault: 'bearing_wear', severity: 'moderate', param: 'oil_temp_c', above: 118, consecutive: 20 },
  { fault: 'clutch_slip', severity: 'severe', param: 'rpm', below: 1900, belowOfTarget: 480, consecutive: 10, phases: ['climb', 'cruise', 'loiter', 'descent'] },
  { fault: 'turbo_overboost', severity: 'moderate', param: 'mixture_ratio', above: 15.3, consecutive: 10 },
  { fault: 'exhaust_leak', severity: 'moderate', param: 'egt_c', below: 620, consecutive: 12, phases: ['climb', 'cruise', 'loiter'] },
  { fault: 'magneto_failure', severity: 'critical', param: 'rpm', below: 1500, belowOfTarget: 620, consecutive: 3, phases: ['climb', 'cruise', 'loiter', 'descent'] },
  { fault: 'battery_fault', severity: 'low', param: 'rpm', consecutive: 12, below: 2100, belowOfTarget: 330, phases: ['climb', 'cruise', 'loiter', 'descent'] },
  { fault: 'air_filter_clog', severity: 'moderate', param: 'mixture_ratio', above: 15.2, consecutive: 15 },
  { fault: 'static_discharge', severity: 'moderate', param: 'vibration_mm_s', above: 6.2, consecutive: 2 },
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
      // A misfire dumps unburnt charge, so EGT falls far enough to cross a
      // level guard. It is the only reliable level signature of fouling.
      if (param === 'egt_c') return clamp(nominal - 145 * mult * wobble, 400, 950);
      if (param === 'vibration_mm_s') return clamp(nominal + 0.55 * mult, 0.1, 12);
      if (param === 'mixture_ratio') return clamp(nominal + 0.3 * mult * wobble, 10, 17);
      return nominal;
    }
    case 'detonation_risk': {
      // mixture first, then charge temperature. The mixture_ratio guard is the
      // reliable one; a rich burn still pushes cht past the knock guard.
      if (param === 'mixture_ratio') return clamp(nominal + 1.05 * mult * p, 10, 17);
      if (param === 'cht_c') return clamp(nominal + 52 * mult * p, 60, 285);
      if (param === 'egt_c') return clamp(nominal + 30 * mult * p, 400, 950);
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

    // --- second wave ------------------------------------------------------
    case 'carburetor_icing': {
      // fuel delivery restricted: flow sags, mixture goes RICH, EGT follows down
      const fast = clamp01(p / 0.25);
      if (param === 'fuel_flow_lph') return clamp(nominal * (1 - 0.62 * mult * fast), 0, 60);
      if (param === 'mixture_ratio') return clamp(nominal + 0.85 * mult * fast, 10, 17);
      if (param === 'egt_c') return clamp(nominal - 85 * mult * fast, 400, 950);
      if (param === 'rpm') return clamp(nominal - 130 * mult * fast, 600, 3000);
      return nominal;
    }
    case 'fuel_filter_blockage': {
      // progressive: restriction grows with p, flow falls, EGT sags
      if (param === 'fuel_flow_lph') return clamp(nominal * (1 - 0.55 * mult * p), 0, 60);
      if (param === 'egt_c') return clamp(nominal - 45 * mult * p, 400, 950);
      if (param === 'rpm') return clamp(nominal - 90 * mult * p, 600, 3000);
      return nominal;
    }
    case 'water_ingestion': {
      // violent but brief: EGT spikes then swings, rpm stumbles
      const bump = Math.sin(Math.min(1, p) * Math.PI);
      if (param === 'egt_c') return clamp(nominal + 95 * mult * bump, 400, 950);
      if (param === 'rpm') return clamp(nominal - 210 * mult * bump, 600, 3000);
      if (param === 'cht_c') return clamp(nominal + 24 * mult * bump, 60, 285);
      if (param === 'vibration_mm_s') return clamp(nominal + 1.6 * mult * bump, 0.1, 12);
      return nominal;
    }
    case 'prop_imbalance': {
      // once-per-rev style: magnitude grows slowly, rpm wobble is small
      const wobble = Math.sin(p * Math.PI * 26);
      if (param === 'vibration_mm_s') return clamp(nominal + 4.2 * mult * p + 0.7 * mult * wobble, 0.1, 14);
      if (param === 'rpm') return clamp(nominal + 11 * mult * wobble, 600, 3000);
      return nominal;
    }
    case 'bearing_wear': {
      // slow and monotonic across three channels
      if (param === 'vibration_mm_s') return clamp(nominal + 3.4 * mult * p, 0.1, 14);
      if (param === 'oil_temp_c') return clamp(nominal + 20 * mult * p, 30, 175);
      if (param === 'oil_pressure_kpa') return clamp(nominal - 95 * mult * p, 120, 500);
      return nominal;
    }
    case 'clutch_slip': {
      // engine cannot hold commanded speed: rpm sags hard, vibration rises
      if (param === 'rpm') return clamp(nominal - 520 * mult * clamp01(p / 0.3), 600, 3000);
      if (param === 'vibration_mm_s') return clamp(nominal + 1.5 * mult * p, 0.1, 14);
      if (param === 'fuel_flow_lph') return clamp(nominal + 3.5 * mult * p, 0, 60);
      return nominal;
    }
    case 'turbo_overboost': {
      // excess charge: rich mixture, EGT and CHT up, flow up
      if (param === 'mixture_ratio') return clamp(nominal + 0.95 * mult * p, 10, 17);
      if (param === 'egt_c') return clamp(nominal + 55 * mult * p, 400, 950);
      if (param === 'cht_c') return clamp(nominal + 38 * mult * p, 60, 285);
      if (param === 'fuel_flow_lph') return clamp(nominal * (1 + 0.28 * mult * p), 0, 60);
      return nominal;
    }
    case 'exhaust_leak': {
      // probe washes out -> EGT reads low and erratic, engine unloads
      const unsteady = 0.5 + 0.5 * Math.sin(p * Math.PI * 14);
      if (param === 'egt_c') return clamp(nominal - (60 + 55 * unsteady) * mult * clamp01(p / 0.2), 400, 950);
      if (param === 'rpm') return clamp(nominal - 105 * mult * p, 600, 3000);
      if (param === 'mixture_ratio') return clamp(nominal + 0.4 * mult * p, 10, 17);
      return nominal;
    }
    case 'magneto_failure': {
      // repeated hard dropouts: rpm falls off a long way, EGT collapses with it
      const drop = Math.abs(Math.sin(p * Math.PI * 10)) > 0.8 ? 1 : 0;
      if (param === 'rpm') return clamp(nominal - (drop ? 760 * mult : 25 * mult), 600, 3000);
      if (param === 'egt_c') return clamp(nominal - (drop ? 240 * mult : 20 * mult), 400, 950);
      if (param === 'vibration_mm_s') return clamp(nominal + 1.1 * mult * drop, 0.1, 14);
      return nominal;
    }
    case 'battery_fault': {
      // A sagging alternator lets the engine hunt and eventually cannot hold
      // its commanded speed, so the level signature is a sustained rpm deficit.
      if (param === 'rpm') return clamp(nominal - 300 * mult * p, 600, 3000);
      if (param === 'vibration_mm_s') return clamp(nominal + 1.2 * mult * p, 0.1, 14);
      if (param === 'fuel_flow_lph') return clamp(nominal * (1 + 0.07 * mult * p), 0, 60);
      return nominal;
    }
    case 'air_filter_clog': {
      // starved air: mixture enriches, EGT rises, rpm droops
      if (param === 'mixture_ratio') return clamp(nominal + 0.8 * mult * p, 10, 17);
      if (param === 'egt_c') return clamp(nominal + 34 * mult * p, 400, 950);
      if (param === 'rpm') return clamp(nominal - 75 * mult * p, 600, 3000);
      return nominal;
    }
    case 'static_discharge': {
      // narrow, sharp spikes rather than a sustained offset
      const spike = Math.abs(Math.sin(p * Math.PI * 18)) > 0.94 ? 1 : 0;
      if (param === 'vibration_mm_s') return clamp(nominal + (spike ? 4.2 * mult : 0.1 * mult), 0.1, 14);
      return nominal;
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
    if (rule.phases && !(rule.phases || []).includes(params.phase)) continue;
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
      if (rule.below !== undefined && Number.isFinite(v)) {
        // relative floor: a fixed rpm guard would fire on taxi and never on
        // climb, so guard against the phase target as well as the absolute
        // number.
        if (rule.belowOfTarget && refs.targets && Number.isFinite(refs.targets[rule.param])) {
          breached = v < Math.min(rule.below, refs.targets[rule.param] - rule.belowOfTarget);
        } else {
          breached = v < rule.below;
        }
      }
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