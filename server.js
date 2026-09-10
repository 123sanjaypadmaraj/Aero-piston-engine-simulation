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
