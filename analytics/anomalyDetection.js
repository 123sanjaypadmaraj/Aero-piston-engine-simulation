/**
 * anomalyDetection.js
 * -----------------------------------------------------------------------
 * Multivariate statistical anomaly detection, distinct from simulator.js's
 * per-sensor rolling z-score: this catches a *combination* of individually
 * normal readings that is jointly implausible (e.g. CHT/EGT/fuelFlow that
 * don't add up together), which a per-sensor check structurally cannot see.
 *
 * Implementation: squared Mahalanobis distance of a sample from a "healthy"
 * distribution's mean/covariance, computed with a hand-rolled Gauss-Jordan
 * matrix inverse (no external linear-algebra dependency). This is the same
 * statistical idea a covariance-based Isolation Forest / one-class model
 * would approximate, at a fraction of the code and with exact,
 * decomposable per-feature contributions for explainability.
 * -----------------------------------------------------------------------
 */

'use strict';

const { invertMatrix, matVecMul } = require('./mathUtils');

const DEFAULT_FEATURE_ORDER = [
  'rpm', 'cht', 'egt', 'oilPressure', 'oilTemp', 'fuelFlow', 'vibration', 'manifoldPressure', 'batteryVoltage',
];

// A missing/non-finite feature becomes `fallback[i]` (the healthy mean when the
// caller has one, so it contributes zero deviation) or 0 if no fallback given.
function toVector(sample, order, fallback) {
  return order.map((k, i) => {
    const v = sample ? sample[k] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return fallback && Number.isFinite(fallback[i]) ? fallback[i] : 0;
  });
}

const MAX_SCORE = 1e6; // cap: a near-constant training feature can otherwise blow the score up to Infinity

function isCleanSample(sample, order) {
  return !!sample && order.every((k) => typeof sample[k] === 'number' && Number.isFinite(sample[k]));
}

function computeMeanCov(vectors) {
  const n = vectors.length;
  const dim = vectors[0].length;
  const mu = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) mu[i] += v[i] / n;

  const cov = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      const di = v[i] - mu[i];
      for (let j = 0; j < dim; j++) {
        cov[i][j] += (di * (v[j] - mu[j])) / (n - 1 || 1);
      }
    }
  }
  return { mu, cov };
}

class MultivariateAnomalyDetector {
  constructor(featureOrder = DEFAULT_FEATURE_ORDER) {
    if (!Array.isArray(featureOrder) || !featureOrder.length) {
      throw new TypeError('MultivariateAnomalyDetector: featureOrder must be a non-empty array');
    }
    this.featureOrder = featureOrder;
    this.mu = null;
    this.covInv = null;
    this.fitted = false;
    this.sampleCount = 0;
  }

  /** @param {Array<Object<string, number>>} healthySamples */
  fit(healthySamples) {
    if (!Array.isArray(healthySamples) || healthySamples.length < 3) {
      throw new Error('MultivariateAnomalyDetector.fit requires at least 3 samples');
    }
    // samples with any NaN/missing feature would drag the fitted mean/covariance
    // toward 0, so they are excluded rather than zero-filled
    const clean = healthySamples.filter((s) => isCleanSample(s, this.featureOrder));
    if (clean.length < 3) {
      throw new Error('MultivariateAnomalyDetector.fit requires at least 3 samples with finite values for every feature');
    }
    const vectors = clean.map((s) => toVector(s, this.featureOrder));
    const { mu, cov } = computeMeanCov(vectors);
    // Per-feature variance floor (0.1% of the feature's magnitude, squared): a
    // sensor that was constant during the fit window would otherwise get a
    // ~1e6 inverse weight and make any tiny deviation score astronomically high.
    for (let i = 0; i < cov.length; i++) {
      const floor = (0.001 * Math.max(Math.abs(mu[i]), 1)) ** 2;
      if (cov[i][i] < floor) cov[i][i] = floor;
    }
    let covInv = invertMatrix(cov);
    if (!covInv.every((row) => row.every(Number.isFinite))) {
      // singular beyond the ridge's ability to fix: fall back to independent features
      covInv = cov.map((row, i) => row.map((_, j) => (i === j ? 1 / (cov[i][i] || 1) : 0)));
    }
    this.mu = mu;
    this.covInv = covInv;
    this.fitted = true;
    this.sampleCount = clean.length;
    return this;
  }

  // Slowly folds a new (presumed mostly-healthy) sample into the running
  // mean so the "normal" baseline can drift with e.g. altitude/season
  // without needing a full refit. Covariance is left as-is between refits
  // to keep this cheap — call fit() again periodically for a full update.
  adapt(sample, rate = 0.01) {
    if (!this.fitted) return;
    if (!Number.isFinite(rate) || rate <= 0) return;
    const r = Math.min(rate, 1);
    const v = toVector(sample, this.featureOrder, this.mu); // missing feature -> no shift
    for (let i = 0; i < this.mu.length; i++) this.mu[i] += (v[i] - this.mu[i]) * r;
  }

  /**
   * @param {Object<string, number>} sample
   * @returns {{ score: number, contributions: Array<{feature: string, contribution: number}> }}
   */
  score(sample) {
    if (!this.fitted) return { score: 0, contributions: this.featureOrder.map((f) => ({ feature: f, contribution: 0 })) };
    const v = toVector(sample, this.featureOrder, this.mu); // missing feature -> zero deviation
    const diff = v.map((x, i) => x - this.mu[i]);
    const weighted = matVecMul(this.covInv, diff); // S^-1 * diff
    // Per-feature contribution: diff_i * (S^-1 * diff)_i sums exactly to the
    // total squared Mahalanobis distance, giving an exact decomposition
    // rather than an approximation.
    const contributions = this.featureOrder.map((feature, i) => ({ feature, contribution: diff[i] * weighted[i] }));
    const total = contributions.reduce((a, c) => a + c.contribution, 0);
    const score = Number.isFinite(total) ? Math.min(MAX_SCORE, Math.max(0, total)) : 0;
    return { score, contributions };
  }
}

module.exports = { MultivariateAnomalyDetector, DEFAULT_FEATURE_ORDER, computeMeanCov, toVector };
