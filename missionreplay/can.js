/**
 * missionreplay/can.js
 * -----------------------------------------------------------------------
 * Artificial CAN bus (J1939-flavoured) for the Aeropiston simulation.
 *
 * The real engine had no CAN fabric, so this synthesises one: deterministic
 * 29-bit extended frames carrying each telemetry signal as a J1939-like PGN
 * with documented byte scaling (uint16, LSB byte 2, MSB byte 3), plus an
 * in-memory ring buffer that behaves like a bus capture (frame stats,
 * per-node roles, window queries).
 *
 * Determinism: same frames for the same input sample; the only state is the
 * frame sequence counter, which advances deterministically.
 * -----------------------------------------------------------------------
 */

'use strict';

const J1939_PRIO = 6;

// J1939-style PGN registry for the artificial bus. One PGN per signal keeps
// encode/decode exact and trivially testable. `spn` is a documented suspect
// parameter number; `scale` converts the uint16 field back to engineering
// units.
const PGN_MAP = {
  engine_speed: { pgn: 0xf004, name: 'ENGINE_SPEED', spn: 190, unit: 'rpm', scale: 0.125, node: 'ecu' },
  cht: { pgn: 0xfeee, name: 'ENGINE_TEMP_1', spn: 110, unit: 'degC', scale: 1, node: 'thermal' },
  egt: { pgn: 0xff10, name: 'EXHAUST_GAS_TEMP', spn: 101560, unit: 'degC', scale: 1, node: 'thermal' },
  oil_temp: { pgn: 0xff15, name: 'OIL_TEMP', spn: 175, unit: 'degC', scale: 1, node: 'oilsys' },
  oil_pressure: { pgn: 0xfeeb, name: 'ENGINE_FLUID_PRESSURE', spn: 100, unit: 'kPa', scale: 1, node: 'oilsys' },
  fuel_flow: { pgn: 0xfef2, name: 'FUEL_ECONOMY', spn: 182, unit: 'L/h', scale: 0.01, node: 'fuelsys' },
  fuel_remaining: { pgn: 0xfef5, name: 'FUEL_LEVEL', spn: 96, unit: 'L', scale: 1, node: 'fuelsys' },
  vibration: { pgn: 0xff11, name: 'VIBRATION', spn: 101561, unit: 'mm/s', scale: 0.01, node: 'mems' },
  mixture_ratio: { pgn: 0xff12, name: 'MIXTURE_RATIO', spn: 101562, unit: 'ratio', scale: 0.01, node: 'ecu' },
  throttle: { pgn: 0xff13, name: 'THROTTLE', spn: 101563, unit: '%', scale: 0.125, node: 'ecu' },
  fault_flag: { pgn: 0xff14, name: 'FAULT_FLAG', spn: 101564, unit: 'count', scale: 1, node: 'ecu' },
};

const NODE_TABLE = [
  { id: 0x00, name: 'ecu', label: 'Engine control unit', sends: { engine_speed: true, mixture_ratio: true, throttle: true, fault_flag: true } },
  { id: 0x01, name: 'oilsys', label: 'Oil pressure / temp gauge', sends: { oil_pressure: true, oil_temp: true } },
  { id: 0x02, name: 'thermal', label: 'CHT / EGT module', sends: { cht: true, egt: true } },
  { id: 0x03, name: 'fuelsys', label: 'Fuel flow / level gauge', sends: { fuel_flow: true, fuel_remaining: true } },
  { id: 0x04, name: 'mems', label: 'Vibration MEMS node', sends: { vibration: true } },
];

// Engineering-unit envelope per signal (used to clamp uint16 fields).
const REF_ENVELOPE = {
  engine_speed: [600, 3000],
  cht: [60, 295],
  egt: [400, 950],
  oil_temp: [30, 175],
  oil_pressure: [80, 500],
  fuel_flow: [0, 60],
  fuel_remaining: [0, 9999],
  vibration: [0.1, 14],
  mixture_ratio: [10, 17],
  throttle: [0, 100],
  fault_flag: [0, 255],
};

function clamp(v, lo, hi) {
  if (v !== v) return hi; // NaN -> max (signals overrange)
  return Math.max(lo, Math.min(hi, v));
}

function uint16(v, scale, lo, hi) {
  const raw = Math.round(clamp(v, lo, hi) / scale);
  return Math.max(0, Math.min(0xffff, raw));
}

function float16(raw, scale) {
  return Math.round(raw * scale * 100) / 100;
}

/** Deterministic 29-bit CAN id: bits 28-26 prio, 25-8 PGN, 7-0 source. */
function arbitrationId(prio, pgn, src) {
  return ((prio & 0x7) << 26) | ((pgn & 0x3ffff) << 8) | (src & 0xff);
}

function nodeIdOf(node) {
  const n = NODE_TABLE.find((x) => x.name === node);
  return n ? n.id : 0xff;
}

function flatSample(sample) {
  return {
    engine_speed: (sample.mechanical && sample.mechanical.rpm) || 0,
    cht: (sample.thermal && sample.thermal.cht_c) || 0,
    egt: (sample.thermal && sample.thermal.egt_c) || 0,
    oil_temp: (sample.thermal && sample.thermal.oil_temp_c) || 0,
    oil_pressure: (sample.mechanical && sample.mechanical.oil_pressure_kpa) || 0,
    fuel_flow: (sample.fuel && sample.fuel.fuel_flow_lph) || 0,
    fuel_remaining: (sample.fuel && sample.fuel.fuel_remaining_l) || 0,
    vibration: (sample.mechanical && sample.mechanical.vibration_mm_s) || 0,
    mixture_ratio: (sample.fuel && sample.fuel.mixture_ratio) || 0,
    throttle: (sample.flight && sample.flight.throttle_pct) || 0,
    fault_flag: (sample.fault_flags && sample.fault_flags.length) || 0,
  };
}

/**
 * Encode one §3.2 telemetry sample into an ordered list of J1939 frames.
 * Returns { frames, nextSeq } where nextSeq continues the sequence counter.
 */
function encodeSample(sample, tsMs, seq) {
  const frames = [];
  const flat = flatSample(sample);
  for (const signal of Object.keys(PGN_MAP)) {
    const def = PGN_MAP[signal];
    const [lo, hi] = REF_ENVELOPE[signal] || [0, 0xffff];
    const raw = uint16(flat[signal], def.scale, lo, hi);
    const data = [
      0, 0, // SPN low byte, SPN high byte
      (raw >> 8) & 0xff,
      raw & 0xff,
      0xff, 0xff, // unused slots
      (seq >> 8) & 0xff,
      seq & 0xff,
    ];
    const id = arbitrationId(J1939_PRIO, def.pgn, nodeIdOf(def.node));
    frames.push({
      tsMs,
      id,
      hex: '0x' + id.toString(16).padStart(8, '0').toUpperCase(),
      prio: J1939_PRIO,
      src: nodeIdOf(def.node),
      dst: 0xff,
      pgn: def.pgn,
      pgnHex: '0x' + def.pgn.toString(16).toUpperCase().padStart(4, '0'),
      name: def.name,
      spn: def.spn,
      signal,
      unit: def.unit,
      data,
    });
    seq = (seq + 1) & 0xffffffff;
  }
  return { frames, nextSeq: seq };
}

/**
 * Decode a set of captured frames back into { spn: value } (round-trip and
 * HTTP status exposure). One SPN per frame by construction.
 */
function decodeFrames(frames) {
  const out = {};
  const byPgn = {};
  for (const key of Object.keys(PGN_MAP)) byPgn[PGN_MAP[key].pgn] = PGN_MAP[key];
  for (const frame of frames) {
    const raw = (frame.data[2] << 8) | frame.data[3];
    const def = byPgn[frame.pgn];
    if (def) out[def.spn] = float16(raw, def.scale);
  }
  return out;
}

/**
 * The artificial bus itself.
 *   bus.send(frame)                   append one frame + stats (no encode)
 *   bus.publishSample(sample, tMs)    encode + append that sample's frames
 *   bus.frames                        ring buffer (oldest evicted)
 *   bus.status()                      { nodes, stats, last, sequence }
 *   bus.window(startMs, endMs)        subset by tsMs
 */
function createCanBus(opts) {
  const o = opts || {};
  const capacity = o.capacity || 4096;
  const frames = [];
  const stats = { sent: 0, dropped: 0, byPgn: {}, firstTsMs: null, lastTsMs: null };
  let seq = o.baseSeq || 0;

  function append(frame) {
    if (stats.firstTsMs === null) stats.firstTsMs = frame.tsMs;
    stats.lastTsMs = frame.tsMs;
    stats.sent += 1;
    stats.byPgn[frame.pgn] = (stats.byPgn[frame.pgn] || 0) + 1;
    if (frames.length >= capacity) {
      const dropped = frames.shift();
      stats.dropped += 1;
      stats.byPgn[dropped.pgn] = (stats.byPgn[dropped.pgn] || 0) - 1;
    }
    frames.push(frame);
  }

  return {
    capacity,
    frames,
    stats,
    send(frame) {
      const f = Object.assign({}, frame, {
        tsMs: frame.tsMs !== undefined ? frame.tsMs : stats.lastTsMs || 0,
      });
      append(f);
      return f;
    },
    publishSample(sample, tMs) {
      const enc = encodeSample(sample, tMs !== undefined ? tMs : sample.t_s * 1000, seq);
      for (const f of enc.frames) append(f);
      seq = enc.nextSeq;
      return enc.frames;
    },
    window(startMs, endMs) {
      return frames.filter((f) => f.tsMs >= startMs && f.tsMs <= endMs);
    },
    status() {
      const last = frames[frames.length - 1] || null;
      return {
        protocol: 'j1939-29bit-sim',
        capacity,
        nodes: NODE_TABLE.map((n) => ({ id: n.id, name: n.name, label: n.label, sends: Object.keys(n.sends) })),
        pgnCount: Object.keys(PGN_MAP).length,
        stats: Object.assign({}, stats, { byPgn: Object.assign({}, stats.byPgn) }),
        last,
        sequence: seq,
      };
    },
  };
}

/** Deterministic FNV-1a hash for seeding anything from a mission id string. */
function seedFromString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

module.exports = {
  J1939_PRIO,
  PGN_MAP,
  NODE_TABLE,
  REF_ENVELOPE,
  createCanBus,
  encodeSample,
  decodeFrames,
  arbitrationId,
  seedFromString,
};