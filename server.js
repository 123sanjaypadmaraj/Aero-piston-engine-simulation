/**
 * server.js
 * -----------------------------------------------------------------------
 * Backend for the Aero Piston Engine Digital Twin dashboard.
 *
 *  - Serves the static frontend dashboard (./public)
 *  - Exposes a small REST API for snapshots/history/alerts
 *  - Streams live (spoofed) telemetry over Socket.IO every TICK_MS
 *
 * This backend stands in for the real UAV telemetry downlink + engine
 * health monitoring service: in a fielded system, `simulator.js` would be
 * replaced by an ingest layer reading the actual ECU/FADEC data bus, while
 * everything downstream (REST API, socket broadcast, dashboard) stays the
 * same.
 * -----------------------------------------------------------------------
 */

'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { DigitalTwinFleet, SENSORS, FAULT_TYPES } = require('./simulator');
const { AiAnalysisEngine } = require('./ai/analysisEngine');
const { PhysicsEngine, MISSIONS } = require('./engine_sim');
const { store: twinStore } = require('./twin_core');
const { missionRunner, replayEngine } = require('./replay');

const PORT = process.env.PORT || 5000;
const TICK_MS = 2000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const fleet = new DigitalTwinFleet();
const aiAnalysis = new AiAnalysisEngine({ io }); // RAG + Gemini "engine situation" narratives

function attachAiAnalysis(snapshot) {
  snapshot.engines.forEach((engine) => { engine.aiAnalysis = aiAnalysis.latest(engine.id); });
  return snapshot;
}

let latest = attachAiAnalysis(fleet.step()); // seed initial state so REST calls before the first tick still return data
aiAnalysis.onFleetTick(latest); // kick off the first round of analyses in the background

// ---- REST API -----------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'aero-engine-digital-twin', uptime: process.uptime() });
});

app.get('/api/meta', (_req, res) => {
  res.json({ sensors: SENSORS, faultTypes: FAULT_TYPES });
});

app.get('/api/snapshot', (_req, res) => {
  res.json(latest);
});

app.get('/api/alerts', (_req, res) => {
  res.json(fleet.allAlerts(50));
});

app.get('/api/series/:engineId', (req, res) => {
  const s = fleet.series(req.params.engineId);
  if (!s) return res.status(404).json({ error: 'unknown engine id' });
  res.json(s);
});

// ---- Physics-based engine_sim missions + mission replay -------------------
// Distinct from the live spoofed fleet above: these routes run the
// engine_sim/ mean-value physics model (Phase 1) end-to-end over a chosen
// mission profile, persist every reading via twin_core/store (Phase 3), and
// can replay a recorded mission back out over Socket.IO at variable speed
// (Phase 6) — a real post-flight analysis workflow, not just a CSV replay.

const activeReplayPlayers = new Map(); // engineId -> player, so a caller can stop/pause an in-flight replay

app.get('/api/engine-sim/profiles', (_req, res) => {
  const profiles = Object.entries(MISSIONS).map(([id, m]) => ({
    id,
    name: m.name,
    durationS: m.durationS,
    ambientTempOffsetC: m.ambientTempOffsetC,
  }));
  res.json(profiles);
});

app.post('/api/engine-sim/run', async (req, res) => {
  const {
    engineId = 'uav-01',
    profileId = 'climbCruiseDescent',
    durationSeconds = 1800,
    dtSeconds = 2,
    faultTypes,
  } = req.body || {};

  if (!MISSIONS[profileId]) {
    return res.status(400).json({ error: `unknown profileId "${profileId}"`, available: Object.keys(MISSIONS) });
  }

  try {
    const physicsEngine = new PhysicsEngine({ missionName: profileId, faultTypes });
    const summary = await missionRunner.runMission({
      engineId,
      profileId,
      // engine_sim's PhysicsEngine tracks its own mission/elapsed time internally,
      // so profileFn only needs to keep missionRunner's elapsed clock in step —
      // the actual control inputs are computed inside physicsEngine.step().
      profileFn: (elapsedSeconds) => ({ elapsedSeconds }),
      stepFn: (_controlInputs, dt) => {
        const reading = physicsEngine.step(dt);
        // Adapt engine_sim's { activeFaults: {type: severity} } into the
        // single-active-fault shape missionRunner's fault-event tracker expects.
        const [topType] = Object.entries(reading.activeFaults || {}).sort((a, b) => b[1] - a[1])[0] || [];
        return { ...reading, activeFault: topType ? { type: topType } : null };
      },
      durationSeconds,
      dtSeconds,
    });
    res.json(summary);
  } catch (err) {
    console.error('[engine-sim] mission run failed:', err);
    res.status(500).json({ error: 'mission run failed', detail: err.message });
  }
});

app.get('/api/engine-sim/recordings/:engineId', (req, res) => {
  res.json(twinStore.listMissions(req.params.engineId));
});

app.get('/api/engine-sim/recordings/:engineId/:missionId', async (req, res) => {
  const readings = await twinStore.readMission(req.params.engineId, req.params.missionId);
  if (!readings.length) return res.status(404).json({ error: 'mission not found or empty' });
  res.json(readings);
});

// Registered before the /:missionId route below — Express matches route
// path segments in registration order, and "control" would otherwise be
// captured as a literal missionId by the more general route.
app.post('/api/engine-sim/replay/:engineId/control', (req, res) => {
  const player = activeReplayPlayers.get(req.params.engineId);
  if (!player) return res.status(404).json({ error: 'no active replay for this engine' });
  const { action, value } = req.body || {};
  if (action === 'pause') player.pause();
  else if (action === 'resume') player.resume();
  else if (action === 'seek') player.seek(value);
  else if (action === 'speed') player.setSpeed(value);
  else if (action === 'stop') { player.stop(); activeReplayPlayers.delete(req.params.engineId); }
  else return res.status(400).json({ error: 'unknown action', allowed: ['pause', 'resume', 'seek', 'speed', 'stop'] });
  res.json({ ok: true, isPlaying: player.isPlaying, position: player.position, length: player.length });
});

app.post('/api/engine-sim/replay/:engineId/:missionId', async (req, res) => {
  const { engineId, missionId } = req.params;
  const { speed = 1.0 } = req.body || {};

  const existing = activeReplayPlayers.get(engineId);
  if (existing) existing.stop();

  const player = replayEngine.createPlayer(engineId, missionId, { speed });
  activeReplayPlayers.set(engineId, player);

  player.start((reading, index, total) => {
    io.emit('replay-frame', { engineId, missionId, reading, index, total });
    if (index + 1 >= total) activeReplayPlayers.delete(engineId);
  });

  res.json({ started: true, engineId, missionId, speed });
});

// ---- AI engine-situation analysis (RAG over the knowledge base + Gemini) --
// See ./ai/analysisEngine.js — results are also embedded on each engine's
// `aiAnalysis` field in every /api/snapshot response and `snapshot` socket
// event, so these endpoints are mainly useful for polling/refreshing in
// isolation (e.g. the dashboard's "Explain now" button).

app.get('/api/ai-analysis', (_req, res) => {
  res.json(aiAnalysis.allLatest());
});

app.get('/api/ai-analysis/:engineId', (req, res) => {
  const result = aiAnalysis.latest(req.params.engineId);
  if (!result) return res.status(404).json({ error: 'no analysis yet for this engine' });
  res.json(result);
});

app.post('/api/ai-analysis/:engineId/refresh', async (req, res) => {
  const engine = latest.engines.find((e) => e.id === req.params.engineId);
  if (!engine) return res.status(404).json({ error: 'unknown engine id' });
  const result = await aiAnalysis.refresh(engine, latest);
  res.json(result);
});

// ---- Live streaming -------------------------------------------------------

io.on('connection', (socket) => {
  socket.emit('snapshot', latest); // immediate sync for new clients
  socket.on('disconnect', () => {});
});

setInterval(() => {
  latest = attachAiAnalysis(fleet.step());
  io.emit('snapshot', latest);
  aiAnalysis.onFleetTick(latest); // throttled in-background Gemini analysis per engine
}, TICK_MS);

server.listen(PORT, () => {
  console.log('='.repeat(70));
  console.log(' AI-Enabled Digital Twin — Aero Piston Engine Health Monitoring');
  console.log(` Backend + spoofed telemetry simulator running on port ${PORT}`);
  console.log(` Dashboard:  http://localhost:${PORT}`);
  console.log(` REST API:   http://localhost:${PORT}/api/snapshot`);
  console.log(` AI analysis (Gemini RAG): ${process.env.GEMINI_API_KEY ? 'enabled' : 'DISABLED — set GEMINI_API_KEY in .env to enable'}`);
  console.log('='.repeat(70));
});

module.exports = { app, server };
