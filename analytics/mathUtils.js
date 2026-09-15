/**
 * mathUtils.js
 * Internal numeric helpers shared by the analytics/* modules. Not part of
 * the public barrel (index.js) — required directly by sibling files.
 */

'use strict';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function variance(arr, m = mean(arr)) {
  if (arr.length < 2) return 0;
  return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
}

function std(arr, m = mean(arr)) {
  return Math.sqrt(variance(arr, m));
}

// Least-squares slope of `arr` values against their index (0..n-1).
// Units: value-change per sample.
function slope(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += arr[i];
    sxy += i * arr[i];
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

// Mean absolute successive difference — a measure of sample-to-sample
// "jerkiness" independent of slope, used to spot oscillatory faults
// (e.g. misfire) that a plain trend/slope check would miss.
function jerkiness(arr) {
  if (arr.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < arr.length; i++) sum += Math.abs(arr[i] - arr[i - 1]);
  return sum / (arr.length - 1);
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

module.exports = { clamp, mean, variance, std, slope, jerkiness, invertMatrix, matVecMul };
