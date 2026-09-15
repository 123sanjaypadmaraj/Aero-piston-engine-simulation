/**
 * replay/replayEngine.js
 * -----------------------------------------------------------------------
 * Plays back a previously recorded mission (see missionRunner.js) at a
 * controllable speed, pacing frames by the gaps between the original
 * recorded timestamps — so speed 1.0 reproduces the original tick cadence
 * (e.g. the live 2s dashboard feed) and higher speeds fast-forward through
 * it. Intended to be driven by an Express/Socket.IO route that re-emits
 * `onFrame` readings the same way the live feed does.
 * -----------------------------------------------------------------------
 */

'use strict';

const { readMission } = require('../twin_core/store');

const MIN_FRAME_GAP_MS = 10; // guards against a runaway setTimeout(0) storm at high speed

function createPlayer(engineId, missionId, { speed = 1.0 } = {}) {
  let readings = null;
  let index = 0;
  let playing = false;
  let paused = false;
  let timer = null;
  let onFrameCb = null;
  let currentSpeed = speed;

  async function ensureLoaded() {
    if (readings) return;
    readings = await readMission(engineId, missionId);
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function emitFrame() {
    if (index >= readings.length) {
      playing = false;
      return;
    }
    onFrameCb(readings[index], index, readings.length);
    const cur = readings[index];
    const next = readings[index + 1];
    index += 1;
    if (!next || index >= readings.length) {
      playing = false;
      return;
    }
    const gapMs = Math.max(MIN_FRAME_GAP_MS, (next.t - cur.t) / currentSpeed);
    timer = setTimeout(emitFrame, gapMs);
  }

  return {
    async start(onFrame) {
      onFrameCb = onFrame;
      await ensureLoaded();
      index = 0;
      playing = true;
      paused = false;
      clearTimer();
      emitFrame();
    },

    pause() {
      if (!playing) return;
      paused = true;
      clearTimer();
    },

    resume() {
      if (!paused || !readings) return;
      paused = false;
      playing = true;
      emitFrame();
    },

    // fractionOrTimestamp: a number in [0,1] is treated as a fraction of the
    // mission's length; a larger number is treated as an epoch-ms timestamp
    // and snapped to the nearest recorded frame.
    seek(fractionOrTimestamp) {
      if (!readings || readings.length === 0) return;
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

    setSpeed(newSpeed) {
      currentSpeed = newSpeed;
    },

    stop() {
      clearTimer();
      playing = false;
      paused = false;
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
  };
}

module.exports = { createPlayer };
