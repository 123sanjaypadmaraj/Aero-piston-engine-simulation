/**
 * Mission profile library: each profile is a pure function of elapsed
 * mission time (seconds) returning throttle (0..1) and a target altitude
 * (m) for the environment model. Profiles loop (wrap on duration) so a demo
 * can run indefinitely.
 */

'use strict';

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function lerp(a, b, f) { return a + (b - a) * clamp01(f); }

function climbCruiseDescent(t) {
  const duration = 3600;
  const p = t % duration;
  if (p < 480) return { throttle: lerp(0.45, 0.92, p / 480), targetAltitude: lerp(300, 3500, p / 480) };
  if (p < 2900) return { throttle: 0.68 + 0.04 * Math.sin(p / 90), targetAltitude: 3500 };
  return { throttle: lerp(0.65, 0.28, (p - 2900) / (duration - 2900)), targetAltitude: lerp(3500, 400, (p - 2900) / (duration - 2900)) };
}

function highAltitudeLongEndurance(t) {
  const duration = 7200;
  const p = t % duration;
  if (p < 900) return { throttle: lerp(0.5, 0.95, p / 900), targetAltitude: lerp(300, 6500, p / 900) };
  if (p < 6600) return { throttle: 0.72 + 0.03 * Math.sin(p / 140), targetAltitude: 6500 };
  return { throttle: lerp(0.7, 0.3, (p - 6600) / (duration - 6600)), targetAltitude: lerp(6500, 500, (p - 6600) / (duration - 6600)) };
}

function hotWeather(t) {
  const duration = 3600;
  const p = t % duration;
  if (p < 400) return { throttle: lerp(0.45, 0.85, p / 400), targetAltitude: lerp(300, 2800, p / 400) };
  if (p < 3200) return { throttle: 0.75 + 0.04 * Math.sin(p / 100), targetAltitude: 2800 };
  return { throttle: lerp(0.7, 0.3, (p - 3200) / (duration - 3200)), targetAltitude: lerp(2800, 400, (p - 3200) / (duration - 3200)) };
}

function rapidThrottleTransients(t) {
  const duration = 1800;
  const p = t % duration;
  const throttle = clamp01(0.6 + 0.32 * Math.sin(p / 9) + 0.08 * Math.sin(p / 2.3));
  return { throttle, targetAltitude: 2000 + 150 * Math.sin(p / 45) };
}

const MISSIONS = {
  climbCruiseDescent: { name: 'Climb / Cruise / Descent', durationS: 3600, ambientTempOffsetC: 0, control: climbCruiseDescent },
  highAltitudeLongEndurance: { name: 'High-Altitude Long Endurance', durationS: 7200, ambientTempOffsetC: 0, control: highAltitudeLongEndurance },
  hotWeather: { name: 'Hot-Weather Ops', durationS: 3600, ambientTempOffsetC: 22, control: hotWeather },
  rapidThrottleTransients: { name: 'Rapid Throttle Transients', durationS: 1800, ambientTempOffsetC: 0, control: rapidThrottleTransients },
};

module.exports = { MISSIONS };
