/**
 * rainflow.js
 * -----------------------------------------------------------------------
 * Deterministic ASTM-style rainflow cycle counting for the fatigue-RUL
 * layer ("Rainflow counting" stage of the pipeline). Turns an ordered
 * (usually stress) time series into a cycle distribution { min, max, mean,
 * amplitude } that Miner's rule can accumulate. Pure, side-effect free and
 * fully deterministic — no randomness, no sort order ambiguity.
 *
 * Implementation:
 *   1. Extract turning points (strictly alternating extrema) so flat /
 *      monotonic runs compress to a single value.
 *   2. Scan with the 4-point rule: when the last three ranges satisfy
 *      range(b->c) is the smallest, points b,c close a full cycle.
 *   3. Whatever remains on the stack is a residual sequence that closes
 *      the hysteresis loop between the window ends -> half cycles.
 * -----------------------------------------------------------------------
 */

'use strict';

function turningPoints(values) {
  const pts = [];
  let prev = null;
  let lastSign = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (prev === null) { prev = v; pts.push(v); continue; }
    const sign = v === prev ? 0 : v > prev ? 1 : -1;
    if (sign !== 0) {
      if (sign !== lastSign) {
        pts.push(v);
        lastSign = sign;
      } else {
        pts[pts.length - 1] = v; // extend the current extremum
      }
    }
    prev = v;
  }
  return pts;
}

function cycleBetween(a, b, extra = {}) {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return {
    min,
    max,
    mean: (min + max) / 2,
    amp: (max - min) / 2,
    range: max - min,
    ...extra,
  };
}

/**
 * Rainflow count of a 1-D series.
 * @param {Array<number>} series - ordered samples (stress, load, etc.)
 * @param {Object} [opts]
 * @param {boolean} [opts.includeResidual=true] - emit the closing half cycles
 * @returns {{ cycles: Array, halfCycles: Array, histogram: Array, turningPoints: Array }}
 *   cycles: complete cycles, count 1
 *   halfCycles: residual closing cycles, count 0.5
 *   histogram: amplitude-binned cycle count (ascending), useful for reporting
 */
function rainflowCount(series, opts = {}) {
  const includeResidual = opts.includeResidual !== false;
  const t = turningPoints(series);
  if (t.length < 2) return { cycles: [], halfCycles: [], histogram: [], turningPoints: t };

  const stack = t.slice();
  const cycles = [];
  const halfCycles = [];

  // 4-point rule: the inner segment (stack[1] -> stack[2]) closes a full
  // cycle when |c-b| <= |b-a| and |c-b| <= |d-c| (ties count deterministically).
  while (stack.length >= 4) {
    const a = stack[stack.length - 4];
    const b = stack[stack.length - 3];
    const c = stack[stack.length - 2];
    const d = stack[stack.length - 1];
    const r1 = Math.abs(b - a);
    const r2 = Math.abs(c - b);
    const r3 = Math.abs(d - c);
    if (r2 <= r1 && r2 <= r3) {
      stack.splice(stack.length - 3, 2); // pop b and c
      cycles.push(cycleBetween(b, c, { start: b, end: c, count: 1 }));
    } else {
      stack.splice(0, 1); // shift window right
    }
  }

  if (includeResidual && stack.length >= 2) {
    for (let i = 0; i < stack.length - 1; i += 2) {
      halfCycles.push(cycleBetween(stack[i], stack[i + 1], { start: stack[i], end: stack[i + 1], count: 0.5 }));
    }
    if (stack.length % 2 === 1) {
      const last = stack.length - 1;
      halfCycles.push(cycleBetween(stack[last], stack[0], { start: stack[last], end: stack[0], count: 0.5 }));
    }
  }

  return { cycles, halfCycles, histogram: cycleHistogram(cycles, opts), turningPoints: t };
}

/**
 * Amplitude histogram over full cycles.
 * @param {Array} cycles - rainflow cycle records
 * @param {Object} [opts]
 * @param {number} [opts.bins=20] - number of equal-width amplitude bins
 * @returns {Array<{ low, high, center, count }>} ascending by amplitude
 */
function cycleHistogram(cycles, opts = {}) {
  const binsN = Math.max(2, Math.min(200, Math.floor(opts.bins || 20)));
  const amps = cycles.map((c) => c.amp).filter((a) => a > 0);
  if (!amps.length) return [];
  const maxAmp = Math.max(...amps);
  const width = maxAmp / binsN;
  const counts = new Array(binsN).fill(0);
  for (const a of amps) {
    const idx = Math.min(binsN - 1, Math.floor(a / width));
    counts[idx] += 1;
  }
  return counts.map((count, i) => ({
    low: i * width,
    high: (i + 1) * width,
    center: (i + 0.5) * width,
    count,
  }));
}

module.exports = { rainflowCount, turningPoints, cycleHistogram };