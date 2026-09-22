/**
 * Parametrized fault-injection layer applied on top of the clean physics
 * output. Each fault type ramps up from an onset time, holds/varies at
 * peak severity, and optionally recovers — the ramp/onset/duration are
 * randomized per instance so injected faults don't look artificially
 * "clean" to the downstream anomaly-detection/RUL models. Multiple faults
 * may be scheduled concurrently.
 *
 * Fault types mirror simulator.js's FAULT_TYPES so this module can either
 * replace or cross-check that logic once wired in.
 */

'use strict';

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function severityAt(schedule, t) {
  if (!schedule || !Number.isFinite(t)) return 0;
  const { onset, rampS, holdS, recoveryS } = schedule;
  // A malformed schedule (NaN/negative fields) yields "no fault" rather than NaN.
  if (![onset, rampS, holdS].every(Number.isFinite) || rampS < 0 || holdS < 0) return 0;
  const peak = clamp01(Number.isFinite(schedule.peak) ? schedule.peak : 0);
  if (t < onset) return 0;
  const sinceOnset = t - onset;
  if (sinceOnset < rampS) return peak * (sinceOnset / rampS);
  if (sinceOnset < rampS + holdS) return peak;
  if (!(recoveryS > 0)) return peak;
  const sinceRecoveryStart = sinceOnset - rampS - holdS;
  if (sinceRecoveryStart < recoveryS) return peak * (1 - sinceRecoveryStart / recoveryS);
  return 0;
}

function randomSchedule(rng, opts = {}) {
  const rand = rng || Math.random;
  return {
    onset: opts.onset ?? rand() * 600 + 60,
    rampS: opts.rampS ?? rand() * 300 + 60,
    holdS: opts.holdS ?? rand() * 900 + 300,
    recoveryS: opts.recoveryS ?? (rand() < 0.5 ? rand() * 400 + 100 : 0),
    peak: opts.peak ?? clamp01(rand() * 0.7 + 0.3),
  };
}

/**
 * Each applicator receives the clean reading, the fault's current severity
 * (0..1) and elapsed mission time, and returns a partial patch of
 * sensor-key overrides/deltas to merge onto the reading.
 */
const FAULT_APPLICATORS = {
  overheat(reading, severity) {
    return {
      cht: reading.cht + severity * 42,
      egt: reading.egt + severity * 65,
      oilTemp: reading.oilTemp + severity * 22,
    };
  },

  oilLoss(reading, severity) {
    return {
      oilPressure: reading.oilPressure * (1 - severity * 0.62),
      oilTemp: reading.oilTemp + severity * 18,
      vibration: reading.vibration + severity * 0.6,
    };
  },

  vibration(reading, severity, t) {
    // Exponential-ish RMS growth with a beat pattern typical of imbalance/bearing wear.
    const beat = 1 + 0.25 * Math.sin(t / 1.3);
    return {
      vibration: reading.vibration + (Math.pow(severity, 1.6) * 3.2) * beat,
      rpm: reading.rpm - severity * 90,
    };
  },

  fuelStarvation(reading, severity, t) {
    // Intermittent misfire-style torque/RPM dropout layered on top of a baseline lean drift.
    const misfireSpike = severity > 0.35 && Math.sin(t * 1.7) > 0.9 ? severity * 220 : 0;
    return {
      fuelFlow: reading.fuelFlow * (1 - severity * 0.5),
      rpm: reading.rpm - severity * 140 - misfireSpike,
      manifoldPressureKPa: reading.manifoldPressureKPa * (1 - severity * 0.18),
    };
  },

  // ---- Fault families required by the master plan's 8-category taxonomy, -----
  // previously missing: sensor drift/failure, cooling/coking degradation,
  // injector abnormality, misfire and combustion instability.

  sensorDrift(reading, severity) {
    // Transducer failure semantics: the physical engine is untouched and a
    // SINGLE signal drifts, so the reading does not correlate with the other
    // sensors the way a real fault would. batteryVoltage has no correlation
    // partner in the fault set, which keeps this misattribution deliberately
    // clean — exactly the failure mode single-sensor thresholds mishandle.
    return { batteryVoltage: reading.batteryVoltage - severity * 1.7 };
  },

  coking(reading, severity) {
    // Episodic proxy for a cooling/coking degradation episode (blocked
    // cooling airflow / accumulated deposits): heat rejection degrades.
    return {
      cht: reading.cht + severity * 32,
      egt: reading.egt + severity * 40,
      oilTemp: reading.oilTemp + severity * 14,
      manifoldPressureKPa: reading.manifoldPressureKPa * (1 - severity * 0.12),
      rpm: reading.rpm - severity * 70,
    };
  },

  injectorAbnormality(reading, severity, t) {
    // One injector over-fuels and one goes lean — per-cylinder fuel-trim
    // divergence plus a lean lambda wander and a pulse-width anomaly.
    const n = Array.isArray(reading.perCylinderFuelTrim) ? reading.perCylinderFuelTrim.length : 6;
    const idx = Math.abs(Math.floor(t)) % n;
    const trim = Array.isArray(reading.perCylinderFuelTrim)
      ? reading.perCylinderFuelTrim.slice()
      : Array(n).fill(1);
    trim[idx] = Math.min(1.6, trim[idx] + severity * 0.5);
    trim[(idx + 1) % n] = Math.max(0.4, trim[(idx + 1) % n] - severity * 0.45);
    return {
      // λ swings lean as a cylinder runs out of fuel; another runs rich.
      lambda: reading.lambda * (1 + severity * 0.07),
      injectorPulseWidth: reading.injectorPulseWidth * (1 + severity * 0.16),
      fuelFlow: reading.fuelFlow * (1 + severity * 0.12),
      rpm: reading.rpm - severity * 55,
      perCylinderFuelTrim: trim,
      vibration: reading.vibration + severity * 0.3,
    };
  },

  misfire(reading, severity, t) {
    // Intermittent missed combustion events: torque/RPM ripples, EGT jitter
    // in step with RPM, λ momentarily rich as unburned fuel fires late.
    const misfiring = Math.sin(t * 3.1) > 0.82;
    const jolt = misfiring ? severity * 190 : 0;
    return {
      rpm: reading.rpm - severity * 120 - jolt,
      egt: reading.egt - severity * 28 + (misfiring ? severity * 45 : 0),
      lambda: reading.lambda * (1 + severity * 0.04),
      vibration: reading.vibration + severity * 1.3,
    };
  },

  combustionInstability(reading, severity, t) {
    // Oscillating knock/misfire-adjacent instability: λ and torque ripple
    // around a rising-average mean rather than a one-directional drift.
    const osc = Math.sin(t * 0.9);
    return {
      rpm: reading.rpm - severity * 55 + severity * 95 * osc,
      egt: reading.egt + severity * 18 + severity * 38 * osc,
      lambda: reading.lambda * (1 + severity * 0.09 * osc),
      manifoldPressureKPa: reading.manifoldPressureKPa * (1 + severity * 0.08 * osc),
      vibration: reading.vibration + severity * 0.9,
    };
  },
};

function createFaultSchedule(types, rng) {
  return types.map((type) => ({ type, schedule: randomSchedule(rng) }));
}

/** Returns { [faultType]: severity } for the given active schedule at time t. */
function computeSeverities(activeSchedule, t) {
  const out = {};
  for (const { type, schedule } of activeSchedule) {
    out[type] = severityAt(schedule, t);
  }
  return out;
}

/** Applies all active faults' perturbations to a clean reading, returning the perturbed reading. */
function applyFaults(cleanReading, severities, t = 0) {
  const reading = { ...cleanReading };
  for (const [type, severity] of Object.entries(severities)) {
    if (!(severity > 0)) continue; // also skips NaN
    const applicator = FAULT_APPLICATORS[type];
    if (!applicator) continue;
    const patch = applicator(reading, severity, t);
    for (const [k, v] of Object.entries(patch)) {
      // Accept scalar numbers and array patches (e.g. per-cylinder fuel trim);
      // ignore a non-finite scalar, keep the clean value.
      const ok = Array.isArray(v) ? v.every(Number.isFinite) : Number.isFinite(v);
      if (ok) reading[k] = v;
    }
  }
  return reading;
}

module.exports = {
  FAULT_APPLICATORS,
  createFaultSchedule,
  randomSchedule,
  severityAt,
  computeSeverities,
  applyFaults,
};
