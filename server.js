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
 *
 * `createServer()` builds everything without listening, so tests (and any
 * embedding process) can start it on an ephemeral port and stop it cleanly.
 * Running `node server.js` directly listens on PORT and installs process
 * signal / crash handlers.
 * -----------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let baseConfig;
try {
  baseConfig = require('./config');
} catch (err) {
  if (err && err.name === 'ConfigError') {
    if (require.main === module) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
  }
  throw err;
}

const { DigitalTwinFleet, SENSORS, FAULT_TYPES } = require('./simulator');
const { AiAnalysisEngine } = require('./ai/analysisEngine');
const { PhysicsEngine, MISSIONS } = require('./engine_sim');
const { FAULT_APPLICATORS } = require('./engine_sim/faults');
const { forecastEngine, evaluateMissionReplay } = require('./analytics');
const { store: twinStore, stateStore, liveHistory } = require('./twin_core');
const { missionRunner, replayEngine } = require('./replay');
const missionReplay = require('./missionreplay');
const { createLogger, requestLogger } = require('./middleware/logger');
const { HttpError, asyncHandler, notFound, errorHandler } = require('./middleware/errors');
const { safeId, numberInRange, bodyObject } = require('./middleware/validate');
const security = require('./middleware/security');

const PUBLIC_DIR = path.join(__dirname, 'public');
const REPLAY_ACTIONS = ['pause', 'resume', 'seek', 'speed', 'stop'];
const KNOWN_ENGINE_SIM_FAULTS = Object.keys(FAULT_APPLICATORS);

/**
 * @param {object} [options]
 * @param {object} [options.config]      overrides merged over the env-derived config (used by tests)
 * @param {object} [options.aiAnalysis]  inject an AiAnalysisEngine-compatible object (used by tests)
 * @param {object} [options.logger]      inject a logger
 */
function createServer(options = {}) {
  const cfg = Object.freeze({ ...baseConfig, ...(options.config || {}) });
  const logger = options.logger || createLogger({ level: cfg.logLevel, json: cfg.isProduction });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  const server = http.createServer(app);
  const io = new Server(server, security.socketIoOptions(cfg.corsOrigins));

  const fleet = new DigitalTwinFleet();
  const aiAnalysis = options.aiAnalysis || new AiAnalysisEngine({ io }); // RAG + Gemini/Groq "engine situation" narratives

  function attachAiAnalysis(snapshot) {
    snapshot.engines.forEach((engine) => { engine.aiAnalysis = aiAnalysis.latest(engine.id); });
    return snapshot;
  }

  let latest = attachAiAnalysis(fleet.step()); // seed initial state so REST calls before the first tick still return data
  let tickTimer = null;
  let started = false;
  let stopping = null;
  const activeReplayPlayers = new Map(); // engineId -> player, so a caller can stop/pause an in-flight replay
  let activeMissionRuns = 0;

  // ---- Twin-core wiring ------------------------------------------------------
  // Every fleet tick pushes each engine's latest reading into the in-memory
  // live-state cache (stateStore) and, when persistence is enabled, appends a
  // compact reading to the bounded rolling liveHistory (twin_core/data/live).
  // This is the twin persistence seam: a fielded system would push the same
  // snapshot to Redis (stateStore) and Timescale/Influx (liveHistory).
  function recordLiveState(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.engines)) return;
    for (const engine of snapshot.engines) {
      stateStore.set(engine.id, {
        time: engine.time,
        id: engine.id,
        tail: engine.tail,
        readings: engine.readings,
        health: engine.health,
        rul: engine.rul,
        activeFault: engine.activeFault,
        predictedFault: engine.predictedFault,
      });
      if (cfg.liveHistoryEnabled) {
        try {
          liveHistory.append(engine.id, {
            time: engine.time,
            readings: engine.readings,
            health: engine.health,
            rul: engine.rul,
            altitude: engine.altitude,
            airspeed: engine.airspeed,
            activeFault: engine.activeFault ? engine.activeFault.type : null,
            predictedFault: engine.predictedFault ? engine.predictedFault.type : null,
          });
        } catch (err) {
          logger.warn('live history append failed', { engineId: engine.id, err });
        }
      }
    }
  }
  recordLiveState(latest);

  // ---- Middleware ---------------------------------------------------------

  app.use(requestLogger(logger));
  app.use(security.helmetMiddleware({ isProduction: cfg.isProduction, publicDir: PUBLIC_DIR }));
  app.use(security.corsMiddleware(cfg.corsOrigins));

  // Probes are registered ahead of the rate limiter so orchestrators are never throttled.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'aero-engine-digital-twin', uptime: process.uptime() });
  });

  app.get('/api/ready', asyncHandler(async (_req, res) => {
    const checks = { fleet: Boolean(latest && latest.engines && latest.engines.length), store: false };
    try {
      await fs.promises.mkdir(twinStore.DATA_DIR, { recursive: true });
      await fs.promises.access(twinStore.DATA_DIR, fs.constants.W_OK);
      checks.store = true;
    } catch (err) {
      logger.warn('readiness: twin store directory not writable', { err });
    }
    const ready = checks.fleet && checks.store && !stopping;
    res.status(ready ? 200 : 503).json({ ready, checks });
  }));

  app.use(express.static(PUBLIC_DIR));
  // three.js is served from node_modules so the 3D twin works offline (no CDN dependency)
  app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three')));

  const limiters = security.rateLimiters(cfg);
  app.use('/api', limiters.general);
  app.use('/api', security.adminGuard(cfg.adminApiKey));
  app.use('/api', express.json({ limit: '100kb' }));

  // ---- REST API -----------------------------------------------------------

  app.get('/api/meta', (_req, res) => {
    res.json({ sensors: SENSORS, faultTypes: FAULT_TYPES });
  });

  app.get('/api/snapshot', (_req, res) => {
    res.json({ ...latest, serverTime: Date.now() });
  });

  app.get('/api/alerts', (_req, res) => {
    res.json(fleet.allAlerts(50));
  });

  app.get('/api/series/:engineId', (req, res) => {
    const s = fleet.series(safeId(req.params.engineId, 'engineId'));
    if (!s) throw new HttpError(404, 'unknown engine id');
    res.json(s);
  });

  // Twin persistence layer: the fleet's bounded rolling telemetry history plus
  // a per-engine maintenance digest (latest analytics flags, RUL, threshold
  // forecasts and the maintenance recommendation). See twin_core/liveHistoryStore.

  app.get('/api/history/:engineId', (req, res) => {
    const engineId = safeId(req.params.engineId, 'engineId');
    if (!fleet.engine(engineId)) throw new HttpError(404, 'unknown engine id');
    const readings = liveHistory.read(engineId);
    const st = liveHistory.stats(engineId);
    res.json({ engineId, readings, updatedAt: st.lastAppend, count: st.count });
  });

  app.get('/api/maintenance', (_req, res) => {
    const engines = latest.engines.map((engine) => {
      const a = engine.analytics || {};
      const historyBySensor = fleet.series(engine.id);
      return {
        engineId: engine.id,
        tail: engine.tail,
        health: engine.health,
        rul: engine.rul,
        predictedFault: engine.predictedFault,
        flags: a.flags || [],
        trends: a.trends || {},
        anomalyScore: Number.isFinite(a.anomalyScore) ? a.anomalyScore : 0,
        recommendation: a.recommendation || null,
        fatigue: a.fatigue || null,
        forecast: forecastEngine(historyBySensor),
      };
    });
    res.json({ generatedAt: Date.now(), engines });
  });

  // ---- Physics-based engine_sim missions + mission replay -------------------
  // Distinct from the live spoofed fleet above: these routes run the
  // engine_sim/ mean-value physics model (Phase 1) end-to-end over a chosen
  // mission profile, persist every reading via twin_core/store (Phase 3), and
  // can replay a recorded mission back out over Socket.IO at variable speed
  // (Phase 6) — a real post-flight analysis workflow, not just a CSV replay.

  app.get('/api/engine-sim/profiles', (_req, res) => {
    const profiles = Object.entries(MISSIONS).map(([id, m]) => ({
      id,
      name: m.name,
      durationS: m.durationS,
      ambientTempOffsetC: m.ambientTempOffsetC,
    }));
    res.json(profiles);
  });

  app.post('/api/engine-sim/run', limiters.heavy, asyncHandler(async (req, res) => {
    const body = bodyObject(req);
    const {
      engineId = 'uav-01',
      profileId = 'climbCruiseDescent',
      durationSeconds = 1800,
      dtSeconds = 2,
      faultTypes,
    } = body;

    safeId(engineId, 'engineId');
    if (typeof profileId !== 'string' || !Object.hasOwn(MISSIONS, profileId)) {
      throw new HttpError(400, `unknown profileId "${String(profileId).slice(0, 64)}"`, `available: ${Object.keys(MISSIONS).join(', ')}`);
    }
    numberInRange(durationSeconds, 'durationSeconds', 10, 14400);
    numberInRange(dtSeconds, 'dtSeconds', 0.5, 30);
    if (faultTypes !== undefined) {
      const valid = Array.isArray(faultTypes)
        && faultTypes.length >= 1
        && faultTypes.length <= KNOWN_ENGINE_SIM_FAULTS.length
        && new Set(faultTypes).size === faultTypes.length
        && faultTypes.every((f) => typeof f === 'string' && KNOWN_ENGINE_SIM_FAULTS.includes(f));
      if (!valid) throw new HttpError(400, 'invalid faultTypes', `faultTypes must be a de-duplicated array of: ${KNOWN_ENGINE_SIM_FAULTS.join(', ')}`);
    }
    if (activeMissionRuns >= cfg.maxConcurrentMissions) {
      throw new HttpError(429, 'too many concurrent mission runs', `at most ${cfg.maxConcurrentMissions} may run at once; retry shortly`);
    }

    activeMissionRuns += 1;
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
      logger.error('engine-sim mission run failed', { reqId: req.id, err });
      throw new HttpError(500, 'mission run failed', cfg.isProduction ? undefined : err.message);
    } finally {
      activeMissionRuns -= 1;
    }
  }));

  app.get('/api/engine-sim/recordings/:engineId', (req, res) => {
    res.json(twinStore.listMissions(safeId(req.params.engineId, 'engineId')));
  });

  app.get('/api/engine-sim/recordings/:engineId/:missionId', asyncHandler(async (req, res) => {
    const engineId = safeId(req.params.engineId, 'engineId');
    const missionId = safeId(req.params.missionId, 'missionId');
    const readings = await twinStore.readMission(engineId, missionId);
    if (!readings.length) throw new HttpError(404, 'mission not found or empty');
    res.json(readings);
  }));

  // Registered before the /:missionId route below — Express matches route
  // path segments in registration order, and "control" would otherwise be
  // captured as a literal missionId by the more general route.
  app.post('/api/engine-sim/replay/:engineId/control', (req, res) => {
    const engineId = safeId(req.params.engineId, 'engineId');
    const { action, value } = bodyObject(req);
    if (typeof action !== 'string' || !REPLAY_ACTIONS.includes(action)) {
      throw new HttpError(400, 'unknown action', `allowed: ${REPLAY_ACTIONS.join(', ')}`);
    }
    // seek takes a [0,1] fraction or an epoch-ms timestamp; speed a playback multiplier.
    if (action === 'seek') numberInRange(value, 'value', 0, 1e15);
    if (action === 'speed') numberInRange(value, 'value', 0.1, 100);

    const player = activeReplayPlayers.get(engineId);
    if (!player) throw new HttpError(404, 'no active replay for this engine');
    if (action === 'pause') player.pause();
    else if (action === 'resume') player.resume();
    else if (action === 'seek') player.seek(value);
    else if (action === 'speed') player.setSpeed(value);
    else if (action === 'stop') { player.stop(); activeReplayPlayers.delete(engineId); }
    res.json({ ok: true, isPlaying: player.isPlaying, position: player.position, length: player.length });
  });

  app.post('/api/engine-sim/replay/:engineId/:missionId', limiters.heavy, (req, res) => {
    const engineId = safeId(req.params.engineId, 'engineId');
    const missionId = safeId(req.params.missionId, 'missionId');
    const { speed = 1.0 } = bodyObject(req);
    numberInRange(speed, 'speed', 0.1, 100);

    if (!twinStore.listMissions(engineId).some((m) => m.missionId === missionId)) {
      throw new HttpError(404, 'mission not found');
    }

    const existing = activeReplayPlayers.get(engineId);
    if (existing) existing.stop();

    const player = replayEngine.createPlayer(engineId, missionId, { speed });
    activeReplayPlayers.set(engineId, player);

    player.start((reading, index, total) => {
      io.emit('replay-frame', { engineId, missionId, reading, index, total });
      if (index + 1 >= total && activeReplayPlayers.get(engineId) === player) activeReplayPlayers.delete(engineId);
    }).catch((err) => {
      logger.error('replay failed', { engineId, missionId, err });
      if (activeReplayPlayers.get(engineId) === player) activeReplayPlayers.delete(engineId);
    });

    res.json({ started: true, engineId, missionId, speed });
  });

  // ---- Mission replay (spec-driven synthetic logs) + artificial CAN bus -----
  // The real UAV had no on-board CAN fabric, so missionreplay/ synthesises a
  // J1939-flavoured bus. `generate` writes a deterministic mission log (JSONL
  // telemetry + manifest + fault table + byte-offset index); the replay
  // endpoints stream it back with interpolation + fault-onset snapping and a
  // three-tier anomaly overlay (nominal / precursor / active). Live replay
  // frames are also pushed onto the global artificial CAN bus for /api/can/status.

  const missionReplayDataDir = path.join(twinStore.DATA_DIR, 'missionreplay');
  const MASTER_CAN_BUS = missionReplay.can.createCanBus({ capacity: 8192, seed: 'aeropiston-can-master' });
  const missionReplayPlayers = new Map(); // missionId -> { pl, interval, speed, maxT }

  function loadReplayRecord(missionId) {
    const cached = missionReplayPlayers.get(missionId);
    if (cached && cached.record) return cached;
    const dir = path.join(missionReplayDataDir, missionId);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      throw new HttpError(404, 'mission not found',
        `no generated mission '${missionId}'; create one with POST /api/mission-replay/generate`);
    }
    const record = missionReplay.loader.loadMission(dir);
    const pl = missionReplay.replay.createReplay(record);
    const entry = { record, pl, interval: null, speed: 1, maxT: record.t0 + (record.duration || 0) };
    missionReplayPlayers.set(missionId, entry);
    return entry;
  }

  function stopMissionPlayback(entry) {
    if (entry.interval) { clearInterval(entry.interval); entry.interval = null; }
  }

  app.get('/api/mission-replay', (_req, res) => {
    let missions = [];
    if (fs.existsSync(missionReplayDataDir)) {
      missions = fs.readdirSync(missionReplayDataDir)
        .filter((d) => fs.existsSync(path.join(missionReplayDataDir, d, 'manifest.json')))
        .map((d) => ({ missionId: d, dir: path.join(missionReplayDataDir, d) }));
    }
    res.json({ missions });
  });

  app.post('/api/mission-replay/generate', limiters.heavy, (req, res) => {
    const body = bodyObject(req);
    const missionId = safeId(String(body.missionId || ''), 'missionId');
    const duration = body.duration === undefined ? 21600 : 0 + Number(body.duration);
    numberInRange(duration, 'duration', 30, 86400);
    const sampleRateHz = body.sampleRateHz === undefined ? 1 : Number(body.sampleRateHz);
    numberInRange(sampleRateHz, 'sampleRateHz', 1, 10);
    let seed;
    if (body.seed !== undefined) {
      seed = Number(body.seed);
      numberInRange(seed, 'seed', 0, 4294967295);
    }
    const knownFaults = missionReplay.faultLib.FAULT_TYPES;
    const knownSeverities = missionReplay.faultLib.SEVERITY_MULT;
    let faults = [];
    if (body.faults !== undefined) {
      if (!Array.isArray(body.faults) || body.faults.length > 40) {
        throw new HttpError(400, 'faults must be an array of at most 40 fault configs');
      }
      faults = body.faults.map((f, i) => {
        if (!f || typeof f !== 'object' || typeof f.type !== 'string' || !Object.hasOwn(knownFaults, f.type)) {
          throw new HttpError(400, `faults[${i}].type must be one of: ${Object.keys(knownFaults).join(', ')}`);
        }
        numberInRange(f.onset_s, `faults[${i}].onset_s`, 0, duration - 1);
        if (f.duration_s !== undefined) numberInRange(f.duration_s, `faults[${i}].duration_s`, 1, duration);
        if (f.severity !== undefined && !Object.hasOwn(knownSeverities, String(f.severity))) {
          throw new HttpError(400, `faults[${i}].severity must be one of: ${Object.keys(knownSeverities).join(', ')}`);
        }
        return { type: f.type, onset_s: f.onset_s, duration_s: f.duration_s, severity: f.severity };
      });
    }
    let phases;
    if (body.phases !== undefined) {
      if (!Array.isArray(body.phases) || body.phases.length > 100) {
        throw new HttpError(400, 'phases must be an array of { phase, start_s, end_s }');
      }
      const validPhaseNames = missionReplay.profiles.PROFILE_PHASES;
      phases = body.phases.map((p, i) => {
        if (!p || typeof p.phase !== 'string' || !validPhaseNames.includes(p.phase)) {
          throw new HttpError(400, `phases[${i}].phase must be one of: ${validPhaseNames.join(', ')}`);
        }
        numberInRange(p.start_s, `phases[${i}].start_s`, 0, duration);
        numberInRange(p.end_s, `phases[${i}].end_s`, p.start_s + 1, duration);
        return { phase: p.phase, start_s: p.start_s, end_s: p.end_s };
      });
    }
    const existing = missionReplayPlayers.get(missionId);
    if (existing) stopMissionPlayback(existing);

    let summary;
    try {
      summary = missionReplay.generator.generateMission({
        missionId,
        outDir: missionReplayDataDir,
        duration,
        sampleRateHz,
        seed,
        phases,
        faults,
        recordCan: body.recordCan === true,
      });
    } catch (err) {
      throw new HttpError(400, 'generation failed', cfg.isProduction ? undefined : err.message);
    }
    // warm the record/player cache
    loadReplayRecord(missionId);
    res.status(201).json({
      missionId,
      sampleCount: summary.sampleCount,
      durationS: summary.durationS,
      seed: summary.seed,
      faultEvents: summary.faults.length,
      manifest: summary.manifest,
    });
  });

  app.get('/api/mission-replay/:missionId/manifest', (req, res) => {
    const { record } = loadReplayRecord(safeId(req.params.missionId, 'missionId'));
    res.json(record.manifest);
  });

  app.get('/api/mission-replay/:missionId/faults', (req, res) => {
    const { record } = loadReplayRecord(safeId(req.params.missionId, 'missionId'));
    res.json(record.faults);
  });

  app.get('/api/mission-replay/:missionId/phases', (req, res) => {
    const { record } = loadReplayRecord(safeId(req.params.missionId, 'missionId'));
    res.json(record.phases);
  });

  app.get('/api/mission-replay/:missionId/state', (req, res) => {
    const { record, pl } = loadReplayRecord(safeId(req.params.missionId, 'missionId'));
    const t_s = req.query.t_s === undefined ? pl.currentT() : Number(req.query.t_s);
    numberInRange(t_s, 't_s', record.t0, record.t0 + record.duration || 21600);
    res.json(pl.stateAt(t_s));
  });

  app.get('/api/mission-replay/:missionId/range', (req, res) => {
    const { record, pl } = loadReplayRecord(safeId(req.params.missionId, 'missionId'));
    const start = req.query.start_s === undefined ? record.t0 : Number(req.query.start_s);
    const end = req.query.end_s === undefined ? record.t0 + record.duration : Number(req.query.end_s);
    const maxSamples = req.query.maxSamples === undefined ? 2000 : Number(req.query.maxSamples);
    numberInRange(start, 'start_s', record.t0, record.t0 + record.duration);
    numberInRange(end, 'end_s', record.t0, record.t0 + record.duration);
    numberInRange(maxSamples, 'maxSamples', 10, 20000);
    if (end <= start) throw new HttpError(400, 'end_s must be greater than start_s');
    res.json(pl.getRange(start, end, { maxSamples }));
  });

  app.get('/api/mission-replay/:missionId/snapshot', (req, res) => {
    const { pl } = loadReplayRecord(safeId(req.params.missionId, 'missionId'));
    res.json(pl.snapshot());
  });

  // Cross-pipeline scoring: run the analytics L3 health model over the log and
  // score each detector against the injected ground truth (precision/recall).
  // Defaults to self-calibrated (baseline margin); ?threshold= overrides with
  // the absolute health value.
  app.get('/api/mission-replay/:missionId/evaluation', (req, res) => {
    const { record } = loadReplayRecord(safeId(req.params.missionId, 'missionId'));
    if (req.query.margin !== undefined) numberInRange(Number(req.query.margin), 'margin', 0, 60);
    if (req.query.threshold !== undefined) numberInRange(Number(req.query.threshold), 'threshold', 0, 100);
    const opts = {};
    if (req.query.margin !== undefined) opts.baselineMargin = Number(req.query.margin);
    if (req.query.threshold !== undefined) opts.healthThreshold = Number(req.query.threshold);
    res.json(evaluateMissionReplay(record, opts));
  });

  // Post-forward endpoint: position a player and (optionally) tick it. The
  // live 'play' action streams frames over Socket.IO (mission-replay-frame)
  // and feeds the artificial CAN bus so /api/can/status shows live traffic.
  app.post('/api/mission-replay/:missionId/control', (req, res) => {
    const missionId = safeId(req.params.missionId, 'missionId');
    const entry = loadReplayRecord(missionId);
    const { pl } = entry;
    const { action, value } = bodyObject(req);
    if (typeof action !== 'string' || !['play', 'pause', 'resume', 'seek', 'step', 'stop'].includes(action)) {
      throw new HttpError(400, 'unknown action', 'allowed: play, pause, resume, seek, step, stop');
    }
    if (action === 'seek') numberInRange(value, 'value', entry.record.t0, entry.maxT);
    if (action === 'step') numberInRange(value, 'value', 1, 10000);
    if (action === 'play') numberInRange(value === undefined ? 1 : value, 'speed', 0.5, 500);

    if (action === 'seek') { pl.seek(value); }
    else if (action === 'step') { pl.step(value); }
    else if (action === 'pause') { stopMissionPlayback(entry); }
    else if (action === 'stop') { stopMissionPlayback(entry); pl.stop(); }
    else if (action === 'resume') { /* resume restarts with last speed */ startPlayback(entry, missionId, entry.speed); }
    else if (action === 'play') { startPlayback(entry, missionId, value === undefined ? 1 : value); }
    res.json(pl.snapshot());
  });

  function startPlayback(entry, missionId, speed) {
    stopMissionPlayback(entry);
    entry.speed = speed;
    const ms = Math.max(1, 1000 / (entry.record.rate * speed));
    entry.interval = setInterval(() => {
      const snap = entry.pl.snapshot();
      if (snap.t_s >= entry.record.t0 + entry.record.duration - 1e-9) { stopMissionPlayback(entry); return; }
      const stateAt = entry.pl.step(1);
      if (stateAt) {
        io.emit('mission-replay-frame', { missionId, state: stateAt, anomaly: stateAt.anomaly });
        try { MASTER_CAN_BUS.publishSample(stateAt, Math.round(stateAt.t_s * 1000)); } catch (e) { /* bus is best-effort */ }
      }
      entry.lastTickT = stateAt ? stateAt.t_s : snap.t_s;
    }, ms);
    if (entry.interval && typeof entry.interval.unref === 'function') entry.interval.unref();
  }

  app.get('/api/can/status', (_req, res) => {
    res.json(MASTER_CAN_BUS.status());
  });

  // ---- AI engine-situation analysis (RAG over the knowledge base + Gemini/Groq) --
  // See ./ai/analysisEngine.js — results are also embedded on each engine's
  // `aiAnalysis` field in every /api/snapshot response and `snapshot` socket
  // event, so these endpoints are mainly useful for polling/refreshing in
  // isolation (e.g. the dashboard's "Explain now" button).

  app.get('/api/ai-analysis', (_req, res) => {
    res.json(aiAnalysis.allLatest());
  });

  app.get('/api/ai-analysis/:engineId', (req, res) => {
    const result = aiAnalysis.latest(safeId(req.params.engineId, 'engineId'));
    if (!result) throw new HttpError(404, 'no analysis yet for this engine');
    res.json(result);
  });

  app.post('/api/ai-analysis/:engineId/refresh', limiters.heavy, asyncHandler(async (req, res) => {
    const engineId = safeId(req.params.engineId, 'engineId');
    const engine = latest.engines.find((e) => e.id === engineId);
    if (!engine) throw new HttpError(404, 'unknown engine id');
    res.json(await aiAnalysis.refresh(engine, latest));
  }));

  app.use(notFound);
  app.use(errorHandler(logger, cfg));

  // ---- Live streaming -------------------------------------------------------

  const socketsByIp = new Map();
  let socketTotal = 0;
  const socketIp = (socket) => {
    if (cfg.trustProxy) {
      const xff = socket.handshake.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return socket.handshake.address;
  };

  // Simple connection cap (total + per IP) so a misbehaving client cannot exhaust file descriptors.
  io.use((socket, next) => {
    if (socketTotal >= cfg.socketMaxTotal || (socketsByIp.get(socketIp(socket)) || 0) >= cfg.socketMaxPerIp) {
      logger.warn('socket connection refused (cap reached)', { ip: socketIp(socket), total: socketTotal });
      return next(new Error('too many connections'));
    }
    return next();
  });

  io.on('connection', (socket) => {
    const ip = socketIp(socket);
    socketTotal += 1;
    socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
    socket.on('disconnect', () => {
      socketTotal -= 1;
      const n = (socketsByIp.get(ip) || 1) - 1;
      if (n <= 0) socketsByIp.delete(ip);
      else socketsByIp.set(ip, n);
    });
    socket.on('error', (err) => logger.debug('socket error', { err }));
    socket.emit('snapshot', { ...latest, serverTime: Date.now() }); // immediate sync for new clients
  });

  // Guarded so a single thrown error cannot kill the interval (and with it the live feed).
  function tick() {
    try {
      latest = attachAiAnalysis(fleet.step());
      latest.serverTime = Date.now();
      recordLiveState(latest);
      io.emit('snapshot', latest);
      aiAnalysis.onFleetTick(latest); // throttled in-background AI analysis per engine
    } catch (err) {
      logger.error('telemetry tick failed', { err });
    }
  }

  // ---- Lifecycle ------------------------------------------------------------

  function start() {
    if (started) return Promise.reject(new Error('server already started'));
    started = true;
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        started = false;
        reject(err);
      };
      server.once('error', onError);
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', onError);
        server.on('error', (err) => logger.error('http server error', { err }));
        tickTimer = setInterval(tick, cfg.tickMs);
        try {
          aiAnalysis.onFleetTick(latest); // kick off the first round of analyses in the background
        } catch (err) {
          logger.error('initial AI analysis kick-off failed', { err });
        }
        const { port } = server.address();
        logger.info('server listening', { port, host: cfg.host, url: `http://localhost:${port}` });
        logger.info('configuration', {
          ...baseConfig.describe(cfg),
          gemini: process.env.GEMINI_API_KEY ? 'key set' : 'no key',
          groq: process.env.GROQ_API_KEY ? 'key set' : 'no key',
        });
        resolve({ port, host: cfg.host });
      });
    });
  }

  function stop() {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
      for (const player of activeReplayPlayers.values()) {
        try { player.stop(); } catch (err) { logger.debug('replay stop failed', { err }); }
      }
      activeReplayPlayers.clear();
      io.removeAllListeners('connection');

      const finish = () => {
        clearTimeout(forceTimer);
        resolve();
      };
      // Keep-alive HTTP connections would otherwise hold close() open until they time out.
      const forceTimer = setTimeout(() => server.closeAllConnections(), 1000);
      forceTimer.unref();
      // io.close() disconnects every socket, then closes the underlying HTTP server.
      io.close(() => finish());
      server.closeIdleConnections();
    });
    return stopping;
  }

  return { app, server, io, fleet, aiAnalysis, stateStore, liveHistory, start, stop, config: cfg, logger };
}

// ---- Backward-compatible exports -------------------------------------------
// `require('./server').app` / `.server` used to be the singleton instance. It
// is now built lazily, so requiring this module for its createServer() has no side effects.
let defaultInstance = null;
const getDefault = () => defaultInstance || (defaultInstance = createServer());

module.exports = { createServer };
Object.defineProperty(module.exports, 'app', { enumerable: true, get: () => getDefault().app });
Object.defineProperty(module.exports, 'server', { enumerable: true, get: () => getDefault().server });

// ---- Run directly ------------------------------------------------------------

if (require.main === module) {
  const instance = getDefault();
  const { logger } = instance;
  let shuttingDown = false;

  const shutdown = (reason, exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit', { timeoutMs: instance.config.shutdownTimeoutMs });
      process.exit(exitCode || 1);
    }, instance.config.shutdownTimeoutMs);
    force.unref();
    instance.stop().then(() => process.exit(exitCode), () => process.exit(exitCode || 1));
  };

  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    shutdown('uncaughtException', 1);
  });

  instance.start().catch((err) => {
    logger.error(err.code === 'EADDRINUSE' ? `port ${instance.config.port} is already in use` : 'failed to start server', { err });
    process.exit(1);
  });
}
