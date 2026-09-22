/**
 * engine_sim/observer.js
 * -----------------------------------------------------------------------
 * Steady-state Kalman state observer for the engine_sim readings — a small,
 * deterministic stand-in for the estimator that a fielded FADEC/observer
 * would run on the raw sensor bus to recover a smoothed state estimate from
 * noisy measurements.
 *
 * One scalar 1-D model per sensor channel:
 *   x_k = x_{k-1} + w   (slowly drifting "true" state)
 *   z_k = x_k + v       (noisy measurement)
 * The filter gain is the *steady-state* Kalman gain obtained by iterating
 * the scalar Riccati recursion to convergence once at construction, so the
 * per-tick update is just a fixed-gain exponential smoother:
 *   innovation = z - x̂ ;  x̂ += gain * innovation
 *
 * PhysicsEngine attaches the result of `update(sample)` to every `step()`
 * reading as `observer`, so downstream layers (replay, mission store, ML)
 * see both the raw acquisition and the observer's estimate per channel.
 * -----------------------------------------------------------------------
 */

'use strict';

// The 13 sensor channels PhysicsEngine emits (engine_sim/index.js READING_KEYS).
// Kept here so observer.js stays free of a circular require with index.js;
// PhysicsEngine passes READING_KEYS explicitly, which stays the source of truth.
const DEFAULT_CHANNELS = [
  'rpm', 'cht', 'egt', 'oilPressure', 'oilTemp', 'fuelFlow', 'vibration',
  'manifoldPressure', 'batteryVoltage', 'lambda', 'injectorPulseWidth',
  'injectionTiming', 'alternatorCurrent',
];

const MIN_TRACKING_SAMPLES = 3;

/**
 * Fixed-point solution of the scalar Riccati recursion. Given process noise
 * variance q and measurement noise variance r, iterates
 *   k = p / (p + r);  p = (p + q) * (1 - k)
 * until convergence and returns the steady-state gain k in (0, 1).
 */
function steadyStateGain(q = 0.3, r = 1) {
  const QQ = Number.isFinite(q) && q > 0 ? q : 0.3;
  const RR = Number.isFinite(r) && r > 0 ? r : 1;
  let p = 1;
  for (let i = 0; i < 500; i++) {
    const k = p / (p + RR);
    p = (p + QQ) * (1 - k);
  }
  return p / (p + RR);
}

class KalmanObserver {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.channels] sensor keys to observe (default DEFAULT_CHANNELS)
   * @param {number} [opts.q] process noise variance
   * @param {number} [opts.r] measurement noise variance
   */
  constructor(opts = {}) {
    this.channels = (Array.isArray(opts.channels) && opts.channels.length ? opts.channels : DEFAULT_CHANNELS).slice();
    this.gain = steadyStateGain(opts.q, opts.r);
    this.est = {}; // channel -> latest estimate
    this.samples = 0;
  }

  /**
   * Feeds one raw sample into the observer.
   * @param {object} sample - numeric per-channel values (non-finite / missing skipped)
   * @returns {{updatedAt: number, gain: number, samples: number, ready: boolean, channels: object}}
   */
  update(sample = {}) {
    const channels = {};
    for (const key of this.channels) {
      const z = sample[key];
      if (typeof z !== 'number' || !Number.isFinite(z)) continue;
      const prev = this.est[key];
      if (prev === undefined) {
        this.est[key] = z; // first contact: initialize on the raw sample
        channels[key] = { est: z, innov: 0 };
        continue;
      }
      const innov = z - prev;
      this.est[key] = prev + this.gain * innov;
      channels[key] = { est: Number(this.est[key].toFixed(4)), innov: Math.abs(innov) };
    }
    this.samples++;
    return {
      updatedAt: Date.now(),
      gain: this.gain,
      samples: this.samples,
      ready: this.samples >= MIN_TRACKING_SAMPLES,
      channels,
    };
  }

  reset() {
    this.est = {};
    this.samples = 0;
  }
}

module.exports = { KalmanObserver, steadyStateGain, DEFAULT_CHANNELS, MIN_TRACKING_SAMPLES };