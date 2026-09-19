/**
 * replay/replayEngine.js
 * -----------------------------------------------------------------------
 * Plays back a previously recorded mission (see missionRunner.js) at a
 * controllable speed, pacing frames by the gaps between the original
 * recorded timestamps — so speed 1.0 reproduces the original tick cadence
 * (e.g. the live 2s dashboard feed) and higher speeds fast-forward through
 * it. Intended to be driven by an Express/Socket.IO route that re-emits
 * `onFrame` readings the same way the live feed does.
 *
 * Lifecycle guarantees:
 *  - at most one pending timer; it is cleared by pause/seek/stop/finish
 *  - nothing is emitted after stop() (a stop() during the initial load also
 *    cancels that start), and a throwing onFrame stops playback instead of
 *    surfacing as an uncaught exception from a timer callback
 *  - speed is clamped to [MIN_SPEED, MAX_SPEED]; NaN/non-numbers are ignored
 * -----------------------------------------------------------------------
 */

'use strict';

const { readMission } = require('../twin_core/store');

const MIN_FRAME_GAP_MS = 10; // guards against a runaway setTimeout(0) storm at high speed
const MAX_FRAME_GAP_MS = 30000; // a corrupt/huge timestamp gap must not stall playback for hours
const DEFAULT_FRAME_GAP_MS = 100; // used when recorded timestamps are unusable
const MIN_SPEED = 0.1;
const MAX_SPEED = 100;

function clampSpeed(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
}

/**
 * @param {string} engineId
 * @param {string} missionId
 * @param {Object} [opts]
 * @param {number} [opts.speed=1]
 * @param {(reason: 'finished') => void} [opts.onEnd] called once when playback reaches the last frame
 * @param {(err: Error) => void} [opts.onError] called if loading fails or onFrame throws; when supplied,
 *   start() resolves instead of rejecting on a load failure
 */
function createPlayer(engineId, missionId, { speed = 1.0, onEnd, onError } = {}) {
  let readings = null;
  let index = 0;
  let playing = false;
  let paused = false;
  let timer = null;
  let onFrameCb = null;
  let currentSpeed = clampSpeed(speed, 1.0);
  let generation = 0; // bumped by start()/stop(): invalidates in-flight loads and stale timers
  let pendingGapMs = 0; // un-scaled gap the current timer was scheduled for (to re-time on speed change)

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function halt() {
    clearTimer();
    playing = false;
    paused = false;
    onFrameCb = null; // drop the reference to the caller's closure
  }

  function fail(err) {
    halt();
    if (onError) {
      try { onError(err); } catch (_e) { /* an error handler must not crash the timer callback */ }
    } else {
      console.error('[replayEngine] playback error:', err && err.message);
    }
  }

  function gapFor(cur, next) {
    const raw = next && cur && Number.isFinite(next.t) && Number.isFinite(cur.t) ? next.t - cur.t : DEFAULT_FRAME_GAP_MS;
    pendingGapMs = Math.min(MAX_FRAME_GAP_MS, Math.max(0, raw));
    return Math.max(MIN_FRAME_GAP_MS, pendingGapMs / currentSpeed);
  }

  function emitFrame() {
    timer = null;
    if (!playing || paused || !readings || !onFrameCb) return;
    if (index >= readings.length) {
      finish();
      return;
    }
    const gen = generation;
    const cur = readings[index];
    const next = readings[index + 1];
    index += 1;
    try {
      onFrameCb(cur, index - 1, readings.length);
    } catch (err) {
      fail(err);
      return;
    }
    // the callback may have called stop()/pause()/seek() re-entrantly
    if (gen !== generation || !playing || paused || timer) return;
    if (!next || index >= readings.length) {
      finish();
      return;
    }
    timer = setTimeout(emitFrame, gapFor(cur, next));
  }

  function finish() {
    halt();
    if (onEnd) {
      try { onEnd('finished'); } catch (_e) { /* ignore */ }
    }
  }

  return {
    async start(onFrame) {
      if (typeof onFrame !== 'function') throw new TypeError('start(onFrame): onFrame must be a function');
      const gen = ++generation;
      clearTimer();
      playing = false;
      paused = false;
      onFrameCb = onFrame;
      index = 0;
      if (!readings) {
        try {
          readings = await readMission(engineId, missionId);
        } catch (err) {
          if (gen !== generation) return; // stopped while loading: nothing to report
          if (onError) { fail(err); return; }
          halt();
          throw err;
        }
      }
      // stopped or restarted while the recording was loading: do not emit
      if (gen !== generation) return;
      playing = true;
      emitFrame();
    },

    pause() {
      if (!playing || paused) return;
      paused = true;
      clearTimer();
    },

    resume() {
      if (!paused || !readings) return;
      paused = false;
      playing = true;
      clearTimer();
      emitFrame();
    },

    // fractionOrTimestamp: a number in [0,1] is treated as a fraction of the
    // mission's length; a larger number is treated as an epoch-ms timestamp
    // and snapped to the nearest recorded frame. Non-numbers are ignored.
    seek(fractionOrTimestamp) {
      if (!readings || readings.length === 0) return;
      if (typeof fractionOrTimestamp !== 'number' || !Number.isFinite(fractionOrTimestamp)) return;
      clearTimer();
      if (fractionOrTimestamp >= 0 && fractionOrTimestamp <= 1) {
        index = Math.min(readings.length - 1, Math.floor(fractionOrTimestamp * readings.length));
      } else {
        let closest = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < readings.length; i++) {
          const diff = Math.abs(readings[i].t - fractionOrTimestamp);
          if (diff < bestDiff) {
            bestDiff = diff;
            closest = i;
          }
        }
        index = closest;
      }
      if (playing && !paused) emitFrame();
    },

    // Takes effect immediately: a pending frame is re-timed at the new speed.
    setSpeed(newSpeed) {
      currentSpeed = clampSpeed(newSpeed, currentSpeed);
      if (timer && playing && !paused) {
        clearTimer();
        timer = setTimeout(emitFrame, Math.max(MIN_FRAME_GAP_MS, pendingGapMs / currentSpeed));
      }
    },

    stop() {
      generation++; // invalidate any in-flight start()
      halt();
      index = 0;
    },

    get isPlaying() {
      return playing && !paused;
    },
    get length() {
      return readings ? readings.length : 0;
    },
    get position() {
      return index;
    },
    get speed() {
      return currentSpeed;
    },
  };
}

module.exports = { createPlayer, MIN_SPEED, MAX_SPEED };
