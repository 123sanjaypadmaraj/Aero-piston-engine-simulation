/**
 * twin_core/store.js
 * -----------------------------------------------------------------------
 * Append-only time-series store for recorded missions, stand-in for the
 * master plan's TimescaleDB/InfluxDB layer. Pure filesystem (JSON-Lines),
 * so the demo has zero database/native-dependency footprint on Windows.
 *
 * Layout: twin_core/data/<engineId>/<missionId>.jsonl
 * One JSON object per line: { t: <ms epoch>, ...reading }
 * -----------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, 'data');

// Buffered per-file writers: readings arrive on every sim tick (as often as
// every ~100ms across a fleet), so we batch them and flush on an interval
// instead of doing a fs write syscall per reading.
const FLUSH_INTERVAL_MS = 1000;
const buffers = new Map(); // key: `${engineId}/${missionId}` -> array of lines
const flushTimers = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function missionDir(engineId) {
  return path.join(DATA_DIR, engineId);
}

function missionFile(engineId, missionId) {
  return path.join(missionDir(engineId), `${missionId}.jsonl`);
}

function scheduleFlush(key, engineId, missionId) {
  if (flushTimers.has(key)) return;
  const timer = setTimeout(() => {
    flushTimers.delete(key);
    flush(key, engineId, missionId);
  }, FLUSH_INTERVAL_MS);
  // don't hold the process open just for a pending flush
  if (timer.unref) timer.unref();
  flushTimers.set(key, timer);
}

function flush(key, engineId, missionId) {
  const lines = buffers.get(key);
  if (!lines || lines.length === 0) return;
  buffers.set(key, []);
  ensureDir(missionDir(engineId));
  fs.appendFile(missionFile(engineId, missionId), lines.join(''), (err) => {
    if (err) console.error(`[twin_core/store] flush failed for ${key}:`, err.message);
  });
}

function appendReading(engineId, missionId, reading) {
  const key = `${engineId}/${missionId}`;
  const record = { t: Date.now(), ...reading };
  if (!buffers.has(key)) buffers.set(key, []);
  buffers.get(key).push(JSON.stringify(record) + '\n');
  scheduleFlush(key, engineId, missionId);
}

// Forces any buffered lines for a mission out immediately, e.g. when a
// mission run completes and the caller wants readMission() to see everything.
function flushMission(engineId, missionId) {
  const key = `${engineId}/${missionId}`;
  if (flushTimers.has(key)) {
    clearTimeout(flushTimers.get(key));
    flushTimers.delete(key);
  }
  flush(key, engineId, missionId);
}

function listMissions(engineId) {
  const dir = missionDir(engineId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { missionId: f.slice(0, -6), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
}

// Streams the file line-by-line rather than fs.readFileSync + split, since a
// long mission recording can run to a large number of lines.
function readMission(engineId, missionId) {
  return new Promise((resolve, reject) => {
    const file = missionFile(engineId, missionId);
    if (!fs.existsSync(file)) return resolve([]);
    const readings = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        readings.push(JSON.parse(line));
      } catch (err) {
        console.error(`[twin_core/store] skipping malformed line in ${file}:`, err.message);
      }
    });
    rl.on('close', () => resolve(readings));
    rl.on('error', reject);
  });
}

module.exports = { appendReading, flushMission, listMissions, readMission, DATA_DIR };
