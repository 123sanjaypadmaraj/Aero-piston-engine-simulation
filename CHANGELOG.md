# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased] - mission replay & artificial CAN

### Added
- **Spec-driven mission replay (`missionreplay/`).** A deterministic,
  operator-seeded synthetic recorder: `generateMission({seed})` writes
  `manifest.json` (schema "1.0"), `telemetry.jsonl`, `faults.json`,
  `telemetry.idx` (byte-offset seek index) and optional `can.jsonl`. The
  7-phase flight schedule (taxi → takeoff → climb → cruise → loiter →
  descent → landing), cosine-eased 15 s transition windows, first-order lag,
  gaussian noise, clamps, time-windowed fault injection and consecutive-
  sample detection rules are byte-identical across runs with the same seed.
- **Mission replay API.** `POST /api/mission-replay/generate`,
  `GET /api/mission-replay`, `GET /api/mission-replay/:missionId/{manifest,
  faults,phases,state,range,snapshot}`, `POST /api/mission-replay/:missionId/
  control` (seek/step/play/pause/resume/stop), plus `mission-replay-frame`
  Socket.IO events.
- **Artificial J1939 CAN bus (`missionreplay/can.js`).** 29-bit arbitration
  IDs, 11-signal PGN map, 5 nodes, uint16 byte-scale encode/decode round trip,
  bounded receive ring buffer with dropped-frame accounting. Wired to
  `GET /api/can/status`; live mission-replay playback streams frames onto it.
- **8-class fault library (`missionreplay/faultLib.js`)** with injected vs.
  emergent (rule-detected, `injected: false`) events and a
  `OVERRANGE_SENSOR` (-32000) dropout sentinel; docs updated.
- **Tests:** `tests/missionreplay/missionreplay.test.js` (32 cases:
  determinism, manifest, idx seek, interpolation, fault-boundary snapping,
  3-tier anomaly overlay, CAN round trip/status) and
  `tests/server/missionReplay.test.js` (11 HTTP cases). Full suite green, lint clean.

## [1.1.0] - 2026-09-19

Production-hardening release. Telemetry is still fully simulated and the
analytics are still unvalidated against real engines; this release is about
running the prototype reliably, safely and observably.

### Added
- **Groq fallback for AI narratives.** `ai/providers.js` runs a provider pool
  (Gemini first, then Groq; order via `AI_PROVIDER_ORDER`) with a
  per-provider circuit breaker and cooldown (`AI_PROVIDER_COOLDOWN_MS`,
  default 5 min) and per-provider request spacing (`GEMINI_MIN_GAP_MS`,
  `GROQ_MIN_GAP_MS`). If no provider is available a rule-based sentence is used.
  Analysis objects now carry `provider`, `fallbackUsed`, `degraded`,
  `cooldownUntil` and `fallbackReason`.
- **Health probes:** `GET /api/health` (liveness) and `GET /api/ready`
  (readiness: fleet snapshot present, data directory writable, not shutting down).
- **Central configuration** (`config.js`) with fail-fast validation, plus new
  variables: `NODE_ENV`, `HOST`, `CORS_ORIGIN`, `TRUST_PROXY`, `LOG_LEVEL`,
  `SHUTDOWN_TIMEOUT_MS`, `RATE_LIMIT_*`, `ADMIN_API_KEY`, `TICK_MS`,
  `SOCKET_MAX_PER_IP`, `SOCKET_MAX_TOTAL`, `MAX_CONCURRENT_MISSIONS`,
  `TWIN_DATA_DIR`, `TWIN_MAX_MISSIONS_PER_ENGINE`, `TWIN_MAX_READINGS_PER_MISSION`, and the `AI_*` / `GROQ_*`
  settings. `.env.example` is now a complete, grouped reference.
- **Security middleware** (`middleware/`): helmet with a CSP matching the
  dashboard, CORS allowlist for REST and Socket.IO, per-IP rate limiting
  (stricter tier for mission runs, replay and AI refresh), Socket.IO
  connection caps, optional `ADMIN_API_KEY` (`x-api-key`) guard on mutating
  routes, request body size limit, uniform JSON errors.
- **Structured logging** with request ids (`X-Request-Id`), JSON in production.
- **Graceful shutdown** on SIGTERM/SIGINT within `SHUTDOWN_TIMEOUT_MS`.
- **Persistence controls:** configurable data directory and per-engine mission
  retention.
- **Dashboard:** AI provider labelling (fallback/degraded), stale-telemetry
  banner, accessibility improvements.
- **Tests:** `node:test` suites in `tests/server`, `tests/ai`, `tests/core`;
  `npm test`, `npm run test:server|ai|core`.
- **Tooling:** ESLint flat config (`npm run lint`, `lint:fix`, `check`),
  `.editorconfig`, `.gitattributes`, expanded `.gitignore`.
- **Docker:** multi-stage `Dockerfile` (non-root, healthcheck, `/data`
  volume), `.dockerignore`, `docker-compose.yml` (read-only root FS, `env_file`,
  restart policy, healthcheck).
- **CI:** GitHub Actions workflow - lint and tests on Node 20 and 24,
  non-blocking `npm audit`, Docker build and smoke test.
- **Docs:** `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, rewritten README
  sections (configuration, API, AI fallback, testing, Docker); architecture,
  model card and roadmap updated for the Gemini + Groq design.

### Changed
- `npm run dev` now uses `node --watch server.js`.
- `package.json`: version 1.1.0, `private: true`, `engines.node >= 20`.
  Runtime dependency additions (`helmet`, `express-rate-limit`, `three`) and dev
  tooling (`eslint`, `@eslint/js`, `globals`) are recorded in `package-lock.json`.
- `server.js` exports `createServer()` (no side effects on import) so the API
  can be tested; running it directly still starts the server.
- Production defaults to same-origin CORS instead of allowing every origin.

### Fixed
- `oilLoss` simulated fault drifted too weakly to ever reach the critical
  oil-pressure threshold (so it raised no alerts); drift strengthened.
- Overheat-resolution test now collects alerts across ticks instead of relying
  on the newest-8 snapshot window. Removed unused variables flagged by lint.

### Known limitations
- Single-instance only: fleet state, AI cache and replay sessions are in-process
  memory and Socket.IO uses the in-memory adapter (see `docs/DEPLOYMENT.md`).
- The bundled dashboard does not send `x-api-key`, so its **Explain now**
  button is rejected when `ADMIN_API_KEY` is set.
- The Inter web font is still loaded from Google Fonts (system-font fallback otherwise).
- Models and narratives remain unvalidated against real engine data; this is
  advisory/demo software and not certified for operational use.

## [1.0.0]

- Initial prototype: simulated 3-UAV fleet, live dashboard, rule-based and
  advanced analytics, physics mission simulator with replay, 3D twin, and
  Gemini-based AI situation reports.
