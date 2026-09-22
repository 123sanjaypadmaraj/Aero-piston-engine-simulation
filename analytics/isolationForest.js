/**
 * isolationForest.js
 * -----------------------------------------------------------------------
 * Self-contained Isolation Forest for telemetry anomaly scoring.
 *
 * Unlike the Mahalanobis detector in anomalyDetection.js — which needs an
 * invertible covariance and flags *combinations* of values — an isolation
 * forest isolates *any* unusually positioned sample cheaply, makes no
 * distributional assumptions, and is robust to strongly-correlated sensors
 * (near-singular covariance). It is the model referenced by the master plan's
 * "One-Class SVM / Isolation Forest" ML target.
 *
 * Training: each tree recursively splits a subsample on a uniformly-random
 * feature and split point (between that feature's min and max in the node).
 * An instance that is isolated by a very short average path is a likely
 * anomaly. Scores are normalized by the expected average path length of an
 * unsuccessful search in a BST (c(n) = 2(ln(n-1)+gamma) - 2(n-1)/n), giving
 * E[score] ≈ 0.5 for in-distribution data and → 1 for clear outliers.
 *
 * No external dependencies; pure JS.
 * -----------------------------------------------------------------------
 */

'use strict';

const { mean } = require('./mathUtils');

const DEFAULT_N_TREES = 64;
const DEFAULT_SUBSAMPLE = 64;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_SEED = 42;
const EULER_GAMMA = 0.5772156649015329;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Expected path length of an unsuccessful search in a BST of n nodes —
// the normalization constant for the anomaly score.
function avgPathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER_GAMMA) - (2 * (n - 1)) / n;
}

function buildTree(samples, depth, rnd, maxDepth) {
  // samples: array of { id, vec: number[] }
  if (depth >= maxDepth || samples.length <= 1) {
    return { size: samples.length };
  }

  const dim = samples[0].vec.length;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const s of samples) {
    if (s.vec[dim - 1] < minV) minV = s.vec[dim - 1];
    if (s.vec[dim - 1] > maxV) maxV = s.vec[dim - 1];
  }

  // pick a random feature differing within the node
  let q = Math.floor(rnd() * dim);
  for (let tries = 0; tries < dim && maxV === minV; tries++) {
    q = (q + 1) % dim;
    minV = Infinity;
    maxV = -Infinity;
    for (const s of samples) {
      if (s.vec[q] < minV) minV = s.vec[q];
      if (s.vec[q] > maxV) maxV = s.vec[q];
    }
  }
  if (maxV === minV) return { size: samples.length }; // all samples identical along every feature

  const split = minV + rnd() * (maxV - minV);
  const left = [];
  const right = [];
  for (const s of samples) {
    if (s.vec[q] < split) left.push(s);
    else right.push(s);
  }
  if (left.length === 0 || right.length === 0) return { size: samples.length };

  return {
    q,
    split,
    left: buildTree(left, depth + 1, rnd, maxDepth),
    right: buildTree(right, depth + 1, rnd, maxDepth),
  };
}

function pathLength(node, vec, depth) {
  if (!node.left || !node.right) return depth + avgPathLength(node.size);
  if (vec[node.q] < node.split) return pathLength(node.left, vec, depth + 1);
  return pathLength(node.right, vec, depth + 1);
}

class IsolationForest {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.nTrees=64]
   * @param {number} [opts.subsample=64]
   * @param {number} [opts.maxDepth=16]
   * @param {number} [opts.seed=42]
   */
  constructor(opts = {}) {
    this.nTrees = Number.isInteger(opts.nTrees) && opts.nTrees > 0 ? opts.nTrees : DEFAULT_N_TREES;
    this.subsample = Number.isInteger(opts.subsample) && opts.subsample > 1 ? opts.subsample : DEFAULT_SUBSAMPLE;
    this.maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;
    this.seed = Number.isFinite(opts.seed) ? opts.seed : DEFAULT_SEED;
    this.featureOrder = null;
    this.trees = [];
    this.cNormal = 0;
    this.fitted = false;
  }

  /**
   * @param {Array<Object<string, number>>} samples - vectors keyed by feature name.
   *   Non-finite / missing features are treated as 0 (callers should pass the
   *   same fallback convention as the rest of the analytics layer).
   */
  fit(samples) {
    if (!Array.isArray(samples) || samples.length < 3) {
      throw new Error('IsolationForest.fit requires at least 3 samples');
    }
    const first = samples.find((s) => s && typeof s === 'object');
    if (!first) throw new Error('IsolationForest.fit requires object samples');
    const featureOrder = Object.keys(first);
    if (!featureOrder.length) throw new Error('IsolationForest.fit requires at least one feature');

    const toVector = (s) => featureOrder.map((k) => {
      const v = s[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    });

    const rnd = mulberry32(this.seed);
    const all = samples.map((s, id) => ({ id, vec: toVector(s) }));
    // feature-wise mean used only as the fallback for non-finite/missing values
    const means = featureOrder.map((_, i) => mean(all.map((s) => s.vec[i])));
    this.featureOrder = featureOrder;
    this._means = means;
    this._toVector = toVector;

    const trees = [];
    for (let t = 0; t < this.nTrees; t++) {
      const pool = [];
      for (let i = 0; i < this.subsample && i < all.length; i++) {
        pool.push(all[Math.floor(rnd() * all.length)]);
      }
      trees.push(buildTree(pool, 0, rnd, this.maxDepth));
    }
    this.trees = trees;
    this.cNormal = avgPathLength(this.subsample);
    this.fitted = true;
    return this;
  }

  /**
   * @param {Object<string, number>} sample
   * @returns {number} anomaly score in [0, 1] (1 = strongly anomalous).
   */
  score(sample) {
    if (!this.fitted) return 0;
    const vec = this._toVector ? this._toVector(sample) : this.featureOrder.map((k) => {
      const v = sample[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    });
    let depth = 0;
    for (const tree of this.trees) depth += pathLength(tree, vec, 0);
    const expected = depth / this.trees.length;
    if (this.cNormal <= 0) return 0;
    const score = Math.pow(2, -expected / this.cNormal);
    return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  }
}

module.exports = { IsolationForest, avgPathLength };