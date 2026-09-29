# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-09-29

Mission replay, an artificial J1939 CAN bus, ground-truth evaluation of the
detectors, a deterministic safety verdict for the AI box, and MISSION LAB — an
operator console that puts all of it behind buttons. Telemetry remains fully
simulated and the models remain unvalidated against real engines.

### Added
- **Deterministic combined-signature verdict (`ai/retriever.js`).**
  `classifySignature()` separates the accident class from mere degradation using
  the knowledge base's combined patterns rather than single-channel severity, and
  is wired into `ai/analysisEngine.js` as a safety floor the LLM must respect.
  It is computed locally before any provider call, so it is identical with or
  without an AI key, and is attached to both successful and degraded results.
  Only `warning`/`critical` count as off-nominal, so empty, null, unknown and
  healthy status maps can no longer manufacture an accident.
- **MISSION LAB** (`public/js/missionlab.js`, `public/css/missionlab.css`): a
  collapsed-by-default panel that surfaces the 11 mission-replay routes, the CAN
  bus, the AI box verdict, and the ground-truth evaluation the dashboard never
  reached. Fault injection (8 types x 4 severities, two presets), generation,
  a mission library, play/pause/seek/scrub/speed transport, per-channel readouts,
  a phase bar, the anomaly overlay, precision/recall/F1 per detector, and live
  CAN frame decode. Ships additively inside one `<details>` block and is inert
  until `DOMContentLoaded`.
- **Mission replay client tests** (`tests/frontend/missionlab.test.js`, 24
  cases) in a `node:vm` DOM stub: classifier behaviour, preset symmetry, the
  index.html element contract, and an assertion that the module never touches a
  non-`ml`-prefixed id.
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
- **Cross-pipeline evaluation.** `analytics/missionReplayMetrics.js` closes
  the loop for the first time: it runs the L3 health model over a generated
  mission log and scores each detector — the rule-based consecutive-sample
  detector vs. the analytics health index (self-calibrated to the mission's
  own known-good baseline, with an absolute-threshold override) — against the
  injected ground truth. Output: sample-level precision/recall/F1 per
  detector, per-fault detection latency, a margin sweep, and emergent
  (false-alarm) events. Exposed at `GET /api/mission-replay/:missionId/
  evaluation` and as `scripts/evaluate-missionreplay.js`. This is the piece that
  makes the detectors falsifiable: an injected fault that nobody detects is a
  visible number, not an opinion.
- **Artificial J1939 CAN bus (`missionreplay/can.js`).** 29-bit arbitration
  IDs, 11-signal PGN map, 5 nodes, uint16 byte-scale encode/decode round trip,
  bounded receive ring buffer with dropped-frame accounting. Wired to
  `GET /api/can/status`; live mission-replay playback streams frames onto it.
- **8-class fault library (`missionreplay/faultLib.js`)** with injected vs.
  emergent (rule-detected, `injected: false`) events and a
  `OVERRANGE_SENSOR` (-32000) dropout sentinel; docs updated.
- **Tests:** `tests/missionreplay/missionreplay.test.js` (32 cases:
  determinism, manifest, idx seek, interpolation, fault-boundary snapping,
  3-tier anomaly overlay, CAN round trip/status),
  `tests/server/missionReplay.test.js` (14 HTTP cases incl. the evaluation
  endpoint, regeneration invalidation and auto-seed reproducibility) and
  `tests/analytics/missionReplayMetrics.test.js` (7 cross-
  pipeline cases: self-calibrated scoring, clean-mission quietness,
  determinism, dropout latency, margin sensitivity). Full suite green, lint clean.

### Changed
- `classifySignature()` and the MISSION LAB verdict mirror now share one severity
  rule, so "off-nominal" always means `warning | critical` and never truthiness.
  Previously a non-empty status string for an unknown channel counted as
  off-nominal and could escalate degradation to accident.
- MISSION LAB's replay bands are derived from the generator's own
  `PHASE_PROFILES` targets and `PARAM_DEFS` sigma rather than hand-picked
  constants, and a phase's envelope spans its neighbours' targets so a channel
  ramping between two phases is not misread. `scripts/calibrate-missionlab-bands.js`
  reproduces the calibration; a clean mission now scores zero off-nominal
  samples across its whole flight (it previously produced 440 false alarms).
- MISSION LAB labels the accident class as unreachable from replay data, and
  says why: a replay frame carries no manifold-pressure channel and no replay
  fault type moves RPM, so the highest class the mirror can reach is
  degradation. The accident demo lives on the live-fleet verdict card, where the
  simulator does drive RPM and manifold pressure.

### Fixed
- `POST /api/mission-replay/generate` no longer leaves a stale record cached.
  Regenerating an existing `missionId` returned a fresh manifest and fault list
  but the read routes kept serving the previous run from the in-process player
  cache, so a re-injected fault was invisible through the whole API. The cache
  entry is now dropped after a successful write.
- MISSION LAB step-back sends a seek one sample earlier instead of `step: -1`,
  which the server rejected with HTTP 400 (control values are validated in
  `[1, 10000]`), making the ◀ button a no-op.
- MISSION LAB's two presets actually inject their faults. They were written with
  the server's `onset_s`/`duration_s` keys while the form rows read
  `onset`/`duration`, so both presets generated completely faultless missions
  while showing three fault rows in the UI.
- MISSION LAB's clock and scrubber read the resolved instant (`state.t_s`) rather
  than a top-level `t_s`, which `mission-replay-frame` socket payloads do not
  carry — both rendered `undefined` during live playback.
- MISSION LAB's mission list no longer prints the server's absolute filesystem
  path for each mission, and the CAN frame list is capped at the newest 24
  frames so a running playback does not bury the rest of the panel.
- MISSION LAB's seed field is labelled `auto` rather than `random` or
  `deterministic`: a blank seed is derived by hashing mission id, duration, rate,
  fault stack and phase schedule, so identical inputs reproduce an identical
  flight and any change to them yields a different one.

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
