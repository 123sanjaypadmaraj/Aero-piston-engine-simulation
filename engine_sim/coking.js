/**
 * coking.js
 * -----------------------------------------------------------------------
 * Persistent "cooling / coking degradation" state for the engine_sim
 * physics model. Unlike the transient fault episodes in faults.js, coking
 * accumulates *slowly and irreversibly* with the engine's cumulative heat
 * load across missions, and is persisted per engine on disk so repeated
 * mission runs on the same engineId degrade it progressively — the
 * long-horizon reliability story the master plan's 8-category taxonomy
 * requires ("cooling / coking degradation").
 *
 *    cokingFactor 0..1 : 1 = heavily coked (reduced breathing, more heat,
 *                         less power). It feeds physics.step(degradation).
 *
 * Storage is JSON under <dir>/coking/<engineId>.json, deliberately small
 * (one number + a log) and failure-tolerant: a missing/unreadable/unwritable
 * store degrades to 0 factor and simply doesn't persist — the physics and
 * health pipeline must never depend on the store succeeding.
 * -----------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FACTOR = 1;
// Deposit rate is expressed in units of coking factor per engine-hour at
// full heat load. Scaled by heat (relative units, ~1 at cruise) so loaded
// running cokes faster than idle. The demo rate is accelerated relative to
// real (many-hundred-hour) service so several missions show progress.
const DEPOSIT_PER_FULL_LOAD_HOUR = 0.02;
// Missions that run at very low heat still leave a tiny baseline deposit.
const BASELINE_PER_HOUR = 0.004;

function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * Advance a coking factor by dt seconds of running at a given heat load.
 * @param {number} factor current 0..1
 * @param {number} dtS elapsed seconds
 * @param {number} heat normalized heat-release (relative units, ~1 at cruise)
 */
function accumulate(factor, dtS, heat = 0) {
  if (!Number.isFinite(dtS) || dtS <= 0) return factor;
  const h = Number.isFinite(heat) ? Math.max(0, heat) : 0;
  const hours = dtS / 3600;
  const rate = BASELINE_PER_HOUR + DEPOSIT_PER_FULL_LOAD_HOUR * Math.min(1.4, h);
  return clamp01(factor + rate * hours);
}

/** Depower/heat penalty applied elsewhere (physics.step's degradation input). */
function powerDerate(factor) {
  return clamp01(factor);
}

function filePathFor(engineId, dir) {
  return path.join(dir, 'coking', `${String(engineId)}.json`);
}

/** Reads a persisted coking factor (0 on any failure). */
function load(engineId, dir) {
  if (!engineId || !dir) return 0;
  try {
    const raw = fs.readFileSync(filePathFor(engineId, dir), 'utf8');
    const parsed = JSON.parse(raw);
    return clamp01(parsed.cokingFactor);
  } catch {
    return 0; // not present yet, unreadable, or corrupt — treat as clean
  }
}

/** Persists a coking factor; returns false if the store is unwritable. */
function save(engineId, dir, factor) {
  if (!engineId || !dir) return false;
  try {
    const dest = path.join(dir, 'coking');
    fs.mkdirSync(dest, { recursive: true });
    const tmp = `${filePathFor(engineId, dir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ engineId, cokingFactor: clamp01(factor), updatedAt: Date.now() }));
    fs.renameSync(tmp, filePathFor(engineId, dir));
    return true;
  } catch {
    return false;
  }
}

module.exports = { accumulate, powerDerate, load, save, clamp01, MAX_FACTOR, DEPOSIT_PER_FULL_LOAD_HOUR };