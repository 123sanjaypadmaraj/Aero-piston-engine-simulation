/**
 * replay/missionRunner.js
 * -----------------------------------------------------------------------
 * Drives a full simulated mission end-to-end and records every reading via
 * twin_core/store, producing a dataset that replay/replayEngine.js (or an
 * ML training script) can play back later.
 *
 * Deliberately decoupled from engine_sim: callers inject `profileFn` (mission
 * control-input schedule) and `stepFn` (the physics/telemetry step), so this
 * module has no compile-time dependency on engine_sim's module shape.
 *
 * Assumed collaborator shapes (coordinate with engine_sim / simulator.js):
 *   profileFn(elapsedSeconds) -> controlInputs   e.g. { throttle, targetAltitude }
 *   stepFn(controlInputs, dtSeconds) -> reading   reading is JSON-serializable;
 *     if it has a `.readings` object (sensorKey -> number, matching
 *     simulator.js's EngineTwin#step output), per-sensor min/max/mean are
 *     computed from that sub-object; otherwise all numeric top-level fields
 *     are used. An optional `.activeFault` (falsy | { type, label, ... })
 *     is watched for start/stop transitions to build the fault-event log.
 * -----------------------------------------------------------------------
 */

'use strict';

const { appendReading, flushMission } = require('../twin_core/store');

function makeMissionId(profileId) {
  return `${profileId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function numericFieldsOf(reading) {
  const source = reading && typeof reading.readings === 'object' ? reading.readings : reading;
  const out = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Runs one mission synchronously (as fast as the event loop allows) unless
 * `realtime` is set, in which case ticks are paced by real wall-clock time
 * (useful for a live "run a scheduled mission now" demo instead of bulk
 * dataset generation).
 *
 * @returns {Promise<{missionId, engineId, profileId, durationSeconds, tickCount, faultEvents, sensorStats}>}
 */
function runMission({
  engineId,
  profileId,
  profileFn,
  stepFn,
  durationSeconds,
  dtSeconds = 2,
  realtime = false,
  missionId = makeMissionId(profileId),
  onTick,
}) {
  if (typeof profileFn !== 'function') throw new Error('runMission: profileFn is required');
  if (typeof stepFn !== 'function') throw new Error('runMission: stepFn is required');

  return new Promise((resolve, reject) => {
    const sensorStats = {}; // key -> { min, max, sum, count }
    const faultEvents = [];
    let activeFaultType = null;
    let elapsed = 0;
    let tickCount = 0;

    function recordStats(fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (!sensorStats[k]) sensorStats[k] = { min: v, max: v, sum: 0, count: 0 };
        const s = sensorStats[k];
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        s.sum += v;
        s.count += 1;
      }
    }

    function trackFault(reading) {
      const fault = reading && reading.activeFault ? reading.activeFault : null;
      const type = fault ? fault.type || fault.label || 'unknown' : null;
      if (type && type !== activeFaultType) {
        faultEvents.push({ type, startedAtSeconds: elapsed });
      } else if (!type && activeFaultType) {
        const last = faultEvents[faultEvents.length - 1];
        if (last && last.endedAtSeconds === undefined) last.endedAtSeconds = elapsed;
      }
      activeFaultType = type;
    }

    function step() {
      try {
        const controlInputs = profileFn(elapsed);
        const reading = stepFn(controlInputs, dtSeconds);

        appendReading(engineId, missionId, reading);
        recordStats(numericFieldsOf(reading));
        trackFault(reading);
        tickCount += 1;
        if (onTick) onTick(reading, elapsed, tickCount);

        elapsed += dtSeconds;
        if (elapsed >= durationSeconds) {
          flushMission(engineId, missionId);
          const finalStats = Object.fromEntries(
            Object.entries(sensorStats).map(([k, s]) => [k, { min: s.min, max: s.max, mean: s.sum / s.count }]),
          );
          resolve({
            missionId,
            engineId,
            profileId,
            durationSeconds: elapsed,
            tickCount,
            faultEvents,
            sensorStats: finalStats,
          });
          return;
        }

        if (realtime) setTimeout(step, dtSeconds * 1000);
        else setImmediate(step);
      } catch (err) {
        reject(err);
      }
    }

    step();
  });
}

module.exports = { runMission, makeMissionId };
