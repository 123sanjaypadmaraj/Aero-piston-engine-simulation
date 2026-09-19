/**
 * mathUtils.js
 * Internal numeric helpers shared by the analytics/* modules. Not part of
 * the public barrel (index.js) — required directly by sibling files.
 */

'use strict';

// NaN clamps to `lo` (fail-safe: e.g. a NaN health score becomes 0, not NaN).
function clamp(v, lo, hi) {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

// Statistics below ignore non-finite entries (NaN/Infinity/non-numbers) and
// tolerate null/empty input, rather than propagating NaN into every caller.
function finiteOnly(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? arr
    : arr.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

function mean(arr) {
  const a = finiteOnly(arr);
  if (!a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function variance(arr, m) {
  const a = finiteOnly(arr);
  if (a.length < 2) return 0;
  const mu = Number.isFinite(m) ? m : mean(a);
  return a.reduce((x, y) => x + (y - mu) ** 2, 0) / a.length;
}

function std(arr, m) {
  return Math.sqrt(variance(arr, m));
}

// Least-squares slope of `arr` values against their index (0..n-1).
// Units: value-change per sample.
// Non-finite samples are skipped (their index positions are preserved).
function slope(arr) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < arr.length; i++) {
    const y = arr[i];
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    n++;
    sx += i;
    sy += y;
    sxy += i * y;
    sxx += i * i;
  }
  if (n < 2) return 0;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  const result = (n * sxy - sx * sy) / denom;
  return Number.isFinite(result) ? result : 0;
}

// Mean absolute successive difference — a measure of sample-to-sample
// "jerkiness" independent of slope, used to spot oscillatory faults
// (e.g. misfire) that a plain trend/slope check would miss.
function jerkiness(arr) {
  const a = finiteOnly(arr);
  if (a.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < a.length; i++) sum += Math.abs(a[i] - a[i - 1]);
  return sum / (a.length - 1);
}

// n x n matrix inverse via Gauss-Jordan elimination with a small ridge term
// added to the diagonal for numerical stability on near-singular covariance
// matrices (e.g. a sensor that has barely varied during the fit window).
function invertMatrix(matrix, ridge = 1e-6) {
  const n = matrix.length;
  const aug = matrix.map((row, i) => {
    const r = row.map((v, j) => v + (i === j ? ridge : 0));
    const id = new Array(n).fill(0);
    id[i] = 1;
    return r.concat(id);
  });

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(aug[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > maxAbs) { maxAbs = Math.abs(aug[r][col]); pivotRow = r; }
    }
    if (pivotRow !== col) { const tmp = aug[col]; aug[col] = aug[pivotRow]; aug[pivotRow] = tmp; }

    const pivot = aug[col][col] || ridge;
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= factor * aug[col][j];
    }
  }

  return aug.map((row) => row.slice(n));
}

function matVecMul(matrix, vec) {
  return matrix.map((row) => row.reduce((a, v, j) => a + v * vec[j], 0));
}

module.exports = { finiteOnly, clamp, mean, variance, std, slope, jerkiness, invertMatrix, matVecMul };
