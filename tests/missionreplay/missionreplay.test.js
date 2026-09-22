/**
 * tests/missionreplay/missionreplay.test.js
 * ---------------------------------------------------------------------------
 * Tests for the mission replay + artificial CAN system (missionreplay/).
 * Covers: deterministic generation, log schema, phase/transition physics,
 * fault injection + detection, loader/seek, replay engine (interpolation,
 * fault-boundary snap, anomaly tiers, play/pause/step) and the CAN bus.
 *
 * Most tests run on a condensed 6000 s / 1 Hz schedule so the suite stays
 * fast; a few dedicated tests exercise the full 21600 s default profile.
 * ---------------------------------------------------------------------------
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mr = require('../../missionreplay');
const { generator, loader, replay, can, faultLib } = mr;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-test-'));

// Condensed schedule: all 7 phases, quickly.
const COND_PHASES = [
  { phase: 'taxi', start_s: 0, end_s: 60 },
  { phase: 'takeoff', start_s: 60, end_s: 100 },
  { phase: 'climb', start_s: 100, end_s: 600 },
  { phase: 'cruise', start_s: 600, end_s: 2000 },
  { phase: 'loiter', start_s: 2000, end_s: 5000 },
  { phase: 'descent', start_s: 5000, end_s: 5600 },
  { phase: 'landing', start_s: 5600, end_s: 6000 },
];

// Onsets tuned to the condensed schedule (all land inside cruise/loiter).
const FULL_FAULTS = [
  { type: 'vibration_anomaly', onset_s: 300, severity: 'severe', duration_s: 540 },
  { type: 'oil_pressure_degradation', onset_s: 1000, severity: 'moderate', duration_s: 900 },
  { type: 'fuel_starvation', onset_s: 1800, severity: 'severe', duration_s: 720 },
  { type: 'sensor_dropout', onset_s: 2500, duration_s: 240 },
];

function gen(name, opts) {
  return generator.generateMission(Object.assign({
    missionId: name,
    outDir: path.join(TMP, 'missions'),
    duration: 6000,
    phases: COND_PHASES,
    faults: FULL_FAULTS,
  }, opts || {}));
}

function openReplay(name, opts) {
  const r = gen(name, opts);
  return replay.createReplay(loader.loadMission(r.dir));
}

function sampleForCan() {
  return {
    t_s: 10,
    phase: 'cruise',
    flight: { altitude_m: 4800, airspeed_ms: 42, throttle_pct: 65 },
    mechanical: { rpm: 2316, vibration_mm_s: 1.89, oil_pressure_kpa: 387 },
    thermal: { egt_c: 746, cht_c: 205, oil_temp_c: 93 },
    fuel: { fuel_flow_lph: 18.42, mixture_ratio: 14.39, fuel_remaining_l: 300 },
    fault_flags: [],
  };
}

// ---------------------------------------------------------------------------
// Generation determinism & reproducibility
// ---------------------------------------------------------------------------

test('same inputs regenerate byte-identical logs', () => {
  const opts = { recordCan: true };
  const a = gen('DET-A', opts);
  const b = gen('DET-A', opts);
  for (const f of ['telemetry.jsonl', 'manifest.json', 'faults.json', 'telemetry.idx', 'can.jsonl']) {
    assert.equal(
      fs.readFileSync(path.join(a.dir, f), 'utf8'),
      fs.readFileSync(path.join(b.dir, f), 'utf8'),
      `file ${f} differs across runs`,
    );
  }
  assert.equal(a.seed, b.seed);
  assert.deepEqual(a.faults, b.faults);
});

test('different mission ids produce different logs', () => {
  const a = gen('DET-B1');
  const b = gen('DET-B2');
  assert.notEqual(
    fs.readFileSync(path.join(a.dir, 'telemetry.jsonl'), 'utf8'),
    fs.readFileSync(path.join(b.dir, 'telemetry.jsonl'), 'utf8'),
  );
});

test('an explicit seed forces identical output regardless of mission id', () => {
  const a = gen('DET-C1', { seed: 42 });
  const b = gen('DET-C2', { seed: 42 });
  assert.equal(
    fs.readFileSync(path.join(a.dir, 'telemetry.jsonl'), 'utf8'),
    fs.readFileSync(path.join(b.dir, 'telemetry.jsonl'), 'utf8'),
  );
});

test('invalid mission id is rejected', () => {
  assert.throws(() => generator.generateMission({ missionId: 'bad id!' }), /missionId/);
  assert.throws(() => generator.generateMission(), /missionId/);
});

// ---------------------------------------------------------------------------
// Manifest & log schema
// ---------------------------------------------------------------------------

test('manifest carries spec fields', () => {
  const r = gen('MANIFEST-1', { duration: 21600, phases: undefined });
  const m = r.manifest;
  assert.equal(m.schema_version, '1.0');
  assert.equal(m.mission_id, 'MANIFEST-1');
  assert.equal(m.uav_type, 'MALE');
  assert.equal(m.engine_model, 'Aeropiston-4C-115hp-Sim');
  assert.equal(m.sample_rate_hz, 1);
  assert.equal(m.duration_s, 21600);
  assert.equal(m.sample_count, 21600);
  assert.equal(m.transition_window_s, 15);
  assert.ok(Array.isArray(m.profile_phases));
  assert.equal(m.profile_phases[0].phase, 'taxi');
  assert.equal(m.profile_phases.length, 7);
});

test('telemetry log has one sample per second with grouped shape', () => {
  const r = gen('SCHEMA-1');
  const rec = loader.loadMission(r.dir);
  assert.equal(rec.sampleCount, 6000);
  const s = rec.sampleAtLine(700); // cruise
  assert.ok(Array.isArray(s.fault_flags));
  for (const g of ['flight', 'mechanical', 'thermal', 'fuel']) {
    assert.equal(typeof s[g], 'object');
    for (const k of Object.keys(s[g])) assert.equal(typeof s[g][k], 'number');
  }
  assert.ok(s.mechanical.rpm > 1800 && s.mechanical.rpm < 2900);
  assert.equal(s.phase, 'cruise');
  assert.ok(Number.isFinite(s.t_s));
});

test('idx seek returns the same sample as direct reads', () => {
  const r = gen('IDX-1');
  const rec = loader.loadMission(r.dir);
  assert.ok(rec.hasIdx);
  const viaIdx = rec.sampleAt(1307);
  const viaLine = rec.sampleAtLine(rec.lineForT(1307));
  assert.deepEqual(viaIdx, viaLine);
  assert.equal(viaIdx.t_s, 1307);
  assert.equal(viaIdx.phase, 'cruise');
});

test('unsupported schema version is rejected by loader', () => {
  const r = gen('SCHEMA-BAD');
  const man = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
  man.schema_version = '999.0';
  fs.writeFileSync(path.join(r.dir, 'manifest.json'), JSON.stringify(man));
  assert.throws(() => loader.loadMission(r.dir), /schema_version/);
});

// ---------------------------------------------------------------------------
// Phase behaviour & transitions
// ---------------------------------------------------------------------------

test('phases line up with the schedule', () => {
  const r = gen('PHASE-1');
  const rec = loader.loadMission(r.dir);
  assert.equal(rec.sampleAt(0).phase, 'taxi');
  assert.equal(rec.sampleAt(80).phase, 'takeoff');
  assert.equal(rec.sampleAt(300).phase, 'climb');
  assert.equal(rec.sampleAt(1000).phase, 'cruise');
  assert.equal(rec.sampleAt(3000).phase, 'loiter');
  assert.equal(rec.sampleAt(5300).phase, 'descent');
  assert.equal(rec.sampleAt(5800).phase, 'landing');
});

test('phase transitions are eased, not instantaneous', () => {
  const r = gen('TRANS-1');
  const rec = loader.loadMission(r.dir);
  // takeoff target rpm 2780; right after taxi->takeoff the rpm must still be
  // low (15s ease window + lag), then climb toward 2780.
  const early = rec.sampleAt(62).mechanical.rpm;
  const peak = rec.sampleAt(97).mechanical.rpm;
  assert.ok(early < 1700, `expected eased start, got ${early}`);
  assert.ok(peak > 2400, `expected approach to takeoff rpm, got ${peak}`);
});

test('thermal params lag mechanical ones (no instant jump anywhere)', () => {
  const r = gen('LAG-1');
  const rec = loader.loadMission(r.dir);
  const lines = rec.readRangeLines(0, rec.sampleCount - 1);
  let maxJump = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const d = Math.abs(lines[i].thermal.cht_c - lines[i - 1].thermal.cht_c);
    if (d > maxJump) maxJump = d;
  }
  // a raw phase snap would move CHT ~130 C in one second; eased blend + lag
  // plus Gaussian noise (±4 C each sample) keeps per-second swings well below
  // that even on the hottest ramp (taxi 100 -> takeoff 230).
  assert.ok(maxJump < 30, `cht jumped ${maxJump}C in one second`);
  // and the rise is gradual: a few seconds into takeoff CHT is still cool
  assert.ok(rec.sampleAt(63).thermal.cht_c < 150, 'cht should still be easing up');
});

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

test('injected faults appear in events with onset/detected/resolved', () => {
  const r = gen('EVENT-1');
  const byType = {};
  for (const f of r.faults) byType[f.type] = f;
  const oil = byType.oil_pressure_degradation;
  assert.ok(oil);
  assert.equal(oil.injected, true);
  assert.equal(oil.onset_s, 1000);
  assert.ok(oil.detected_s >= oil.onset_s, 'detected must come after onset');
  assert.equal(oil.resolved_s, 1000 + 900);
  assert.ok(Array.isArray(oil.precursor_window_s));
  assert.equal(oil.precursor_window_s[1], 1000);
  assert.ok(oil.precursor_window_s[0] <= 1000);
  assert.equal(oil.precursor_window_s[1] - oil.precursor_window_s[0], 60);
  assert.deepEqual(oil.affected_parameters, ['oil_pressure_kpa', 'oil_temp_c']);
  assert.match(oil.fault_id, /FLT-\d{4}/);
  assert.ok(byType.sensor_dropout);
  assert.equal(byType.sensor_dropout.detected_s, 2500);
});

test('fault flags only on samples inside the fault window', () => {
  const r = gen('FLAGS-1');
  const rec = loader.loadMission(r.dir);
  const before = rec.sampleAt(995);
  const during = rec.sampleAt(1050);
  const after = rec.sampleAt(2750); // after all injected windows have resolved
  assert.equal(before.fault_flags.length, 0);
  const fid = r.faults.find((f) => f.type === 'oil_pressure_degradation').fault_id;
  assert.ok(during.fault_flags.includes(fid));
  assert.equal(after.fault_flags.length, 0);
});

test('fault overlay degrades the affected parameter', () => {
  const r = gen('EFFECT-1');
  const rec = loader.loadMission(r.dir);
  const degraded = rec.sampleAt(1100).mechanical.oil_pressure_kpa;
  const healthy = rec.sampleAt(700).mechanical.oil_pressure_kpa;
  assert.ok(degraded < healthy, `expected pressure drop, got ${degraded} vs ${healthy}`);
  const flow = rec.sampleAt(2000).fuel.fuel_flow_lph;
  assert.ok(flow < 8, `expected starved fuel flow, got ${flow}`);
});

test('sensor dropout writes the overrange marker', () => {
  const r = gen('DROP-1');
  const rec = loader.loadMission(r.dir);
  assert.equal(rec.sampleAt(2510).thermal.egt_c, faultLib.OVERRANGE_SENSOR);
  assert.ok(rec.sampleAt(2400).thermal.egt_c > 0);
});

test('no false-positive emergent faults in a clean run', () => {
  const r = gen('CLEAN-1', { faults: [] });
  assert.deepEqual(r.faults, []);
});

// ---------------------------------------------------------------------------
// Mission replay engine
// ---------------------------------------------------------------------------

test('stateAt interpolates between samples', () => {
  const pl = openReplay('INTERP-1', { duration: 60, phases: [{ phase: 'cruise', start_s: 0, end_s: 60 }], faults: [] });
  pl.seek(10);
  const at10 = pl.stateAt(10).mechanical.rpm;
  const at11 = pl.stateAt(11).mechanical.rpm;
  const mid = pl.stateAt(10.5).mechanical.rpm;
  assert.ok(mid > Math.min(at10, at11) && mid < Math.max(at10, at11),
    `mid ${mid} should sit between ${at10} and ${at11}`);
});

test('replay snaps across a fault onset boundary instead of blending', () => {
  const pl = openReplay('SNAP-1', {
    sampleRateHz: 2,
    duration: 60,
    phases: [{ phase: 'cruise', start_s: 0, end_s: 60 }],
    faults: [{ type: 'oil_pressure_degradation', onset_s: 30.25, severity: 'moderate', duration_s: 30 }],
  });
  const healthy = pl.stateAt(30.0).mechanical.oil_pressure_kpa;    // pre-onset record
  const postSample = pl.stateAt(30.5).mechanical.oil_pressure_kpa; // post-onset record
  const snapped = pl.stateAt(30.25).mechanical.oil_pressure_kpa;   // boundary is inside this span
  assert.equal(Math.round(snapped * 10) / 10, Math.round(postSample * 10) / 10);
  assert.notEqual(Math.round(snapped * 10) / 10,
    Math.round(((healthy + postSample) / 2) * 10) / 10,
    'boundary must not be blended');
  assert.equal(pl.stateAt(30.25).anomaly.tier, 'active');
});

test('anomaly overlay: nominal, precursor, active tiers', () => {
  const pl = openReplay('TIER-1', {
    duration: 3000,
    phases: [{ phase: 'loiter', start_s: 0, end_s: 3000 }],
    faults: [{ type: 'oil_pressure_degradation', onset_s: 1000, severity: 'moderate', duration_s: 900 }],
  });
  assert.equal(pl.stateAt(900).anomaly.tier, 'nominal');
  assert.equal(pl.stateAt(960).anomaly.tier, 'precursor');
  assert.deepEqual(pl.stateAt(960).anomaly.precursor, ['FLT-0001']);
  assert.equal(pl.stateAt(1001).anomaly.tier, 'active');
  assert.deepEqual(pl.stateAt(1001).anomaly.active, ['FLT-0001']);
  assert.equal(pl.stateAt(2001).anomaly.tier, 'nominal'); // resolved at 1900
});

test('activeFaultsAt and precursorFaultsAt return specs', () => {
  const pl = openReplay('FAULTQ-1', {
    duration: 3000,
    phases: [{ phase: 'loiter', start_s: 0, end_s: 3000 }],
    faults: [{ type: 'oil_pressure_degradation', onset_s: 1000, severity: 'moderate', duration_s: 900 }],
  });
  const act = pl.activeFaultsAt(1100);
  assert.equal(act.length, 1);
  assert.equal(act[0].type, 'oil_pressure_degradation');
  assert.equal(pl.precursorFaultsAt(990)[0].type, 'oil_pressure_degradation');
  assert.equal(pl.precursorFaultsAt(1001).length, 0);
});

test('seek moves the playhead and returns state', () => {
  const pl = openReplay('SEEK-1');
  const st = pl.seek(3000);
  assert.equal(st.t_s, 3000);
  assert.equal(st.phase, 'loiter');
  assert.equal(pl.snapshot().t_s, 3000);
});

test('get_range returns a strided slice', () => {
  const pl = openReplay('RANGE-1');
  const small = pl.getRange(0, 6000, { maxSamples: 100 });
  assert.ok(small.length <= 101);
  assert.equal(small[0].t_s, 0);
  assert.equal(small[small.length - 1].t_s, 6000);
});

test('step advances the playhead by n samples', () => {
  const pl = openReplay('STEP-1');
  pl.seek(10);
  const st = pl.step(5);
  assert.equal(st.t_s, 15);
});

test('stateAt can attach CAN frames when the log has them', () => {
  const r = gen('STCAN-1', {
    duration: 60,
    phases: [{ phase: 'cruise', start_s: 0, end_s: 60 }],
    faults: [],
    recordCan: true,
  });
  const pl = replay.createReplay(loader.loadMission(r.dir));
  const st = pl.stateAt(15);
  assert.ok(Array.isArray(st.can));
  assert.ok(st.can.length > 0);
  assert.ok(st.can.some((f) => f.pgn === can.PGN_MAP.engine_speed.pgn));
});

test('play emits frames and pause stops it', async () => {
  const pl = openReplay('PLAY-1', { duration: 60, phases: [{ phase: 'cruise', start_s: 0, end_s: 60 }], faults: [] });
  const seen = [];
  pl.play(500, (state) => seen.push(state.t_s));
  await new Promise((res) => setTimeout(res, 60));
  pl.pause();
  const atPause = pl.snapshot();
  assert.ok(seen.length > 0, 'play should emit frames');
  assert.ok(atPause.t_s > 0);
  pl.stop();
});

// ---------------------------------------------------------------------------
// Artificial CAN bus
// ---------------------------------------------------------------------------

test('CAN encodes one frame per registered signal', () => {
  const SAMPLE = sampleForCan();
  const bus = can.createCanBus({ seed: 7 });
  const frames = bus.publishSample(SAMPLE, 10000);
  assert.equal(frames.length, Object.keys(can.PGN_MAP).length);
  for (const f of frames) {
    assert.equal(f.prio, 6);
    assert.equal(f.dst, 0xff);
    assert.ok(f.id > 0x18000000 && f.id < 0x1fffffff, '29-bit extended id');
    assert.equal(f.data.length, 8);
    assert.match(f.hex, /^0x[0-9A-F]{8}$/);
  }
  const names = frames.map((f) => f.name);
  assert.ok(names.includes('ENGINE_SPEED'));
  assert.ok(names.includes('VIBRATION'));
});

test('CAN encode -> decode round-trips engineering values', () => {
  const SAMPLE = sampleForCan();
  const bus = can.createCanBus({});
  const frames = bus.publishSample(SAMPLE, 0);
  const decoded = can.decodeFrames(frames);
  assert.ok(Math.abs(decoded[190] - SAMPLE.mechanical.rpm) < 1, 'rpm spn 190');
  assert.ok(Math.abs(decoded[101561] - SAMPLE.mechanical.vibration_mm_s) < 0.01, 'vibration');
  assert.ok(Math.abs(decoded[182] - SAMPLE.fuel.fuel_flow_lph) < 0.01, 'fuel flow');
  assert.ok(Math.abs(decoded[110] - SAMPLE.thermal.cht_c) < 1, 'cht');
  assert.ok(Math.abs(decoded[96] - SAMPLE.fuel.fuel_remaining_l) < 1, 'fuel level');
});

test('CAN is deterministic for identical input', () => {
  const SAMPLE = sampleForCan();
  const b1 = can.createCanBus({ seed: 1 });
  const b2 = can.createCanBus({ seed: 1 });
  const f1 = b1.publishSample(SAMPLE, 5000);
  const f2 = b2.publishSample(SAMPLE, 5000);
  assert.deepEqual(f1, f2);
  const per = Object.keys(can.PGN_MAP).length;
  const f3 = b1.publishSample(SAMPLE, 6000); // second batch for b1
  assert.equal(f3[0].data[7], per & 0xff); // seq counter advanced one batch
});

test('CAN status reports nodes, stats and last frame', () => {
  const SAMPLE = sampleForCan();
  const bus = can.createCanBus({ capacity: 1000, seed: 2 });
  const per = Object.keys(can.PGN_MAP).length;
  for (let i = 0; i < 5; i += 1) bus.publishSample(SAMPLE, i * 1000);
  const st = bus.status();
  assert.equal(st.protocol, 'j1939-29bit-sim');
  assert.equal(st.nodes.length, 5);
  assert.ok(st.pgnCount >= 10);
  assert.equal(st.stats.sent, 5 * per);
  assert.ok(st.last);
  assert.equal(bus.window(0, 1000).length, 2 * per); // samples at 0s and 1s
});

test('CAN ring buffer evicts oldest frames past capacity', () => {
  const SAMPLE = sampleForCan();
  const bus = can.createCanBus({ capacity: 10, seed: 3 });
  for (let i = 0; i < 20; i += 1) bus.publishSample(SAMPLE, i * 2000);
  assert.ok(bus.stats.dropped > 0);
  assert.ok(bus.frames.length <= 10);
});

// ---------------------------------------------------------------------------
// Error handling / misc
// ---------------------------------------------------------------------------

test('unknown fault type in injection config is rejected', () => {
  assert.throws(() => gen('BAD-FAULT', { faults: [{ type: 'not_a_fault', onset_s: 10 }] }), /unknown fault type/);
});

test('out-of-range onset is rejected', () => {
  assert.throws(
    () => gen('BAD-ONSET', { duration: 100, faults: [{ type: 'overheating', onset_s: 500 }] }),
    /onset_s/,
  );
});