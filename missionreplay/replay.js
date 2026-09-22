/**
 * missionreplay/replay.js
 * -----------------------------------------------------------------------
 * Stateful mission replay engine (spec §4.3).
 *
 *   const player = createReplay(record);
 *   player.seek(1200.5);                 // interpolated state, position set
 *   player.stateAt(t);                   // pure read at arbitrary t
 *   player.get_range(0, 21600);          // bulk samples (strided)
 *   const ctrl = player.play(speed, fn); // live playback (0.5x..500x)
 *   ctrl.pause(); ctrl.resume(); ctrl.stop(); ctrl.setSpeed(2);
 *   player.step(n);                      // advance n samples
 *
 * Interpolation is linear between neighbouring samples, EXCEPT it snaps to
 * the post-onset sample across any fault onset/resolution boundary
 * (spec §4.3: never blend a healthy reading with a faulty one).
 *
 * Three-tier anomaly overlay (spec §4.4):
 *   nominal   - no active fault, not inside any precursor window
 *   precursor - inside a fault's precursor_window_s
 *   active    - a fault is active at t
 * -----------------------------------------------------------------------
 */

'use strict';

const { OVERRANGE_SENSOR } = require('./faultLib');
const { phaseAt } = require('./profiles');

const OVERRANGE = OVERRANGE_SENSOR;

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function round2(x) { return Math.round(x * 100) / 100; }

const GROUPS = ['flight', 'mechanical', 'thermal', 'fuel'];

function interpValue(a, b, frac) {
  if (a === OVERRANGE || b === OVERRANGE) return b === OVERRANGE ? OVERRANGE : a;
  if (!isNum(a) || !isNum(b)) return a;
  return a + (b - a) * frac;
}

function interpolate(s0, s1, frac, crossing, t) {
  const out = { t_s: t, phase: s1.phase };
  for (const g of GROUPS) {
    out[g] = {};
    for (const key of Object.keys(s0[g] || {})) {
      out[g][key] = crossing ? s1[g][key] : interpValue(s0[g][key], s1[g][key], frac);
    }
  }
  out.fault_flags = crossing ? s1.fault_flags.slice() : (frac < 0.5 ? s0.fault_flags.slice() : s1.fault_flags.slice());
  return out;
}

/**
 * @param {object} record result of loader.loadMission
 */
function createReplay(record) {
  const rate = record.rate || 1;
  const t0 = record.t0 || 0;
  const tEnd = t0 + (record.duration || 0);
  const sampleSpan = 1 / rate;
  const boundaries = [];
  for (const f of record.faults || []) {
    if (isNum(f.onset_s)) boundaries.push(f.onset_s);
    if (isNum(f.resolved_s)) boundaries.push(f.resolved_s);
  }

  function lineForT(t) {
    return Math.max(0, Math.min(record.sampleCount - 1, Math.round((t - t0) * rate)));
  }

  function faultOverlay(t) {
    const active = record.activeFaultsAt(t);
    const precursor = record.precursorFaultsAt(t);
    const tier = active.length ? 'active' : (precursor.length ? 'precursor' : 'nominal');
    return {
      tier,
      active: active.map((f) => f.fault_id),
      precursor: precursor.map((f) => f.fault_id),
    };
  }

  function stateAt(t) {
    const clamped = Math.max(t0, Math.min(tEnd, t));
    const i0 = Math.max(0, Math.min(record.sampleCount - 1, Math.floor((clamped - t0) * rate)));
    const s0 = record.sampleAtLine(i0);
    if (!s0) return null;
    if (i0 >= record.sampleCount - 1 || s0.t_s === clamped) {
      return buildState(clamped, s0);
    }
    const s1 = record.sampleAtLine(i0 + 1);
    if (!s1) {
      return buildState(clamped, s0);
    }
    const frac = (clamped - s0.t_s) / Math.max(sampleSpan, s1.t_s - s0.t_s);
    const crossing = boundaries.some((b) => b !== null && b > s0.t_s && b < s1.t_s);
    return buildState(clamped, interpolate(s0, s1, frac, crossing, round2(clamped)), i0);
  }

  function buildState(t, state, nearestLine) {
    const out = Object.assign({}, state, { t_s: round2(t) });
    out.phase = phaseAt(record.phases, t) || out.phase || null;
    out.anomaly = faultOverlay(t);
    if (record.can) {
      const canLine = record.can[nearestLine !== undefined ? nearestLine : lineForT(t)];
      out.can = canLine ? canLine.frames : null;
    }
    return out;
  }

  function activeFaultsAt(t) { return record.activeFaultsAt(t); }
  function precursorFaultsAt(t) { return record.precursorFaultsAt(t); }

  function getRange(startT, endT, opts) {
    const o = opts || {};
    const maxSamples = o.maxSamples || 2000;
    const lo = Math.max(t0, Math.min(startT, endT));
    const hi = Math.min(tEnd, Math.max(startT, endT));
    const count = Math.round((hi - lo) * rate);
    const stride = Math.max(1, Math.ceil(count / maxSamples));
    const out = [];
    for (let i = 0; i <= count; i += stride) out.push(stateAt(lo + i / rate));
    return out;
  }

  // --- playback state ---
  let currentT = t0;
  let timer = null;
  let running = 1;
  let currentOnFrame = null;

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    return snapshot();
  }

  function snapshot() {
    return {
      missionId: record.missionId,
      t_s: round2(currentT),
      sampleIndex: lineForT(currentT),
      phase: phaseAt(record.phases, currentT),
      playing: Boolean(timer),
      anomaly: faultOverlay(currentT),
      state: stateAt(currentT),
    };
  }

  function play(speed, onFrame) {
    stop();
    running = Math.max(0.5, Math.min(500, Number(speed) || 1));
    currentOnFrame = onFrame || null;
    const ms = Math.max(1, 1000 / (rate * running));
    timer = setInterval(() => {
      if (currentT >= tEnd - 1e-9) { stop(); return; }
      currentT = Math.min(tEnd, currentT + sampleSpan);
      if (currentOnFrame) currentOnFrame(stateAt(currentT));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return {
      getState: snapshot,
    };
  }

  return {
    record,
    currentT() { return currentT; },
    seek(t) { currentT = Math.max(t0, Math.min(tEnd, t)); return stateAt(currentT); },
    stateAt,
    activeFaultsAt,
    precursorFaultsAt,
    phaseAt(t) { return phaseAt(record.phases, t); },
    getRange,
    step(n) { currentT = Math.max(t0, Math.min(tEnd, currentT + (n * 1) / rate)); return stateAt(currentT); },
    play,
    pause() { stop(); return snapshot(); },
    stop,
    resume() { if (!timer) { play(running, currentOnFrame); } return snapshot(); },
    snapshot,
  };
}

module.exports = { createReplay, MissionReplay: createReplay };