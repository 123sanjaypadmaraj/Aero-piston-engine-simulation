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

const { mean, invertMatrix, matVecMul } = require('./mathUtils');

const DEFAULT_FEATURE_ORDER = [
  'rpm', 'cht', 'egt', 'oilPressure', 'oilTemp', 'fuelFlow', 'vibration', 'manifoldPressure', 'batteryVoltage',
];

function toVector(sample, order) {
  return order.map((k) => {
    const v = sample[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
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
    this.featureOrder = featureOrder;
    this.mu = null;
    this.covInv = null;
    this.fitted = false;
    this.sampleCount = 0;
  }

  /** @param {Array<Object<string, number>>} healthySamples */
  fit(healthySamples) {
    if (!healthySamples || healthySamples.length < 3) {
      throw new Error('MultivariateAnomalyDetector.fit requires at least 3 samples');
    }
    const vectors = healthySamples.map((s) => toVector(s, this.featureOrder));
    const { mu, cov } = computeMeanCov(vectors);
    this.mu = mu;
    this.covInv = invertMatrix(cov);
    this.fitted = true;
    this.sampleCount = healthySamples.length;
    return this;
  }

  // Slowly folds a new (presumed mostly-healthy) sample into the running
  // mean so the "normal" baseline can drift with e.g. altitude/season
  // without needing a full refit. Covariance is left as-is between refits
  // to keep this cheap — call fit() again periodically for a full update.
  adapt(sample, rate = 0.01) {
    if (!this.fitted) return;
    const v = toVector(sample, this.featureOrder);
    for (let i = 0; i < this.mu.length; i++) this.mu[i] += (v[i] - this.mu[i]) * rate;
  }

  /**
   * @param {Object<string, number>} sample
   * @returns {{ score: number, contributions: Array<{feature: string, contribution: number}> }}
   */
  score(sample) {
    if (!this.fitted) return { score: 0, contributions: this.featureOrder.map((f) => ({ feature: f, contribution: 0 })) };
    const v = toVector(sample, this.featureOrder);
    const diff = v.map((x, i) => x - this.mu[i]);
    const weighted = matVecMul(this.covInv, diff); // S^-1 * diff
    // Per-feature contribution: diff_i * (S^-1 * diff)_i sums exactly to the
    // total squared Mahalanobis distance, giving an exact decomposition
    // rather than an approximation.
    const contributions = this.featureOrder.map((feature, i) => ({ feature, contribution: diff[i] * weighted[i] }));
    const score = contributions.reduce((a, c) => a + c.contribution, 0);
    return { score: Math.max(0, score), contributions };
  }
}

module.exports = { MultivariateAnomalyDetector, DEFAULT_FEATURE_ORDER, computeMeanCov, toVector };
