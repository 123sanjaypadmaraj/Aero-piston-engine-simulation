/**
 * trendForecast.js
 * -----------------------------------------------------------------------
 * Linear extrapolation of the latest sensor trend to the warn/critical
 * thresholds, plus a combined End-of-Life projection. This is the "early
 * warning / remaining time until threshold" layer the dashboard shows next
 * to the point-in-time RUL estimate.
 *
 * Input is the same raw per-sensor numeric history the rest of the analytics
 * layer consumes; thresholds are taken from SENSOR_DEFS (healthIndex.js) and
 * are overridable per call. All projections are expressed in flight hours
 * (based on a supplied samples-per-hour rate, default = the 2s tick cadence
 * of this twin). Non-finite values are ignored; a sensor with no usable
 * trend is reported as `projectable: false` rather than fabricated.
 * -----------------------------------------------------------------------
 */

'use strict';

const { slope, finiteOnly, clamp } = require('./mathUtils');
const { SENSOR_DEFS } = require('./healthIndex');

const DEFAULT_SAMPLES_PER_HOUR = 1800; // 2s tick
const DEFAULT_WINDOW = 30; // samples used for the linear trend
const MAX_HORIZON_HOURS = 5000;

// Least-squares fit of hours-vs-health forecast for a health-index history:
// hours until the current trajectory crosses the `floor` health value.
function hoursToHealthFloor(healthHistory, samplesPerHour, floor = 0, window = DEFAULT_WINDOW) {
  const h = finiteOnly(healthHistory).slice(-window);
  if (h.length < 5) return null;
  const s = slope(h); // delta per sample
  if (s >= -1e-9) return null; // flat or improving: no EOL from this signal alone
  const last = h[h.length - 1];
  const hours = (last - floor) / (-s) / samplesPerHour;
  return Number.isFinite(hours) ? clamp(hours, 0, MAX_HORIZON_HOURS) : null;
}

/**
 * Forecast one sensor.
 * @param {string} sensor
 * @param {number[]} history - per-sample history of that sensor
 * @param {Object} [opts]
 * @param {number} [opts.samplesPerHour]
 * @param {number} [opts.window]
 * @param {Array} [opts.bands] - override [warn, crit] pair (null disables that band)
 * @returns {Object}
 */
function forecastSensor(sensor, history, opts = {}) {
  const samplesPerHour = Number.isFinite(opts.samplesPerHour) && opts.samplesPerHour > 0
    ? opts.samplesPerHour : DEFAULT_SAMPLES_PER_HOUR;
  const window = Number.isInteger(opts.window) && opts.window > 3 ? opts.window : DEFAULT_WINDOW;
  const def = SENSOR_DEFS[sensor];
  const h = finiteOnly(history).slice(-window);
  const out = {
    sensor,
    projectable: false,
    direction: null,
    slope: 0,
    last: h.length ? h[h.length - 1] : null,
  };
  if (h.length < 5) return out;

  const s = slope(h);
  out.slope = s;
  if (Math.abs(s) < 1e-9) return out;
  out.direction = s > 0 ? 'rising' : 'falling';

  if (def) {
    const bands = Array.isArray(opts.bands) ? opts.bands : (s > 0 ? [def.highWarn, def.highCrit] : [def.lowWarn, def.lowCrit]);
    out.warn = bands[0];
    out.crit = bands[1];
    const last = h[h.length - 1];
    const perHour = s * samplesPerHour;
    const target = (t) => (t !== undefined && Number.isFinite(t) ? (t - last) / perHour : null);
    out.hoursToWarn = target(out.warn);
    out.hoursToCrit = target(out.crit);
    if (out.hoursToWarn !== null) out.hoursToWarn = clamp(out.hoursToWarn, 0, MAX_HORIZON_HOURS);
    if (out.hoursToCrit !== null) out.hoursToCrit = clamp(out.hoursToCrit, 0, MAX_HORIZON_HOURS);
    out.projectable = out.hoursToCrit !== null || out.hoursToWarn !== null;
  }
  return out;
}

/**
 * Combined fleet/engine projection: earliest threshold breach plus a summary
 * of every widening trend.
 * @param {Object<string, number[]>} historyBySensor
 * @param {Object} [opts]
 * @returns {{ horizonHours, eolHours, healthEolHours, sensors: Object[] }}
 */
function forecastEngine(historyBySensor, opts = {}) {
  const sensors = Object.entries(historyBySensor || {})
    .filter(([k]) => SENSOR_DEFS[k])
    .map(([k, h]) => forecastSensor(k, h, opts))
    .filter((f) => f.projectable);

  const critHours = sensors
    .map((f) => (f.hoursToCrit !== null ? f.hoursToCrit : Infinity))
    .filter((v) => Number.isFinite(v));

  const healthEolHours = hoursToHealthFloor(opts.healthHistory, opts.samplesPerHour, opts.healthFloor || 0, opts.window);

  const eolHours = critHours.length
    ? Math.min(...critHours)
    : healthEolHours !== null && healthEolHours < MAX_HORIZON_HOURS ? healthEolHours : null;

  return {
    horizonHours: opts.horizonHours !== undefined ? opts.horizonHours : 500,
    eolHours,
    healthEolHours,
    sensors,
  };
}

module.exports = { forecastSensor, forecastEngine, hoursToHealthFloor, DEFAULT_SAMPLES_PER_HOUR };