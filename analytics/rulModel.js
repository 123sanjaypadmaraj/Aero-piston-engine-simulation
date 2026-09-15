/**
 * rulModel.js
 * -----------------------------------------------------------------------
 * Remaining Useful Life estimation. `estimateRUL` takes engineered rolling
 * features (see `deriveRulFeatures`) and returns an hours estimate with a
 * confidence band, via a hand-rolled weighted-decay heuristic. The function
 * signature is deliberately model-agnostic — swap the body for a trained
 * gradient-boosted or LSTM regressor later without touching callers.
 * -----------------------------------------------------------------------
 */

'use strict';

const { mean, std, slope, clamp } = require('./mathUtils');

const MAX_RUL_HOURS = 900;

/**
 * @param {number[]} healthScoreHistory - recent health-index values (0-100)
 * @param {number[]} anomalyScoreHistory - recent multivariate anomaly scores
 * @returns {Object} feature bag consumed by estimateRUL
 */
function deriveRulFeatures(healthScoreHistory, anomalyScoreHistory) {
  const h = healthScoreHistory.slice(-30);
  const a = anomalyScoreHistory.slice(-30);
  return {
    currentHealth: h.length ? h[h.length - 1] : 100,
    healthMean: mean(h),
    healthStd: std(h),
    healthSlope: slope(h), // per-sample change; negative = degrading
    currentAnomaly: a.length ? a[a.length - 1] : 0,
    anomalyMean: mean(a),
    anomalySlope: slope(a),
    sampleCount: h.length,
  };
}

/**
 * @param {ReturnType<typeof deriveRulFeatures>} features
 * @returns {{ rul: number, confidenceLow: number, confidenceHigh: number }}
 */
function estimateRUL(features) {
  const {
    currentHealth = 100,
    healthSlope = 0,
    anomalyMean = 0,
    anomalySlope = 0,
    healthStd = 0,
    sampleCount = 0,
  } = features || {};

  // Baseline: a fully healthy engine (score 100) sits near the top of the
  // simulated RUL range; baseline shrinks roughly linearly with health.
  const baseline = 40 + currentHealth * 4.6;

  // Degradation rate compounds three signals: an actively worsening health
  // trend, an actively worsening anomaly trend, and a persistently elevated
  // (but not necessarily worsening) anomaly level.
  const degradationRate = Math.max(0, -healthSlope) * 18 + Math.max(0, anomalySlope) * 12 + Math.max(0, anomalyMean) * 3;

  const rul = clamp(baseline / (1 + degradationRate), 0, MAX_RUL_HOURS);

  // Wider band with noisier health history or a short observation window
  // (few samples) — the estimate is genuinely less certain in both cases.
  const dataPenalty = sampleCount < 20 ? (20 - sampleCount) * 4 : 0;
  const uncertainty = clamp(30 + healthStd * 6 + dataPenalty, 15, 260);

  return {
    rul: Math.round(rul),
    confidenceLow: Math.round(clamp(rul - uncertainty, 0, rul)),
    confidenceHigh: Math.round(clamp(rul + uncertainty, rul, MAX_RUL_HOURS)),
  };
}

module.exports = { estimateRUL, deriveRulFeatures, MAX_RUL_HOURS };
