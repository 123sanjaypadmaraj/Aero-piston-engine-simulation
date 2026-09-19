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
const { store: twinStore } = require('./twin_core');
const { missionRunner, replayEngine } = require('./replay');
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
        && faultTypes.length <= KNOWN_ENGINE_SIM_FAULTS.length
        && faultTypes.every((f) => typeof f === 'string' && KNOWN_ENGINE_SIM_FAULTS.includes(f));
      if (!valid) throw new HttpError(400, 'invalid faultTypes', `faultTypes must be an array of: ${KNOWN_ENGINE_SIM_FAULTS.join(', ')}`);
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

  return { app, server, io, fleet, aiAnalysis, start, stop, config: cfg, logger };
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
