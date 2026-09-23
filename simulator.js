/**
 * simulator.js
 * -----------------------------------------------------------------------
 * Spoofed/synthetic telemetry generator for the Aero Piston Engine Digital
 * Twin. Stands in for the real sensor bus (CHT/EGT probes, oil pressure
 * transducers, MEMS vibration sensors, fuel flow meters, etc.) that would
 * normally feed the digital twin from the UAV's engine control unit.
 *
 * Each simulated engine keeps:
 *  - a "true state" that random-walks around a nominal operating point
 *  - an optional active fault scenario that biases the walk toward a
 *    degraded condition (overheat, oil pressure loss, vibration/imbalance,
 *    fuel starvation) for a limited duration
 *  - a rolling history window per sensor used for lightweight statistical
 *    anomaly detection (rolling mean/std -> z-score), which feeds a
 *    rule + anomaly based "health score" and predictive fault classifier.
 *
 * This is intentionally dependency-free rule/statistics based logic
 * (no external ML runtime needed) so the whole stack runs anywhere with
 * just Node.js, while still producing believable, non-trivial telemetry,
 * alerts and predictions for a live demo.
 * -----------------------------------------------------------------------
 */

'use strict';

const {
  computeHealthIndex,
  MultivariateAnomalyDetector,
  estimateRUL,
  deriveRulFeatures,
  explain,
  recommend,
  createFatigueState,
  advanceFatigue,
  fatigueReport,
} = require('./analytics');
const { createRng } = require('./engine_sim/rng');

// ---- Sensor definitions -------------------------------------------------
// Nominal operating band + warning/critical thresholds, loosely modelled on
// a Rotax-912-class four-stroke piston engine as used on MALE UAVs
// (e.g. Heron / Searcher class platforms).
// Each sensor is classified against up to four thresholds:
//   lowCrit < lowWarn <= [nominal band] <= highWarn < highCrit
// A bound left as +-Infinity simply means "that side is never the bad side"
// (e.g. cylinder head temp only has an upper danger side; oil pressure only
// has a lower danger side). RPM is a genuine two-sided band since both an
// over-speed and an under-speed condition are unsafe.
const SENSORS = {
  rpm: { unit: 'RPM', nominal: [4600, 5600], lowWarn: 4200, lowCrit: 3800, highWarn: 5800, highCrit: 6100, label: 'Engine Speed' },
  cht: { unit: '°C', nominal: [90, 145], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 145, highCrit: 168, label: 'Cylinder Head Temp' },
  egt: { unit: '°C', nominal: [650, 760], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 760, highCrit: 800, label: 'Exhaust Gas Temp' },
  oilPressure: { unit: 'psi', nominal: [45, 62], lowWarn: 45, lowCrit: 30, highWarn: Infinity, highCrit: Infinity, label: 'Oil Pressure' },
  oilTemp: { unit: '°C', nominal: [80, 108], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 108, highCrit: 125, label: 'Oil Temperature' },
  fuelFlow: { unit: 'L/h', nominal: [12, 18], lowWarn: 12, lowCrit: 8, highWarn: Infinity, highCrit: Infinity, label: 'Fuel Flow' },
  vibration: { unit: 'mm/s', nominal: [0.4, 2.4], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 2.4, highCrit: 4.2, label: 'Vibration' },
  manifoldPressure: { unit: 'kPa', nominal: [88, 106], lowWarn: 88, lowCrit: 78, highWarn: Infinity, highCrit: Infinity, label: 'Manifold Pressure' },
  batteryVoltage: { unit: 'V', nominal: [12.6, 14.6], lowWarn: 12.6, lowCrit: 11.8, highWarn: Infinity, highCrit: Infinity, label: 'Battery Voltage' },
  lambda: { unit: 'AFR', nominal: [13.2, 15.0], lowWarn: 12.6, lowCrit: 11.5, highWarn: 15.2, highCrit: 16.0, label: 'Air-Fuel Ratio (λ)' },
  injectorPulseWidth: { unit: 'ms', nominal: [2.4, 4.4], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 4.4, highCrit: 5.2, label: 'Injector Pulse Width' },
  injectionTiming: { unit: '°BTDC', nominal: [20, 30], lowWarn: 18, lowCrit: 15, highWarn: 30, highCrit: 34, label: 'Injection Timing' },
  alternatorCurrent: { unit: 'A', nominal: [6, 32], lowWarn: 6, lowCrit: 4, highWarn: Infinity, highCrit: Infinity, label: 'Alternator Current' },
};

// `drift` entries are the peak deviation each affected sensor is driven to,
// expressed as a FRACTION of that sensor's nominal span (so comparable across
// sensors of wildly different ranges, e.g. RPM vs battery voltage); the fault
// ramps toward that offset and holds it for the rest of the fault arc.
const FAULT_TYPES = {
  overheat: {
    label: 'Thermal Overload (CHT/EGT Rising)',
    affects: ['cht', 'egt', 'oilTemp'],
    drift: { cht: 1.0, egt: 1.3, oilTemp: 0.9 },
  },
  oilLoss: {
    label: 'Oil Pressure Loss',
    affects: ['oilPressure', 'oilTemp', 'vibration'],
    drift: { oilPressure: -1.5, oilTemp: 0.6, vibration: 0.05 },
  },
  vibration: {
    label: 'Mechanical Imbalance / Vibration Anomaly',
    affects: ['vibration', 'rpm'],
    drift: { vibration: 1.1, rpm: -0.9 },
    wobble: { vibration: 0.25, rpm: 10 },
  },
  fuelStarvation: {
    label: 'Fuel System Degradation',
    affects: ['fuelFlow', 'rpm', 'manifoldPressure'],
    drift: { fuelFlow: -0.9, rpm: -1.0, manifoldPressure: -0.9 },
  },
  // ---- Master-plan fault families that were previously missing: ----------
  sensorDrift: {
    label: 'Sensor Drift / Failure',
    // The transducer drifts; the physical engine is untouched. batteryVoltage
    // is not shared with any other fault, so this stays a clean single-signal
    // (mis-)attribution rather than a correlated multi-sensor drift.
    affects: ['batteryVoltage'],
    bias: { batteryVoltage: -1.2 },
    drift: { batteryVoltage: -0.8 },
  },
  coking: {
    label: 'Cooling / Coking Degradation',
    affects: ['cht', 'egt', 'oilTemp', 'manifoldPressure'],
    drift: { cht: 1.1, egt: 1.0, oilTemp: 0.9, manifoldPressure: -0.8 },
  },
  injectorAbnormality: {
    label: 'Injector Abnormality',
    affects: ['lambda', 'injectorPulseWidth', 'fuelFlow', 'rpm'],
    drift: { lambda: 0.7, injectorPulseWidth: 0.7, fuelFlow: 0.9, rpm: -0.8 },
    wobble: { lambda: 0.12, injectorPulseWidth: 0.1 },
  },
  misfire: {
    label: 'Misfire',
    affects: ['rpm', 'egt', 'lambda'],
    drift: { rpm: -0.85, egt: -1.0, lambda: -0.8 },
    wobble: { rpm: 18, egt: 8, lambda: 0.12 },
  },
  combustionInstability: {
    label: 'Combustion Instability',
    affects: ['lambda', 'rpm', 'egt', 'manifoldPressure'],
    drift: { lambda: 0.8, rpm: -0.8, egt: 1.0, manifoldPressure: 0.9 },
    wobble: { lambda: 0.25, rpm: 12, egt: 10, manifoldPressure: 1.2 },
  },
};

const FLEET = [
  { id: 'uav-01', tail: 'RQ-M1 "Falcon"', engine: 'Rotax-912 iS (sim)' },
  { id: 'uav-02', tail: 'RQ-M2 "Kestrel"', engine: 'Rotax-912 iS (sim)' },
  { id: 'uav-03', tail: 'RQ-M3 "Harrier"', engine: 'Rotax-912 iS (sim)' },
];

// Physically possible range per sensor (a wider envelope than the nominal band).
// A sample outside it, or NaN/Infinity, is a sensor failure rather than an engine
// state, so it is reported as validity 'invalid' instead of being scored nominal.
const PHYSICAL_RANGE = {
  rpm: [0, 8000],
  cht: [-60, 400],
  egt: [-60, 1100],
  oilPressure: [0, 150],
  oilTemp: [-60, 250],
  fuelFlow: [0, 60],
  vibration: [0, 50],
  manifoldPressure: [10, 150],
  batteryVoltage: [0, 32],
  lambda: [8, 20],
  injectorPulseWidth: [0, 12],
  injectionTiming: [0, 60],
  alternatorCurrent: [0, 120],
};
const SENSOR_FAULT_MODES = ['nan', 'outOfRange', 'dropout'];
const STALE_AFTER_TICKS = 2; // consecutive missing samples before a sensor is flagged 'stale'

// Every per-engine collection below is bounded, so memory stays flat over
// days of uptime: rolling stats window, chart series, alerts, analytics history.
const HISTORY_WINDOW = 30; // samples kept for rolling stats / z-score
const TIMESERIES_LEN = 120; // samples kept for charting (~4 min @ 2s tick)
const MAX_ALERTS = 40; // alerts kept per engine
const ANALYTICS_HISTORY_LEN = 60; // health/anomaly score history for the RUL features
const WARMUP_MAX = 40; // healthy samples retained for fitting the anomaly detector

// Fault realism knobs. A fault should read like a slowly-developing
// maintenance-worthy condition, not a sudden slam: each affected sensor is
// driven toward a severity-scaled offset (bounded, see updateSensor), random
// faults are rare (FAULT_PROB) and persist long enough to look like a real
// developing failure, and a persistent critical condition re-announces itself
// at a human-plausible cadence rather than every 2s tick.
const DRIFT_TICKS = 40; // ticks (~80 s) for a fault to reach full severity
const NEXT_FAULT_MIN = 60; // ticks an engine idles before a random fault is possible
const NEXT_FAULT_MAX = 140;
const FAULT_PROB = 0.04; // chance per eligible tick to start a fault
const FAULT_TICKS_MIN = 50; // random fault duration (ticks)
const FAULT_TICKS_MAX = 120;
const FAULT_BREAK_MIN = 40; // cooldown ticks after a fault resolves
const FAULT_BREAK_MAX = 90;
const VALIDITY_COOLDOWN_MS = 30_000; // re-fire pacing for sensor validity warnings
const CRITICAL_COOLDOWN_MS = 90_000; // a sustained critical re-announces itself every ~90 s, not every 15 s
const PREDICTED_COOLDOWN_MS = 90_000; // prediction warnings re-fire at most once a minute and a half

function mid(range) { return (range[0] + range[1]) / 2; }
function clamp(v, lo, hi) {
  if (Number.isNaN(v)) return lo; // fail-safe rather than propagating NaN
  return Math.max(lo, Math.min(hi, v));
}
function isValidSample(key, v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= PHYSICAL_RANGE[key][0] && v <= PHYSICAL_RANGE[key][1];
}

function classify(sensorKey, value) {
  const def = SENSORS[sensorKey];
  // NaN compares false against every threshold and would silently read as nominal
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'warning';
  if (value <= def.lowCrit || value >= def.highCrit) return 'critical';
  if (value <= def.lowWarn || value >= def.highWarn) return 'warning';
  return 'nominal';
}

class EngineTwin {
  // opts.seed / opts.rng make the engine deterministic (default: Math.random);
  // opts.clock is a () => epoch-ms function used for alert timestamps/cooldowns.
  constructor(meta, opts = {}) {
    this.meta = meta;
    this.rng = typeof opts.rng === 'function' ? opts.rng : createRng(opts.seed);
    this.now = typeof opts.clock === 'function' ? opts.clock : Date.now;
    this._alertSeq = 0;
    this.state = {};
    this.lastGood = {}; // last valid sample per sensor (held while a sensor is invalid/stale)
    this.missingTicks = {}; // consecutive dropped samples per sensor
    this.sensorFaults = {}; // injected sensor failures: key -> { mode, ticksLeft }
    this.history = {}; // rolling window for z-score
    this.series = {}; // long timeseries for charts
    for (const key of Object.keys(SENSORS)) {
      const n = mid(SENSORS[key].nominal);
      this.state[key] = n;
      this.lastGood[key] = n;
      this.missingTicks[key] = 0;
      this.history[key] = [n];
      this.series[key] = [];
    }
    this.altitude = this.rand(3000, 6500); // m
    this.airspeed = this.rand(120, 175); // km/h
    this.hoursFlown = this.rand(120, 890);
    this.activeFault = null; // { type, ticksLeft, startedAt }
    this.faultCooldown = this.randInt(NEXT_FAULT_MIN, NEXT_FAULT_MAX); // ticks until a fault may start
    this.alerts = [];
    this.healthScore = 100;
    this.rul = 500; // remaining useful life, engine hours (sim)
    this.tick = 0;

    // Advanced analytics/ layer (rate-aware health index, multivariate
    // anomaly detection, RUL, explainability) — additive to the rule/z-score
    // model above, not a replacement for it.
    this.anomalyDetector = new MultivariateAnomalyDetector();
    this.warmupSamples = [];
    this.healthScoreHistory = [];
    this.anomalyScoreHistory = [];
    // Fatigue-RUL accumulator: deterministic per-tick Miner damage from the
    // surrogate part stresses (materialDB). No randomness, ever.
    this.fatigue = createFatigueState();
  }

  rand(a, b) { return a + this.rng() * (b - a); }
  randInt(a, b) { return Math.floor(this.rand(a, b + 1)); }
  gauss() {
    // Box-Muller, roughly N(0,1)
    let u = 0, v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Force a fault scenario now (used by tests / demos); same shape as a random one.
  forceFault(type, ticks = 30) {
    if (!Object.prototype.hasOwnProperty.call(FAULT_TYPES, type)) {
      throw new RangeError(`unknown fault type "${type}"; allowed: ${Object.keys(FAULT_TYPES).join(', ')}`);
    }
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10000) throw new RangeError('ticks must be an integer between 1 and 10000');
    this.activeFault = { type, ticksLeft: ticks, severityRamp: 0 };
  }

  // Simulate a failing transducer for the next `ticks` samples: 'nan' (garbage),
  // 'outOfRange' (impossible value) or 'dropout' (no sample arrives). The true
  // engine state is untouched, only the acquired reading is corrupted.
  injectSensorFault(key, mode, ticks = 10) {
    if (!Object.prototype.hasOwnProperty.call(SENSORS, key)) throw new RangeError(`unknown sensor "${key}"`);
    if (!SENSOR_FAULT_MODES.includes(mode)) throw new RangeError(`unknown sensor fault mode "${mode}"; allowed: ${SENSOR_FAULT_MODES.join(', ')}`);
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10000) throw new RangeError('ticks must be an integer between 1 and 10000');
    this.sensorFaults[key] = { mode, ticksLeft: ticks };
  }

  maybeStartFault() {
    if (this.activeFault) return;
    if (this.faultCooldown > 0) { this.faultCooldown--; return; }
    // Only a rare random fault is possible once the cooldown has elapsed —
    // a healthy fleet is mostly quiet, with an occasional developing anomaly.
    if (this.rng() < FAULT_PROB) {
      const keys = Object.keys(FAULT_TYPES);
      const type = keys[this.randInt(0, keys.length - 1)];
      this.activeFault = {
        type,
        ticksLeft: this.randInt(FAULT_TICKS_MIN, FAULT_TICKS_MAX),
        severityRamp: 0,
      };
    } else {
      this.faultCooldown = this.randInt(10, 20);
    }
  }

  stepFault() {
    if (!this.activeFault) return {};
    const fault = FAULT_TYPES[this.activeFault.type];
    this.activeFault.ticksLeft--;
    // severity ramps linearly toward full strength over DRIFT_TICKS ticks, so
    // a fault develops gradually: early prediction/warning, then deeper.
    this.activeFault.severityRamp = clamp(this.activeFault.severityRamp + 1, 0, DRIFT_TICKS);
    if (this.activeFault.ticksLeft <= 0) {
      const resolved = this.activeFault;
      this.activeFault = null;
      this.faultCooldown = this.randInt(FAULT_BREAK_MIN, FAULT_BREAK_MAX);
      this.alerts.unshift({
        id: `${this.meta.id}-${this.now()}-${++this._alertSeq}`, // seq: two alerts in one ms must not share an id
        engineId: this.meta.id,
        tail: this.meta.tail,
        severity: 'info',
        message: `${FAULT_TYPES[resolved.type].label} resolved — parameters returning to nominal.`,
        time: new Date(this.now()).toISOString(),
      });
      this.alerts = this.alerts.slice(0, MAX_ALERTS);
    }
    return fault.drift;
  }

  updateSensor(key) {
    const def = SENSORS[key];
    const n = def.nominal;
    const span = n[1] - n[0];
    const center = mid(n);
    const cur = this.state[key];

    // mean-reverting random walk (Ornstein-Uhlenbeck-ish) toward nominal center
    const reversion = (center - cur) * 0.04;
    const noise = this.gauss() * span * 0.018;
    let next = cur + reversion + noise;

    // apply active fault drift: the affected sensor is driven toward a
    // severity-scaled offset from its nominal centre (first-order approach),
    // so a developing fault converges to a bounded deviation instead of an
    // runaway worth of accumulated steps. The order the sensors cross their
    // thresholds therefore tracks a plausible onset: predict -> warn -> harsh.
    if (this.activeFault) {
      const fault = FAULT_TYPES[this.activeFault.type];
      const drift = fault.drift && fault.drift[key];
      if (drift !== undefined) {
        const ramp = this.activeFault.severityRamp / DRIFT_TICKS; // 0..1
        const center = mid(SENSORS[key].nominal);
        const targetOffset = drift * span * (0.25 + 0.75 * ramp);
        next += (center + targetOffset - next) * 0.12;
      }
      // oscillatory signatures (misfire, combustion instability, injector
      // ripple) — a wobble is invisible to a plain trend check but shows up
      // as elevated sample-to-sample jerkiness the jerkiness detector sees.
      if (fault.wobble && fault.wobble[key] !== undefined) {
        next += fault.wobble[key] * Math.sin(this.tick * 0.9);
      }
    }

    next = clamp(next, n[0] - span * 0.9, n[1] + span * 1.4);
    this.state[key] = next;
    return next;
  }

  rollingZScore(key, value) {
    const h = this.history[key];
    h.push(value);
    if (h.length > HISTORY_WINDOW) h.shift();
    const meanV = h.reduce((a, b) => a + b, 0) / h.length;
    const variance = h.reduce((a, b) => a + (b - meanV) ** 2, 0) / h.length;
    const std = Math.sqrt(variance) || 0.0001;
    return Math.abs((value - meanV) / std);
  }

  // Turns the raw (possibly corrupted) sample for one sensor into a trusted
  // value + validity. A missing/NaN/out-of-physical-range sample never reaches
  // the health model: the last good value is held and the sensor is marked
  // 'invalid' (garbage) or, once samples have been missing for
  // STALE_AFTER_TICKS ticks, 'stale' (dropout).
  acquire(key, trueValue) {
    let raw = trueValue;
    const sf = this.sensorFaults[key];
    if (sf) {
      raw = sf.mode === 'nan' ? NaN : sf.mode === 'outOfRange' ? PHYSICAL_RANGE[key][1] * 10 + 1 : undefined;
      if (--sf.ticksLeft <= 0) delete this.sensorFaults[key];
    }
    if (raw === undefined || raw === null) {
      this.missingTicks[key]++;
      return { value: this.lastGood[key], validity: this.missingTicks[key] >= STALE_AFTER_TICKS ? 'stale' : 'ok' };
    }
    this.missingTicks[key] = 0;
    if (!isValidSample(key, raw)) return { value: this.lastGood[key], validity: 'invalid' };
    this.lastGood[key] = raw;
    return { value: raw, validity: 'ok' };
  }

  computeHealthAndPrediction(readings, zscores, statuses = {}) {
    // Rule + anomaly based composite health score (0-100).
    let penalty = 0;
    const flags = [];
    for (const key of Object.keys(SENSORS)) {
      const status = statuses[key] || classify(key, readings[key]);
      if (status === 'critical') { penalty += 22; flags.push({ key, status }); }
      else if (status === 'warning') { penalty += 9; flags.push({ key, status }); }
      // statistical anomaly contribution (z-score based "AI" detector)
      if (zscores[key] > 3.2) penalty += 6;
      else if (zscores[key] > 2.2) penalty += 2.5;
    }
    const health = clamp(Math.round(100 - penalty), 0, 100);

    // Predicted fault mode: whichever fault-type's affected sensors show the
    // strongest combined anomaly/warning signal right now — this is what lets
    // the dashboard "predict" a fault even a tick or two before thresholds
    // are fully crossed.
    let bestType = null, bestScore = 0;
    for (const [type, def] of Object.entries(FAULT_TYPES)) {
      let score = 0;
      for (const s of def.affects) {
        const status = classify(s, readings[s]);
        if (status === 'critical') score += 3;
        else if (status === 'warning') score += 1.4;
        const z = zscores[s];
        // Credit a statistical displacement only when it is actually outside
        // the sensor's own nominal scatter (|z| >= 1.2) AND moving the way
        // this fault signature expects (drift/bias sign). A signature that
        // merely *shares* sensors with another fault (e.g. overheat vs coking
        // both touching CHT/EGT) is not outscored by a sensor that never moved.
        if (Math.abs(z) >= 1.2) {
          const drift = def.drift && def.drift[s];
          const bias = def.bias && def.bias[s];
          const expectFalling = drift !== undefined ? drift < 0 : (bias !== undefined ? bias < 0 : true);
          const center = SENSORS[s] ? mid(SENSORS[s].nominal) : 0.5;
          const falling = readings[s] < center;
          if (expectFalling === falling) score += Math.min(Math.abs(z) / 3, 1.5);
        }
      }
      if (score > bestScore) { bestScore = score; bestType = type; }
    }
    const predictedFault = bestScore >= 1.6 ? {
      type: bestType,
      label: FAULT_TYPES[bestType].label,
      // A soft predictor: cap well below 100% so a prediction alert never reads
      // like a certain verdict — a statistical model is not ground truth.
      confidence: clamp(Math.round((bestScore / 8) * 100), 0, 92),
    } : null;

    // Remaining useful life: degrades faster when health is poor, recovers
    // slowly toward a nominal baseline otherwise — gives a believable trend.
    const target = 200 + health * 3.2;
    this.rul += (target - this.rul) * 0.02;
    this.rul = clamp(this.rul, 0, 900);

    return { health, flags, predictedFault };
  }

  maybeRaiseAlert(readings, prediction, validity = {}) {
    for (const [key, v] of Object.entries(validity)) {
      if (v !== 'ok') {
        this.pushAlert('warning', `${SENSORS[key].label} sensor ${v.toUpperCase()} — reading not trusted, holding last valid value`, `validity:${key}`, VALIDITY_COOLDOWN_MS);
      }
    }
    for (const flag of prediction.flags) {
      if (validity[flag.key] && validity[flag.key] !== 'ok') continue; // reported above, not as a critical engine state
      if (flag.status === 'critical') {
        this.pushAlert(
          'critical',
          `${SENSORS[flag.key].label} in CRITICAL range: ${readings[flag.key].toFixed(1)} ${SENSORS[flag.key].unit}`,
          `critical:${flag.key}`,
          CRITICAL_COOLDOWN_MS,
        );
      }
    }
    if (prediction.predictedFault && prediction.predictedFault.confidence >= 55) {
      this.pushAlert(
        'warning',
        `AI model predicts "${prediction.predictedFault.label}" — confidence ${prediction.predictedFault.confidence}%`,
        `predicted:${prediction.predictedFault.type}`,
        PREDICTED_COOLDOWN_MS,
      );
    }
  }

  // dedupeKey groups alerts that describe the same ongoing condition (e.g.
  // "CHT critical") so a still-critical sensor doesn't spam an identical
  // entry every 2s tick — it re-fires only once the cooldown has elapsed.
  pushAlert(severity, message, dedupeKey, cooldownMs = 15000) {
    if (dedupeKey) {
      this._alertCooldowns = this._alertCooldowns || {};
      const last = this._alertCooldowns[dedupeKey];
      const now = this.now();
      if (last !== undefined && now - last < cooldownMs) return;
      this._alertCooldowns[dedupeKey] = now;
    }
    this.alerts.unshift({
      id: `${this.meta.id}-${this.now()}-${++this._alertSeq}`,
      engineId: this.meta.id,
      tail: this.meta.tail,
      severity,
      message,
      time: new Date(this.now()).toISOString(),
    });
    this.alerts = this.alerts.slice(0, MAX_ALERTS);
  }

  step() {
    this.tick++;
    this.maybeStartFault();
    this.stepFault();

    const readings = {};
    const zscores = {};
    const validity = {};
    const statuses = {};
    const activeBias = this.activeFault ? FAULT_TYPES[this.activeFault.type].bias : null;
    const biasRamp = this.activeFault ? 0.6 + 0.4 * clamp(this.activeFault.severityRamp / DRIFT_TICKS, 0, 1) : 0;
    for (const key of Object.keys(SENSORS)) {
      let truth = this.updateSensor(key);
      // Sensor-drift semantics: bias the acquired reading WITHOUT moving the
      // engine's true state, so this is a transducer error, not a real fault.
      if (activeBias && activeBias[key] !== undefined) {
        truth = clamp(truth + activeBias[key] * biasRamp, PHYSICAL_RANGE[key][0], PHYSICAL_RANGE[key][1]);
      }
      const acquired = this.acquire(key, truth);
      const v = acquired.value;
      readings[key] = v;
      validity[key] = acquired.validity;
      // an untrusted sample must not enter the rolling window (it would skew the z-scores)
      zscores[key] = acquired.validity === 'ok' ? this.rollingZScore(key, v) : 0;
      statuses[key] = classify(key, v);
      if (acquired.validity !== 'ok' && statuses[key] === 'nominal') statuses[key] = 'warning'; // never silently nominal
      const s = this.series[key];
      s.push(v);
      if (s.length > TIMESERIES_LEN) s.shift();
    }

    // flight profile drifts gently too
    this.altitude = clamp(this.altitude + this.gauss() * 25, 2500, 7500);
    this.airspeed = clamp(this.airspeed + this.gauss() * 2.2, 90, 200);
    this.hoursFlown += 2 / 3600; // ~2s tick

    // Fatigue-RUL: advance all part damage deterministically from this tick's
    // readings, then fold the report into the analytics result below.
    advanceFatigue(this.fatigue, readings, { dtSeconds: 2, hoursFlown: this.hoursFlown });

    const prediction = this.computeHealthAndPrediction(readings, zscores, statuses);
    this.healthScore = prediction.health;
    this.maybeRaiseAlert(readings, prediction, validity);

    const analyticsResult = this.computeAdvancedAnalytics(readings);

    return {
      id: this.meta.id,
      tail: this.meta.tail,
      engine: this.meta.engine,
      time: new Date(this.now()).toISOString(),
      readings: Object.fromEntries(Object.entries(readings).map(([k, v]) => [k, Number(v.toFixed(2))])),
      statuses,
      // additive: per-sensor 'ok' | 'invalid' | 'stale'. Kept out of `statuses` so existing
      // consumers (which only know nominal/warning/critical) never see an unknown value.
      validity,
      altitude: Math.round(this.altitude),
      airspeed: Math.round(this.airspeed),
      hoursFlown: Number(this.hoursFlown.toFixed(2)),
      health: this.healthScore,
      rul: Math.round(this.rul),
      activeFault: this.activeFault ? { type: this.activeFault.type, label: FAULT_TYPES[this.activeFault.type].label } : null,
      predictedFault: prediction.predictedFault,
      alerts: this.alerts.slice(0, 8),
      analytics: analyticsResult,
    };
  }

  // Rate-aware health index + multivariate anomaly detection + RUL +
  // explainability, layered on top of the simpler rule/z-score model above.
  // The anomaly detector warms up on a rolling buffer of samples taken while
  // the engine looks healthy (no active fault, high legacy health score) —
  // fitting it on live "healthy" telemetry the same way a real deployment
  // would calibrate against a known-good baseline before trusting deviations.
  computeAdvancedAnalytics(readings) {
    const looksHealthy = !this.activeFault && this.healthScore >= 90;
    if (!this.anomalyDetector.fitted) {
      if (looksHealthy) {
        this.warmupSamples.push({ ...readings });
        if (this.warmupSamples.length > WARMUP_MAX) this.warmupSamples.shift();
        if (this.warmupSamples.length >= 20) this.anomalyDetector.fit(this.warmupSamples);
      }
    } else if (looksHealthy) {
      this.anomalyDetector.adapt(readings, 0.01);
    }

    const healthIndex = computeHealthIndex(this.history);
    const anomaly = this.anomalyDetector.fitted
      ? this.anomalyDetector.score(readings)
      : { score: 0, contributions: [] };

    this.healthScoreHistory.push(healthIndex.healthScore);
    if (this.healthScoreHistory.length > ANALYTICS_HISTORY_LEN) this.healthScoreHistory.shift();
    this.anomalyScoreHistory.push(anomaly.score);
    if (this.anomalyScoreHistory.length > ANALYTICS_HISTORY_LEN) this.anomalyScoreHistory.shift();

    const rulFeatures = deriveRulFeatures(this.healthScoreHistory, this.anomalyScoreHistory);
    const rul = estimateRUL(rulFeatures);
    const explanation = explain({ contributions: anomaly.contributions, flags: healthIndex.flags });
    const recommendation = recommend({ flags: healthIndex.flags, rul });
    const fatigue = fatigueReport(this.fatigue, {});

    return {
      healthScore: healthIndex.healthScore,
      flags: healthIndex.flags,
      trends: healthIndex.trends,
      anomalyScore: Number.isFinite(anomaly.score) ? Number(anomaly.score.toFixed(2)) : 0,
      anomalyDetectorFitted: this.anomalyDetector.fitted,
      rul,
      fatigue,
      explanation,
      recommendation,
    };
  }

  snapshotSeries() {
    // copies: callers must not be able to mutate (or hold a live view of) the ring buffers
    return Object.fromEntries(Object.entries(this.series).map(([k, v]) => [k, v.slice()]));
  }
}

class DigitalTwinFleet {
  // options.seed: deterministic run (per-engine streams derived from it);
  // options.clock: () => epoch-ms for timestamps/alert cooldowns;
  // options.fleet: alternative [{ id, tail, engine }] list. All optional.
  constructor(options = {}) {
    const { seed, clock, fleet } = options || {};
    this.now = typeof clock === 'function' ? clock : Date.now;
    this.engines = (Array.isArray(fleet) && fleet.length ? fleet : FLEET).map((meta) => new EngineTwin(meta, {
      rng: seed === undefined || seed === null ? undefined : createRng(`${seed}:${meta.id}`),
      clock,
    }));
  }

  engine(engineId) {
    return this.engines.find((e) => e.meta.id === engineId) || null;
  }

  step() {
    const results = this.engines.map((e) => e.step());
    const avgHealth = results.length ? Math.round(results.reduce((a, r) => a + r.health, 0) / results.length) : 0;
    const criticalCount = results.filter((r) => Object.values(r.statuses).includes('critical')).length;
    const missionReliability = clamp(Math.round(avgHealth - criticalCount * 8), 0, 100);
    return {
      time: new Date(this.now()).toISOString(),
      engines: results,
      fleet: {
        avgHealth,
        missionReliability,
        criticalCount,
        engineCount: results.length,
      },
    };
  }

  allAlerts(limit = 30) {
    const n = Number.isFinite(limit) ? Math.max(0, Math.min(500, Math.floor(limit))) : 30;
    return this.engines
      .flatMap((e) => e.alerts)
      .sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0))
      .slice(0, n);
  }

  series(engineId) {
    const eng = this.engine(engineId);
    return eng ? eng.snapshotSeries() : null;
  }

  // Test/demo hooks (additive): force a fault scenario / a sensor failure on one engine.
  injectFault(engineId, type, ticks) {
    const eng = this.engine(engineId);
    if (!eng) throw new RangeError(`unknown engine "${engineId}"`);
    eng.forceFault(type, ticks);
  }

  injectSensorFault(engineId, key, mode, ticks) {
    const eng = this.engine(engineId);
    if (!eng) throw new RangeError(`unknown engine "${engineId}"`);
    eng.injectSensorFault(key, mode, ticks);
  }
}

module.exports = { DigitalTwinFleet, EngineTwin, SENSORS, FAULT_TYPES, FLEET, PHYSICAL_RANGE };
