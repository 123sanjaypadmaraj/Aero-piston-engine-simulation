/**
 * healthIndex.js
 * -----------------------------------------------------------------------
 * Rate-of-change-aware rule-based health index. simulator.js already scores
 * sensors against static thresholds plus a per-sensor rolling z-score; this
 * module adds the piece that catches trouble *before* a threshold is
 * crossed — a trend/slope check per sensor — and maps whatever it finds
 * onto the eight-category fault taxonomy from the master plan (misfire,
 * injector abnormality, cooling/coking degradation, lubrication issues,
 * sensor drift/failure, combustion instability, overheating trend,
 * abnormal vibration pattern).
 * -----------------------------------------------------------------------
 */

'use strict';

const { std, slope, jerkiness, clamp, finiteOnly } = require('./mathUtils');

// Same nominal/warn/crit bands as simulator.js's SENSORS table, duplicated
// here so this module has no hard dependency on the simulator's internals
// and can be pointed at a different fleet/engine model later.
const SENSOR_DEFS = {
  rpm: { unit: 'RPM', nominal: [4600, 5600], lowWarn: 4200, lowCrit: 3800, highWarn: 5800, highCrit: 6100 },
  cht: { unit: '°C', nominal: [90, 145], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 145, highCrit: 168 },
  egt: { unit: '°C', nominal: [650, 760], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 760, highCrit: 800 },
  oilPressure: { unit: 'psi', nominal: [45, 62], lowWarn: 45, lowCrit: 30, highWarn: Infinity, highCrit: Infinity },
  oilTemp: { unit: '°C', nominal: [80, 108], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 108, highCrit: 125 },
  fuelFlow: { unit: 'L/h', nominal: [12, 18], lowWarn: 12, lowCrit: 8, highWarn: Infinity, highCrit: Infinity },
  vibration: { unit: 'mm/s', nominal: [0.4, 2.4], lowWarn: -Infinity, lowCrit: -Infinity, highWarn: 2.4, highCrit: 4.2 },
  manifoldPressure: { unit: 'kPa', nominal: [88, 106], lowWarn: 88, lowCrit: 78, highWarn: Infinity, highCrit: Infinity },
  batteryVoltage: { unit: 'V', nominal: [12.6, 14.6], lowWarn: 12.6, lowCrit: 11.8, highWarn: Infinity, highCrit: Infinity },
};

// Which taxonomy categories a given sensor's *sustained trend* can imply,
// keyed by trend direction ('rising' | 'falling'). A sensor may map to more
// than one category — the trend evidence string disambiguates for a human.
const TREND_CATEGORY_MAP = {
  cht: { rising: ['overheating_trend', 'cooling_coking_degradation'] },
  egt: { rising: ['overheating_trend', 'combustion_instability'] },
  oilTemp: { rising: ['lubrication_issues', 'overheating_trend'] },
  oilPressure: { falling: ['lubrication_issues'] },
  fuelFlow: { falling: ['injector_abnormality'] },
  manifoldPressure: { falling: ['injector_abnormality', 'combustion_instability'] },
  vibration: { rising: ['abnormal_vibration_pattern'] },
  rpm: { rising: ['combustion_instability'], falling: ['combustion_instability'] },
  batteryVoltage: { falling: ['sensor_drift_failure'] },
};

// A non-finite reading compares false against every threshold, which would
// silently read as "nominal" — report it as 'invalid' instead (fail-safe).
function classify(key, value) {
  const def = SENSOR_DEFS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'invalid';
  if (value <= def.lowCrit || value >= def.highCrit) return 'critical';
  if (value <= def.lowWarn || value >= def.highWarn) return 'warning';
  return 'nominal';
}

// Distance (in units of the sensor's own nominal span) from `value` to the
// nearest bad-side threshold in the given direction — used to decide
// whether a trend is worth flagging ("still nominal but closing in fast")
// versus harmless noise.
function marginToThreshold(key, value, direction) {
  const def = SENSOR_DEFS[key];
  const span = def.nominal[1] - def.nominal[0] || 1;
  if (direction === 'rising') {
    const target = Number.isFinite(def.highWarn) ? def.highWarn : def.nominal[1];
    return (target - value) / span;
  }
  const target = Number.isFinite(def.lowWarn) ? def.lowWarn : def.nominal[0];
  return (value - target) / span;
}

// A sensor that reads back an implausibly flat, repeated, or discontinuous
// signal is more likely a failed/drifting transducer than a real physical
// fault — flag it under sensor_drift_failure regardless of which physical
// category its value would otherwise suggest.
function detectSensorFault(key, history) {
  if (history.length < 8) return null;
  const recent = history.slice(-8);
  const spread = Math.max(...recent) - Math.min(...recent);
  const def = SENSOR_DEFS[key];
  const span = def.nominal[1] - def.nominal[0] || 1;
  if (spread < span * 0.0005) {
    return { category: 'sensor_drift_failure', severity: 'watch', evidence: `${key} reading has been flat for ${recent.length} samples (possible stuck sensor)` };
  }
  const j = jerkiness(recent);
  const overallJ = jerkiness(history);
  if (overallJ > 0 && j > overallJ * 6) {
    return { category: 'sensor_drift_failure', severity: 'warning', evidence: `${key} shows a discontinuous jump inconsistent with normal dynamics` };
  }
  return null;
}

// Misfire shows up as high sample-to-sample jerkiness in rpm/egt without a
// matching sustained trend — a smoothly rising EGT is overheating, a
// jittery one (with rpm jittering in step) is a misfire signature.
function detectMisfire(historyBySensor) {
  const rpmHist = finiteOnly(historyBySensor.rpm);
  const egtHist = finiteOnly(historyBySensor.egt);
  if (rpmHist.length < 10 || egtHist.length < 10) return null;
  const rpmJ = jerkiness(rpmHist.slice(-10));
  const rpmBaseline = std(rpmHist.slice(0, -10).length ? rpmHist.slice(0, -10) : rpmHist);
  const egtJ = jerkiness(egtHist.slice(-10));
  const egtBaseline = std(egtHist.slice(0, -10).length ? egtHist.slice(0, -10) : egtHist);
  const rpmSpike = rpmBaseline > 0 && rpmJ > rpmBaseline * 1.8;
  const egtSpike = egtBaseline > 0 && egtJ > egtBaseline * 1.8;
  if (rpmSpike && egtSpike) {
    return { category: 'misfire', severity: 'warning', evidence: `rpm and egt both show elevated cycle-to-cycle jitter (rpm jerk ${rpmJ.toFixed(1)} vs baseline ${rpmBaseline.toFixed(1)})` };
  }
  return null;
}

const TREND_WINDOW = 12;
const SLOPE_SIGNIFICANCE = 0.015; // fraction of nominal span per sample

/**
 * @param {Object<string, number[]>} historyBySensor - rolling raw-value
 *   history per sensor key (oldest first), e.g. simulator.js's `this.history`.
 * @returns {{ healthScore: number, flags: Array, trends: Object }}
 */
function computeHealthIndex(historyBySensor) {
  let penalty = 0;
  const flags = [];
  const trends = {};

  if (!historyBySensor || typeof historyBySensor !== 'object') historyBySensor = {};

  for (const key of Object.keys(SENSOR_DEFS)) {
    const rawHist = historyBySensor[key];
    if (!Array.isArray(rawHist) || !rawHist.length) continue;
    const value = rawHist[rawHist.length - 1];
    if (classify(key, value) === 'invalid') {
      // Latest sample is NaN/Infinity/non-numeric: no trend or threshold maths is
      // meaningful, so surface it as a sensor fault instead of scoring it nominal.
      flags.push({ category: 'sensor_drift_failure', sensor: key, severity: 'warning', evidence: `${key} latest reading is invalid (${String(value)})` });
      penalty += 9;
      continue;
    }
    const hist = finiteOnly(rawHist); // drop any invalid samples earlier in the window
    const status = classify(key, value);
    if (status === 'critical') penalty += 22;
    else if (status === 'warning') penalty += 9;

    const window = hist.slice(-TREND_WINDOW);
    const def = SENSOR_DEFS[key];
    const span = def.nominal[1] - def.nominal[0] || 1;
    const sl = window.length >= 4 ? slope(window) : 0;
    const normalizedSlope = sl / span;
    const direction = normalizedSlope > 0 ? 'rising' : normalizedSlope < 0 ? 'falling' : null;
    trends[key] = { slope: sl, normalizedSlope, direction };

    if (status === 'nominal' && direction && Math.abs(normalizedSlope) >= SLOPE_SIGNIFICANCE) {
      const margin = marginToThreshold(key, value, direction);
      if (margin < 6) { // still nominal, but closing on the threshold within ~6 window-spans at this rate
        const categories = (TREND_CATEGORY_MAP[key] || {})[direction] || [];
        for (const category of categories) {
          const severity = margin < 2 ? 'warning' : 'watch';
          flags.push({
            category,
            sensor: key,
            severity,
            evidence: `${key} ${direction} at ${sl.toFixed(3)} ${def.unit}/sample over last ${window.length} samples, still nominal but closing on threshold`,
          });
          penalty += severity === 'warning' ? 5 : 2;
        }
      }
    } else if (status !== 'nominal') {
      const categories = [...new Set([...(TREND_CATEGORY_MAP[key]?.rising || []), ...(TREND_CATEGORY_MAP[key]?.falling || [])])];
      const relevant = direction ? (TREND_CATEGORY_MAP[key]?.[direction] || categories) : categories;
      for (const category of relevant) {
        flags.push({ category, sensor: key, severity: status, evidence: `${key}=${value.toFixed(1)}${def.unit} is ${status} (nominal band ${def.nominal[0]}-${def.nominal[1]}${def.unit})` });
      }
    }

    const sensorFault = detectSensorFault(key, hist);
    if (sensorFault) { flags.push({ ...sensorFault, sensor: key }); penalty += sensorFault.severity === 'warning' ? 5 : 2; }
  }

  const misfire = detectMisfire(historyBySensor);
  if (misfire) { flags.push({ ...misfire, sensor: 'rpm+egt' }); penalty += 5; }

  const healthScore = clamp(Math.round(100 - penalty), 0, 100);
  return { healthScore, flags, trends };
}

module.exports = { computeHealthIndex, classify, SENSOR_DEFS, TREND_CATEGORY_MAP };
