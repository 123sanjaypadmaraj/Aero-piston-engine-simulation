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
};

const FAULT_TYPES = {
  overheat: {
    label: 'Thermal Overload (CHT/EGT Rising)',
    affects: ['cht', 'egt', 'oilTemp'],
    drift: { cht: 0.9, egt: 1.6, oilTemp: 0.45 },
  },
  oilLoss: {
    label: 'Oil Pressure Loss',
    affects: ['oilPressure', 'oilTemp', 'vibration'],
    drift: { oilPressure: -0.55, oilTemp: 0.3, vibration: 0.03 },
  },
  vibration: {
    label: 'Mechanical Imbalance / Vibration Anomaly',
    affects: ['vibration', 'rpm'],
    drift: { vibration: 0.16, rpm: -6 },
  },
  fuelStarvation: {
    label: 'Fuel System Degradation',
    affects: ['fuelFlow', 'rpm', 'manifoldPressure'],
    drift: { fuelFlow: -0.22, rpm: -12, manifoldPressure: -0.6 },
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
    this.faultCooldown = this.randInt(15, 35); // ticks until a fault may start
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
    // 12% chance per eligible tick to start a fault scenario
    if (this.rng() < 0.12) {
      const keys = Object.keys(FAULT_TYPES);
      const type = keys[this.randInt(0, keys.length - 1)];
      this.activeFault = {
        type,
        ticksLeft: this.randInt(18, 40),
        severityRamp: 0,
      };
    } else {
      this.faultCooldown = this.randInt(4, 10);
    }
  }

  stepFault() {
    if (!this.activeFault) return {};
    const fault = FAULT_TYPES[this.activeFault.type];
    this.activeFault.ticksLeft--;
    this.activeFault.severityRamp = clamp(this.activeFault.severityRamp + 1, 0, 24);
    if (this.activeFault.ticksLeft <= 0) {
      const resolved = this.activeFault;
      this.activeFault = null;
      this.faultCooldown = this.randInt(25, 60);
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

    // apply active fault drift, scaled by how far into the fault we are
    if (this.activeFault) {
      const fault = FAULT_TYPES[this.activeFault.type];
      const drift = fault.drift[key];
      if (drift !== undefined) {
        const ramp = this.activeFault.severityRamp / 24;
        next += drift * span * 0.03 * (0.4 + ramp);
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
        score += status === 'critical' ? 3 : status === 'warning' ? 1.4 : 0;
        score += Math.min(zscores[s] / 3, 1.5);
      }
      if (score > bestScore) { bestScore = score; bestType = type; }
    }
    const predictedFault = bestScore >= 1.6 ? {
      type: bestType,
      label: FAULT_TYPES[bestType].label,
      confidence: clamp(Math.round((bestScore / 8) * 100), 0, 99),
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
        this.pushAlert('warning', `${SENSORS[key].label} sensor ${v.toUpperCase()} — reading not trusted, holding last valid value`, `validity:${key}`);
      }
    }
    for (const flag of prediction.flags) {
      if (validity[flag.key] && validity[flag.key] !== 'ok') continue; // reported above, not as a critical engine state
      if (flag.status === 'critical') {
        this.pushAlert(
          'critical',
          `${SENSORS[flag.key].label} in CRITICAL range: ${readings[flag.key].toFixed(1)} ${SENSORS[flag.key].unit}`,
          `critical:${flag.key}`,
        );
      }
    }
    if (prediction.predictedFault && prediction.predictedFault.confidence >= 55) {
      this.pushAlert(
        'warning',
        `AI model predicts "${prediction.predictedFault.label}" — confidence ${prediction.predictedFault.confidence}%`,
        `predicted:${prediction.predictedFault.type}`,
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
    for (const key of Object.keys(SENSORS)) {
      const truth = this.updateSensor(key);
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

    return {
      healthScore: healthIndex.healthScore,
      flags: healthIndex.flags,
      trends: healthIndex.trends,
      anomalyScore: Number.isFinite(anomaly.score) ? Number(anomaly.score.toFixed(2)) : 0,
      anomalyDetectorFitted: this.anomalyDetector.fitted,
      rul,
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
