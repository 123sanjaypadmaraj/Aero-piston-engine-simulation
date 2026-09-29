/**
 * tests/server/missionReplay.test.js
 * ---------------------------------------------------------------------------
 * Server-level tests for the mission replay + artificial CAN endpoints
 * (server.js): generate -> manifest/faults/phases/state/range/snapshot/control
 * and /api/can/status, plus validation of bad mission ids and t ranges.
 * ---------------------------------------------------------------------------
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('./helpers');

const MISSION_ID = 'MSN-2026-0001';

describe('mission replay + CAN endpoints', () => {
  let s;
  before(async () => {
    s = await startTestServer({ rateLimit: { windowMs: 60000, max: 10000, heavyMax: 10000 } });
  });
  after(async () => { await s.ctx.stop(); });

  test('generate a small mission with an injected fault', async () => {
    const r = await request(s.port, {
      method: 'POST',
      path: '/api/mission-replay/generate',
      body: {
        missionId: MISSION_ID,
        duration: 120,
        faults: [{ type: 'oil_pressure_degradation', onset_s: 60, severity: 'moderate' }],
      },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.missionId, MISSION_ID);
    assert.equal(r.json.sampleCount, 120);
    assert.equal(r.json.manifest.schema_version, '1.0');
    assert.equal(r.json.manifest.engine_model, 'Aeropiston-4C-115hp-Sim');
    assert.equal(r.json.faultEvents, 1);
  });

  test('manifest, faults and phases endpoints return data', async () => {
    const man = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/manifest` });
    assert.equal(man.status, 200);
    assert.equal(man.json.mission_id, MISSION_ID);
    assert.ok(Array.isArray(man.json.profile_phases));

    const faults = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/faults` });
    assert.equal(faults.status, 200);
    assert.equal(faults.json[0].type, 'oil_pressure_degradation');
    assert.equal(faults.json[0].injected, true);

    const phases = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/phases` });
    assert.equal(phases.status, 200);
    assert.ok(phases.json.length >= 1);
  });

  test('state at a timestamp returns a grouped sample with anomaly overlay', async () => {
    const st = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/state?t_s=70` });
    assert.equal(st.status, 200);
    assert.equal(st.json.t_s, 70);
    assert.ok(st.json.mechanical.rpm > 0);
    assert.equal(st.json.anomaly.tier, 'active');
    assert.ok(st.json.anomaly.active.length === 1);
  });

  test('state outside the mission window is rejected', async () => {
    const r = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/state?t_s=99999` });
    assert.equal(r.status, 400);
  });

  test('range returns a bounded slice and rejects inverted times', async () => {
    const ok = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/range?start_s=0&end_s=10&maxSamples=20` });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.length >= 2);
    const bad = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/range?start_s=10&end_s=5` });
    assert.equal(bad.status, 400);
  });

  test('seek/step control advances the playhead snapshot', async () => {
    const seek = await request(s.port, { method: 'POST', path: `/api/mission-replay/${MISSION_ID}/control`, body: { action: 'seek', value: 50 } });
    assert.equal(seek.status, 200);
    assert.equal(seek.json.t_s, 50);
    const step = await request(s.port, { method: 'POST', path: `/api/mission-replay/${MISSION_ID}/control`, body: { action: 'step', value: 5 } });
    assert.equal(step.status, 200);
    assert.equal(step.json.t_s, 55);
    const snap = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/snapshot` });
    assert.equal(snap.json.t_s, 55);
  });

  test('control rejects unknown actions and bad values', async () => {
    const badAction = await request(s.port, { method: 'POST', path: `/api/mission-replay/${MISSION_ID}/control`, body: { action: 'nope' } });
    assert.equal(badAction.status, 400);
    const badStep = await request(s.port, { method: 'POST', path: `/api/mission-replay/${MISSION_ID}/control`, body: { action: 'step', value: 0 } });
    assert.equal(badStep.status, 400);
  });

  test('evaluation runs analytics over the log and scores detectors', async () => {
    const ev = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/evaluation` });
    assert.equal(ev.status, 200);
    assert.equal(ev.json.calibration.mode, 'self-calibrated');
    assert.ok(ev.json.detectors.rule && ev.json.detectors.analytics && ev.json.detectors.combined);
    assert.equal(ev.json.groundTruth.injectedEvents, 1);
    const evThr = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/evaluation?threshold=0` });
    assert.equal(evThr.status, 200);
    assert.equal(evThr.json.calibration.mode, 'absolute');
    const bad = await request(s.port, { path: `/api/mission-replay/${MISSION_ID}/evaluation?margin=99` });
    assert.equal(bad.status, 400);
  });

  test('unknown mission is a 404; traversal attempts fail safeId', async () => {
    const missing = await request(s.port, { path: '/api/mission-replay/no-such-mission/state' });
    assert.equal(missing.status, 404);
    const trav = await request(s.port, { path: '/api/mission-replay/..%2f..%2fetc/manifest' });
    assert.equal(trav.status, 400);
  });

  test('generation validates missionId, duration, faults and phases', async () => {
    const badId = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: '../x' } });
    assert.equal(badId.status, 400);
    const short = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: 'X2', duration: 20 } });
    assert.equal(short.status, 400);
    const badFault = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: 'X3', faults: [{ type: 'nope', onset_s: 0 }] } });
    assert.equal(badFault.status, 400);
    const badPhase = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: 'X4', phases: [{ phase: 'gallifrey', start_s: 0, end_s: 5 }] } });
    assert.equal(badPhase.status, 400);
  });

  test('/api/can/status reports the artificial J1939 bus', async () => {
    const st = await request(s.port, { path: '/api/can/status' });
    assert.equal(st.status, 200);
    assert.equal(st.json.protocol, 'j1939-29bit-sim');
    assert.ok(Array.isArray(st.json.nodes));
    assert.ok(st.json.nodes.length >= 5);
    assert.ok(typeof st.json.stats.sent === 'number');
  });

  test('generated replay is deterministic across calls (same seed)', async () => {
    const a = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: 'DET-SRV', duration: 120, seed: 9 } });
    const b = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: 'DET-SRV', duration: 120, seed: 9 } });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.json.sampleCount, b.json.sampleCount);
    assert.equal(a.json.seed, b.json.seed);
  });

  test('a blank seed is auto-derived and still fully reproducible', async () => {
    // generator.js#defaultSeed hashes missionId + duration + rate + faults +
    // phases, so identical inputs always reproduce an identical flight and a
    // different fault stack yields a different one. The UI labels this "auto".
    const id = 'AUTOSEED-1';
    const a = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: id, duration: 300 } });
    const b = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: id, duration: 300 } });
    assert.equal(a.status, 201);
    assert.equal(a.json.seed, b.json.seed, 'the auto seed must be stable for identical inputs');
    assert.ok(Number.isInteger(a.json.seed) && a.json.seed >= 0);

    // Changing the fault stack changes the derived seed, so the two missions are
    // genuinely different flights rather than the same one relabelled.
    const c = await request(s.port, {
      method: 'POST',
      path: '/api/mission-replay/generate',
      body: { missionId: id, duration: 300, faults: [{ type: 'overheating', onset_s: 50, duration_s: 100, severity: 'low' }] },
    });
    assert.notEqual(c.json.seed, a.json.seed, 'a different fault stack must derive a different seed');

    // And an explicit seed always wins over the derived one.
    const d = await request(s.port, { method: 'POST', path: '/api/mission-replay/generate', body: { missionId: id, duration: 300, seed: 7 } });
    assert.equal(d.json.seed, 7);
  });

  test('regenerating a mission id serves the NEW mission, not the cached previous one', async () => {
    // Regression: the record cache in loadReplayRecord() survived regeneration,
    // so re-generating an id kept serving the old manifest/faults/telemetry and a
    // newly injected fault was invisible through the whole API.
    const id = 'REGEN-1';
    const clean = await request(s.port, {
      method: 'POST', path: '/api/mission-replay/generate', body: { missionId: id, duration: 600, seed: 1 },
    });
    assert.equal(clean.status, 201);
    assert.equal(clean.json.faultEvents, 0, 'the baseline mission must have no fault events');
    const cleanFaults = await request(s.port, { path: `/api/mission-replay/${id}/faults` });
    assert.equal(cleanFaults.json.length, 0);

    const seeded = await request(s.port, {
      method: 'POST',
      path: '/api/mission-replay/generate',
      body: { missionId: id, duration: 600, seed: 2, faults: [{ type: 'overheating', onset_s: 100, duration_s: 200, severity: 'critical' }] },
    });
    assert.equal(seeded.status, 201);
    assert.ok(seeded.json.faultEvents >= 1, 'the regenerated mission must report its injected fault');

    // Every read path has to reflect the regeneration.
    const manifest = await request(s.port, { path: `/api/mission-replay/${id}/manifest` });
    assert.equal(manifest.json.seed, 2, 'the manifest must be the regenerated one, not the cached original');
    const faults = await request(s.port, { path: `/api/mission-replay/${id}/faults` });
    assert.ok(faults.json.length >= 1, 'the regenerated fault must be visible through the API');
    assert.ok(faults.json.some((f) => f.type === 'overheating' && f.injected === true),
      `expected the injected overheating event, got ${JSON.stringify(faults.json)}`);
    // The served telemetry has to be the new one too, not just the metadata.
    const before = await request(s.port, { path: `/api/mission-replay/${id}/state?t_s=50` });
    const during = await request(s.port, { path: `/api/mission-replay/${id}/state?t_s=200` });
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.fault_flags, [], 't=50s is before the injected onset');
    assert.ok(during.json.fault_flags.length > 0, 't=200s is inside the injected overheating window');
    assert.ok(during.json.thermal.cht_c > before.json.thermal.cht_c + 50,
      `the overheating signature must be visible in the regenerated telemetry (${before.json.thermal.cht_c} -> ${during.json.thermal.cht_c})`);
  });
});