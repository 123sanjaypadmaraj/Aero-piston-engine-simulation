/**
 * replay/missionRunner.js
 * -----------------------------------------------------------------------
 * Drives a full simulated mission end-to-end and records every reading via
 * twin_core/store, producing a dataset that replay/replayEngine.js (or an ML
 * training script) can play back later.
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

const { appendReading, flushMission, assertId } = require('../twin_core/store');

const MIN_DT_S = 0.5;
const MAX_DT_S = 30;
const MIN_DURATION_S = 10;
const MAX_DURATION_S = 14400; // 4 h
const SLICE_BUDGET_MS = 8; // max synchronous work before yielding to the event loop

function makeMissionId(profileId) {
  // profileId may come from a request body: keep the id within the store's [A-Za-z0-9_-]{1,64}
  const safe = String(profileId || 'mission').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'mission';
  return `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function numericFieldsOf(reading) {
  const source = reading && typeof reading.readings === 'object' ? reading.readings : reading;
  const out = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function abortError(signal) {
  const err = new Error('runMission aborted');
  err.name = 'AbortError';
  if (signal && signal.reason !== undefined) err.cause = signal.reason;
  return err;
}

/**
 * Runs one mission as fast as the event loop allows (in ~8ms slices, yielding
 * with setImmediate between them so HTTP/socket traffic stays responsive)
 * unless `realtime` is set, in which case ticks are paced by real wall-clock
 * time (useful for a live "run a scheduled mission now" demo instead of bulk
 * dataset generation).
 *
 * Bounds (RangeError, delivered as a promise rejection): durationSeconds
 * 10..14400, dtSeconds 0.5..30. Invalid engineId/missionId (see
 * twin_core/store) also reject with RangeError. Pass an AbortSignal as
 * `signal` to cancel: pending timers are cleared, what was recorded so far is
 * flushed, and the promise rejects with an AbortError.
 *
 * Each recorded reading is stamped `t` = mission start + simulated elapsed
 * time (so replay at speed 1 reproduces the tick cadence even for missions
 * generated faster than real time), unless the reading carries its own `t`.
 *
 * @returns {Promise<{missionId, engineId, profileId, durationSeconds, tickCount, faultEvents, sensorStats, truncated?}>}
 */
function runMission({
  engineId,
  profileId,
  profileFn,
  stepFn,
  durationSeconds,
  dtSeconds = 2,
  realtime = false,
  missionId,
  onTick,
  signal,
} = {}) {
  try {
    if (typeof profileFn !== 'function') throw new TypeError('runMission: profileFn is required');
    if (typeof stepFn !== 'function') throw new TypeError('runMission: stepFn is required');
    if (onTick !== undefined && onTick !== null && typeof onTick !== 'function') throw new TypeError('runMission: onTick must be a function');
    assertId('engineId', engineId);
    if (missionId === undefined || missionId === null) missionId = makeMissionId(profileId);
    assertId('missionId', missionId);
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)
      || durationSeconds < MIN_DURATION_S || durationSeconds > MAX_DURATION_S) {
      throw new RangeError(`runMission: durationSeconds must be a number between ${MIN_DURATION_S} and ${MAX_DURATION_S}`);
    }
    if (typeof dtSeconds !== 'number' || !Number.isFinite(dtSeconds) || dtSeconds < MIN_DT_S || dtSeconds > MAX_DT_S) {
      throw new RangeError(`runMission: dtSeconds must be a number between ${MIN_DT_S} and ${MAX_DT_S}`);
    }
    if (signal && signal.aborted) throw abortError(signal);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const sensorStats = {}; // key -> { min, max, sum, count }
    const faultEvents = [];
    const startedAtMs = Date.now();
    let activeFaultType = null;
    let elapsed = 0;
    let tickCount = 0;
    let truncated = false;
    let timer = null; // { clear() } for whichever timer/immediate is pending
    let settled = false;

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

    function cleanup() {
      settled = true;
      if (timer) { timer.clear(); timer = null; }
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    function safeFlush() {
      try { flushMission(engineId, missionId); } catch (err) { console.error('[missionRunner] flush failed:', err.message); }
    }

    function fail(err) {
      if (settled) return;
      cleanup();
      safeFlush(); // keep whatever was recorded before the failure
      reject(err);
    }

    function onAbort() { fail(abortError(signal)); }

    function tick() {
      const controlInputs = profileFn(elapsed);
      const reading = stepFn(controlInputs, dtSeconds);
      if (reading === null || typeof reading !== 'object' || Array.isArray(reading)) {
        throw new TypeError('runMission: stepFn must return an object reading');
      }
      const stamp = typeof reading.t === 'number' && Number.isFinite(reading.t) ? {} : { t: startedAtMs + Math.round(elapsed * 1000) };
      if (appendReading(engineId, missionId, { ...stamp, ...reading }) === false) truncated = true;
      recordStats(numericFieldsOf(reading));
      trackFault(reading);
      tickCount += 1;
      if (onTick) onTick(reading, elapsed, tickCount);
      elapsed = tickCount * dtSeconds; // multiply rather than accumulate: no float drift over ~28k ticks
    }

    function complete() {
      cleanup();
      safeFlush();
      const finalStats = Object.fromEntries(
        Object.entries(sensorStats).map(([k, s]) => [k, { min: s.min, max: s.max, mean: s.sum / s.count }]),
      );
      const summary = { missionId, engineId, profileId, durationSeconds: elapsed, tickCount, faultEvents, sensorStats: finalStats };
      if (truncated) summary.truncated = true;
      resolve(summary);
    }

    function runSlice() {
      timer = null;
      if (settled) return;
      try {
        const sliceStart = performance.now();
        do {
          tick();
          if (elapsed >= durationSeconds) { complete(); return; }
          if (realtime) {
            const t = setTimeout(runSlice, dtSeconds * 1000);
            timer = { clear: () => clearTimeout(t) };
            return;
          }
        } while (performance.now() - sliceStart < SLICE_BUDGET_MS);
        const im = setImmediate(runSlice);
        timer = { clear: () => clearImmediate(im) };
      } catch (err) {
        fail(err);
      }
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    runSlice();
  });
}

module.exports = { runMission, makeMissionId, MIN_DT_S, MAX_DT_S, MIN_DURATION_S, MAX_DURATION_S };
