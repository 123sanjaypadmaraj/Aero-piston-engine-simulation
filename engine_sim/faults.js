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
      if (Number.isFinite(v)) reading[k] = v; // ignore a non-finite override, keep the clean value
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
