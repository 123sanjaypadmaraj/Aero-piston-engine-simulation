/**
 * missionreplay/loader.js
 * -----------------------------------------------------------------------
 * Loads a generated mission directory back into an indexable record
 * (spec §4.1 'Mission Loader').
 *
 * Responsibilities:
 *   - schema_version gate: reject manifests this reader does not understand
 *   - build the telemetry.idx byte-offset table (or scan the log if absent)
 *   - O(1) seek: line number -> byte offset -> single-line JSON read
 *   - expose phase + fault structure queries needed by the replay engine
 * -----------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { SCHEMA_VERSION } = require('./profiles');

function openLineReader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    fd,
    size,
    readLineAt(offset) {
      // read up to the next newline from offset, bounded to the file size
      const chunk = Math.min(2048, size - offset);
      if (chunk <= 0) return null;
      const buf = Buffer.alloc(chunk);
      const n = fs.readSync(fd, buf, 0, chunk, offset);
      let end = buf.indexOf(0x0a);
      if (end === -1) end = n;
      return buf.toString('utf8', 0, end).trim();
    },
    close() { fs.closeSync(fd); },
  };
}

function readIdx(fn) {
  if (!fs.existsSync(fn)) return null;
  const txt = fs.readFileSync(fn, 'utf8');
  const offsets = [];
  for (const line of txt.split('\n')) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    const v = Number(cleaned);
    if (Number.isFinite(v)) offsets.push(v);
  }
  return offsets;
}

/** Rebuild a byte-offset table by scanning the log (fallback, no .idx). */
function buildIdxFromLog(fn) {
  const offsets = [];
  const fd = fs.openSync(fn, 'r');
  let pos = 0;
  const buf = Buffer.alloc(8192);
  let carry = Buffer.alloc(0);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    const chunk = Buffer.concat([carry, buf.subarray(0, n)]);
    let start = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] === 0x0a) {
        offsets.push(pos + start);
        start = i + 1;
      }
    }
    carry = chunk.subarray(start);
    pos += n;
  }
  fs.closeSync(fd);
  return offsets;
}

function loadCanLines(dir) {
  const fn = path.join(dir, 'can.jsonl');
  if (!fs.existsSync(fn)) return null;
  const out = [];
  for (const line of fs.readFileSync(fn, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { out.push(null); }
  }
  return out;
}

/**
 * Load a mission directory.
 * @param {string} dir absolute path to the mission folder
 */
function loadMission(dir) {
  const manFn = path.join(dir, 'manifest.json');
  const telFn = path.join(dir, 'telemetry.jsonl');
  const fauFn = path.join(dir, 'faults.json');
  for (const f of [manFn, telFn]) {
    if (!fs.existsSync(f)) throw new Error(`mission dir missing ${path.basename(f)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manFn, 'utf8'));
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported mission schema_version '${manifest.schema_version}' (reader supports '${SCHEMA_VERSION}')`,
    );
  }
  const rate = Number(manifest.sample_rate_hz) || 1;
  let offsets = readIdx(path.join(dir, 'telemetry.idx'));
  if (!offsets) offsets = buildIdxFromLog(telFn);
  const sampleCount = offsets.length;
  const faults = fs.existsSync(fauFn) ? JSON.parse(fs.readFileSync(fauFn, 'utf8')) : [];
  const can = loadCanLines(dir);
  const reader = openLineReader(telFn);

  const firstSample = sampleCount ? JSON.parse(reader.readLineAt(offsets[0])) : null;
  const t0 = firstSample ? firstSample.t_s : 0;

  function lineForT(t) {
    if (sampleCount === 0) return -1;
    return Math.round((t - t0) * rate);
  }

  function sampleAtLine(i) {
    if (i < 0 || i >= sampleCount) return null;
    const line = reader.readLineAt(offsets[i]);
    return line ? JSON.parse(line) : null;
  }

  function sampleAt(t) {
    const i = lineForT(t);
    return i >= 0 && i < sampleCount ? sampleAtLine(i) : null;
  }

  return {
    dir,
    missionId: manifest.mission_id,
    manifest,
    schemaVersion: manifest.schema_version,
    sampleCount,
    rate,
    t0,
    duration: manifest.duration_s,
    phases: manifest.profile_phases || [],
    faults,
    can,
    hasIdx: Boolean(offsets && fs.existsSync(path.join(dir, 'telemetry.idx'))),
    faultsById: faultIndexById(faults),
    lineForT,
    sampleCountOf: () => sampleCount,
    sampleAtLine,
    sampleAt,
    activeFaultsAt(t) {
      return faults.filter((f) =>
        (f.injected && t >= f.onset_s && (f.resolved_s === null || t < f.resolved_s)) ||
        (!f.injected && t >= f.onset_s && (f.resolved_s === null || t < f.resolved_s)),
      );
    },
    precursorFaultsAt(t) {
      return faults.filter((f) =>
        f.precursor_window_s && t >= f.precursor_window_s[0] && t < f.precursor_window_s[1],
      );
    },
    faultsSpanning(t) {
      return faults.filter((f) => t >= f.onset_s && (f.resolved_s === null || t < f.resolved_s));
    },
    readRangeLines(startLine, endLine) {
      const lo = Math.max(0, startLine);
      const hi = Math.min(sampleCount - 1, endLine);
      const out = [];
      for (let i = lo; i <= hi; i += 1) out.push(sampleAtLine(i));
      return out;
    },
    readRange(tStart, tEnd) {
      return this.readRangeLines(lineForT(tStart), lineForT(tEnd));
    },
    close() { reader.close(); },
  };
}

function faultIndexById(faults) {
  const m = new Map();
  for (const f of faults) m.set(f.fault_id, f);
  return m;
}

module.exports = { loadMission, readIdx, buildIdxFromLog };