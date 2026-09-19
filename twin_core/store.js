/**
 * twin_core/store.js
 * -----------------------------------------------------------------------
 * Append-only time-series store for recorded missions, stand-in for the
 * master plan's TimescaleDB/InfluxDB layer. Pure filesystem (JSON-Lines),
 * so the demo has zero database/native-dependency footprint on Windows.
 *
 * Layout: <data dir>/<engineId>/<missionId>.jsonl
 * One JSON object per line: { t: <ms epoch>, ...reading }
 *
 * Configuration (environment, read lazily on every call):
 *   TWIN_DATA_DIR                    data directory (default: twin_core/data)
 *   TWIN_MAX_MISSIONS_PER_ENGINE     recordings kept per engine (default 50,
 *                                    oldest deleted first)
 *   TWIN_MAX_READINGS_PER_MISSION    readings kept per recording (default
 *                                    50000; further appends are dropped)
 *
 * engineId / missionId typically originate in URL params, so both are
 * validated against /^[A-Za-z0-9_-]{1,64}$/ (plus a Windows-reserved-name
 * check) and every resolved path is verified to stay inside the data dir.
 * -----------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_MAX_MISSIONS_PER_ENGINE = 50;
const DEFAULT_MAX_READINGS_PER_MISSION = 50000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Windows treats these as devices regardless of extension ("CON.jsonl" opens the console).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Buffered per-file writers: readings arrive on every sim tick, so we batch
// them and flush on an interval (or when the batch gets large) instead of
// doing a fs write per reading. Flushes are synchronous open/write/close
// calls: strictly ordered (no interleaved async appends), no file
// descriptors left open, and readMission() right after flushMission() always
// sees the data.
const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFERED_LINES = 2000;
const IDLE_STATE_TTL_MS = 5 * 60 * 1000;
const states = new Map(); // key `${engineId}/${missionId}` -> { engineId, missionId, lines[], timer, count, lastAppend }

function dataDir() {
  return path.resolve(process.env.TWIN_DATA_DIR || DEFAULT_DATA_DIR);
}

function positiveIntEnv(name, dflt) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function assertId(name, value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new RangeError(`${name} must match ${ID_PATTERN} (1-64 letters, digits, "_" or "-")`);
  }
  if (WINDOWS_RESERVED.test(value)) throw new RangeError(`${name} "${value}" is a reserved name`);
  return value;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function missionDir(engineId) {
  assertId('engineId', engineId);
  const root = dataDir();
  const dir = path.resolve(root, engineId);
  if (!isInside(root, dir)) throw new RangeError('engineId resolves outside the data directory');
  return dir;
}

function missionFile(engineId, missionId) {
  assertId('missionId', missionId);
  const dir = missionDir(engineId);
  const file = path.resolve(dir, `${missionId}.jsonl`);
  if (!isInside(dir, file)) throw new RangeError('missionId resolves outside the data directory');
  return file;
}

/** Creates (if needed) and returns the data directory. Throws if it can't be created. */
function ensureDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Readiness probe: true if the data directory exists/can be created and a file can be written in it. */
function isWritable() {
  try {
    const dir = ensureDir();
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_err) {
    return false;
  }
}

function countLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let n = 0;
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) if (buf[i] === 10) n++;
    }
    return n;
  } catch (_err) {
    return 0; // missing file: nothing recorded yet
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function getState(engineId, missionId) {
  const key = `${engineId}/${missionId}`;
  let st = states.get(key);
  if (!st) {
    st = { key, engineId, missionId, lines: [], timer: null, count: countLines(missionFile(engineId, missionId)), lastAppend: Date.now(),
      // process.env reads are slow on Windows: resolve the cap once per recording, not per reading
      maxReadings: positiveIntEnv('TWIN_MAX_READINGS_PER_MISSION', DEFAULT_MAX_READINGS_PER_MISSION) };
    states.set(key, st);
  }
  return st;
}

function sweepIdleStates() {
  const cutoff = Date.now() - IDLE_STATE_TTL_MS;
  for (const [key, st] of states) {
    if (!st.lines.length && !st.timer && st.lastAppend < cutoff) states.delete(key);
  }
}

// Keeps only the newest TWIN_MAX_MISSIONS_PER_ENGINE recordings for an
// engine (by mtime), never touching `protectedIds` (recordings being written).
function enforceRetention(engineId, protectedIds = []) {
  const max = positiveIntEnv('TWIN_MAX_MISSIONS_PER_ENGINE', DEFAULT_MAX_MISSIONS_PER_ENGINE);
  const dir = missionDir(engineId);
  let names;
  try { names = fs.readdirSync(dir); } catch (_err) { return 0; }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try { files.push({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }); } catch (_err) { /* vanished */ }
  }
  if (files.length <= max) return 0;
  files.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1)); // oldest first
  const active = new Set(protectedIds.map((id) => `${id}.jsonl`));
  for (const st of states.values()) if (st.engineId === engineId && st.lines.length) active.add(`${st.missionId}.jsonl`);
  let removed = 0;
  for (const f of files) {
    if (files.length - removed <= max) break;
    if (active.has(f.name)) continue;
    try { fs.unlinkSync(path.join(dir, f.name)); removed++; } catch (_err) { /* best effort */ }
  }
  return removed;
}

function flushState(st) {
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  if (!st.lines.length) return;
  const chunk = st.lines.join('');
  st.lines = [];
  let fd;
  try {
    const file = missionFile(st.engineId, st.missionId);
    const isNew = !fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, 'a');
    fs.writeFileSync(fd, chunk); // loops until every byte is written
    if (isNew) enforceRetention(st.engineId, [st.missionId]);
  } catch (err) {
    console.error(`[twin_core/store] flush failed for ${st.key}:`, err.message);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_err) { /* nothing more we can do */ }
    }
  }
}

function scheduleFlush(st) {
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    flushState(st);
    sweepIdleStates();
  }, FLUSH_INTERVAL_MS);
  // don't hold the process open just for a pending flush
  if (st.timer.unref) st.timer.unref();
}

/**
 * Buffers one reading. Returns true if accepted, false if the recording has
 * reached TWIN_MAX_READINGS_PER_MISSION and the reading was dropped.
 */
function appendReading(engineId, missionId, reading) {
  assertId('engineId', engineId);
  assertId('missionId', missionId);
  if (reading === null || typeof reading !== 'object' || Array.isArray(reading)) {
    throw new TypeError('reading must be a plain object');
  }
  const st = getState(engineId, missionId);
  if (st.count >= st.maxReadings) return false;
  st.lines.push(JSON.stringify({ t: Date.now(), ...reading }) + '\n');
  st.count++;
  st.lastAppend = Date.now();
  if (st.lines.length >= MAX_BUFFERED_LINES) flushState(st);
  else scheduleFlush(st);
  return true;
}

// Forces any buffered lines for a mission out immediately, e.g. when a
// mission run completes and the caller wants readMission() to see everything.
// Also applies the per-engine retention cap and releases the mission's
// in-memory bookkeeping.
function flushMission(engineId, missionId) {
  assertId('engineId', engineId);
  assertId('missionId', missionId);
  const st = states.get(`${engineId}/${missionId}`);
  if (st) {
    flushState(st);
    states.delete(st.key);
  }
  enforceRetention(engineId, [missionId]);
}

/** Synchronously flushes every pending buffer (call on graceful shutdown). */
function flushAll() {
  for (const st of states.values()) flushState(st);
  states.clear();
}

function listMissions(engineId) {
  const dir = missionDir(engineId);
  let names;
  try { names = fs.readdirSync(dir); } catch (_err) { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const stat = fs.statSync(path.join(dir, f));
      if (!stat.isFile()) continue;
      out.push({ missionId: f.slice(0, -6), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch (_err) { /* deleted between readdir and stat */ }
  }
  return out;
}

/**
 * Async generator streaming one parsed reading at a time. Blank, corrupt,
 * partially-written (e.g. a crash mid-line) and non-object lines are skipped.
 */
async function* iterateMission(engineId, missionId) {
  const file = missionFile(engineId, missionId);
  const pending = states.get(`${engineId}/${missionId}`);
  if (pending) flushState(pending); // read-your-writes for a recording still being written
  if (!fs.existsSync(file)) return;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let skipped = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_err) { skipped++; continue; }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { skipped++; continue; }
      yield obj;
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return; // deleted (retention) while reading
    throw err;
  } finally {
    rl.close();
    input.destroy();
    if (skipped) console.warn(`[twin_core/store] skipped ${skipped} malformed line(s) in ${path.basename(file)}`);
  }
}

// Streams the file line-by-line rather than fs.readFileSync + split. Resolves
// to [] for an unknown mission; rejects with RangeError on an invalid id.
async function readMission(engineId, missionId) {
  const readings = [];
  for await (const r of iterateMission(engineId, missionId)) readings.push(r);
  return readings;
}

module.exports = {
  appendReading,
  flushMission,
  flushAll,
  listMissions,
  readMission,
  iterateMission,
  ensureDir,
  isWritable,
  assertId,
  ID_PATTERN,
  get DATA_DIR() { return dataDir(); },
};
