/**
 * shap.js
 * -----------------------------------------------------------------------
 * Kernel-SHAP-lite: model-agnostic local feature attribution for a scalar
 * predictor, using the classic Shapley-kernel-weighted least-squares
 * regression of KernelSHAP (Lundberg & Lee 2017).
 *
 * We cannot enumerate all 2^d subsets for 13 features, so we sample
 * coalitions (uniformly at random, deterministically seeded), always include
 * the empty and full coalitions, weight each by the Shapley kernel
 *   w(z) = (m-1) / (C(m,|z|) · |z| · (m-|z|))
 * and solve
 *   φ = (ZᵀWZ + λI)⁻¹ ZᵀW(v(z) - v(∅))
 * for the additive Shapley values φ_i.
 *
 * The output is the per-sensor "how much did THIS signal push the model's
 * output" decomposition the master plan's explainability requirement asks
 * for — e.g. "CHT and its rising slope are responsible for 62% of the
 * RUL drop". Pure JS, no external deps.
 * -----------------------------------------------------------------------
 */

'use strict';

const { invertMatrix } = require('./mathUtils');

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

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

/**
 * @param {Object} opts
 * @param {(vec: number[]) => number} opts.predict - scalar predictor over a
 *   full-length vector in featureOrder order. Must be cheap (called ~100x).
 * @param {Object<string, number>} opts.sample - the sample being explained
 * @param {Object<string, number>} opts.background - base/median value per
 *   feature used to form partial coalitions
 * @param {string[]} opts.featureOrder
 * @param {number} [opts.nCoalitions=96]
 * @param {number} [opts.seed=1]
 * @returns {{ expected: number, prediction: number, attributions:
 *   Array<{ feature: string, value: number, shap: number }>, nCoalitions: number }}
 */
function shapAttribution(opts) {
  if (!opts || typeof opts.predict !== 'function') throw new TypeError('shapAttribution requires opts.predict');
  const featureOrder = opts.featureOrder;
  if (!Array.isArray(featureOrder) || !featureOrder.length) throw new TypeError('shapAttribution requires featureOrder');
  if (!opts.sample || typeof opts.sample !== 'object') throw new TypeError('shapAttribution requires a sample object');
  const background = opts.background && typeof opts.background === 'object' ? opts.background : {};

  const d = featureOrder.length;
  const rnd = mulberry32(Number.isFinite(opts.seed) ? opts.seed : 1);
  const nCoalitions = Number.isInteger(opts.nCoalitions) && opts.nCoalitions > 0
    ? Math.min(opts.nCoalitions, 8192) : 96;

  const sampleVec = featureOrder.map((k) => {
    const v = opts.sample[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : (background[k] || 0);
  });
  const backgroundVec = featureOrder.map((k) => {
    const v = background[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });

  const hybrid = (z) => featureOrder.map((_, i) => (z & (1 << i)) ? sampleVec[i] : backgroundVec[i]);

  const valueOf = (z) => {
    const v = opts.predict(hybrid(z));
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  // Always include empty and full coalitions for the anchor points.
  const z0 = 0;
  const zAll = (1 << d) - 1;
  const v0 = valueOf(z0);
  const p0 = v0 === null ? 0 : v0;
  const full = valueOf(zAll);
  const prediction = full === null ? p0 : full;

  // kernel weight for |z| = k:  (m-1)/(C(m,k) k (m-k))
  const kernel = (k) => {
    if (k <= 0 || k >= d) return 1; // empty/full anchors get full weight
    const denom = choose(d, k) * k * (d - k);
    return denom === 0 ? 1 : (d - 1) / denom;
  };

  // Coalsece all non-empty, non-full coalitions sampled at random.
  const seen = new Set();
  const rows = [{ z: 0, v: v0 === null ? p0 : v0 }, { z: zAll, v: full === null ? p0 : full }];
  seen.add(0);
  seen.add(zAll);
  let budget = nCoalitions;
  while (budget > 0 && seen.size < (1 << d)) {
    const z = Math.floor(rnd() * (1 << d));
    if (seen.has(z)) continue;
    seen.add(z);
    const v = valueOf(z);
    if (v === null) continue; // non-finite: skip, don't poison the fit
    rows.push({ z, v });
    budget--;
  }

  // Weighted least squares over the deviation (v - v0):  φ = (AᵀWA + λI)⁻¹ AᵀW (v - v0)
  const A = rows.map((r) => featureOrder.map((_, i) => (r.z & (1 << i)) ? 1 : 0));
  const wts = rows.map((r) => kernel(popcount(r.z)));
  const devs = rows.map((r) => r.v - p0);

  const AtW = featureOrder.map((_, i) => rows.map((r, ri) => A[ri][i] * wts[ri]));
  const AtWA = featureOrder.map((_, i) => featureOrder.map((_, j) => AtW[i].reduce((a, v, ri) => a + v * A[ri][j], 0)));
  const AtWd = featureOrder.map((_, i) => AtW[i].reduce((a, v, ri) => a + v * devs[ri], 0));
  // ridge tiny relative to the fitted scale — with exhaustive coalitions the
  // weighted LS is then exact, with sampled ones only mildly regularized
  let maxEntry = 0;
  for (const row of AtWA) for (const v of row) maxEntry = Math.max(maxEntry, Math.abs(v));
  const ridge = Math.max(1e-12, maxEntry * 1e-9);
  const inv = invertMatrix(AtWA, ridge);
  const phi = inv.map((row) => row.reduce((a, v, j) => a + v * AtWd[j], 0));

  let shapTotal = phi.reduce((a, v) => a + v, 0);
  // enforce additivity: Σφ = prediction - base
  const target = prediction - p0;
  if (target !== 0 && shapTotal !== 0) {
    const scale = target / shapTotal;
    for (let i = 0; i < phi.length; i++) phi[i] *= scale;
  }

  const attributions = featureOrder
    .map((feature, i) => ({ feature, value: sampleVec[i], shap: Number.isFinite(phi[i]) ? phi[i] : 0 }))
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));

  return { expected: p0, prediction, attributions, nCoalitions: rows.length };
}

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

module.exports = { shapAttribution, choose };