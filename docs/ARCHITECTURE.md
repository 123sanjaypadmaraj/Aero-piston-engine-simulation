# Architecture — Aero Piston Engine Digital Twin

This document maps the 5-layer digital twin architecture from the master
implementation plan onto what actually exists (or is being built) in this
repository. It is written against the real code, not an idealized target —
where the plan called for something this prototype does not implement, that
is stated plainly rather than glossed over.

## The 5 layers, as implemented here

| Layer | Plan's role | This repo |
|---|---|---|
| L0 — Virtual engine | Ground-truth engine physics | `simulator.js`'s live-fleet `EngineTwin` (random-walk + fault drift) drives the always-on dashboard feed; `engine_sim/`'s mean-value physics model (Wiebe-style combustion, ISA altitude derating, thermal lag) is wired in separately via the on-demand mission runner — both exist side by side, see "Two ground-truth sources," below |
| L1 — Data acquisition / edge | Sensor realism, framing, transport | `simulator.js`'s per-sensor noise/random-walk + threshold classification; transport is **Socket.IO**, not CAN/MQTT (see "What was not built," below) |
| L2 — Digital twin core | Ingest, live state, history, APIs | `server.js` (Express REST + Socket.IO broadcast); `twin_core/store.js` persists every `engine_sim/` mission run to disk (JSON-Lines) and backs the replay endpoints |
| L3 — AI/ML analytics | Anomaly detection, RUL, explainability | `analytics/` (rate-aware health index, multivariate Mahalanobis anomaly detector, RUL estimator, offline explainability) runs **inside** `simulator.js`'s per-tick `EngineTwin.step()` — its output rides along on every engine's `analytics` field in `/api/snapshot`; `ai/` (RAG "situation report" via Gemini with automatic Groq fallback, then a rule-based sentence) runs alongside it in `server.js` |
| L4 — Dashboard / replay | Operator HMI, mission replay | `public/` (vanilla HTML/CSS/JS dashboard with a self-hosted canvas chart) consumes the live feed; `replay/` streams a recorded `engine_sim/` mission back out over the `replay-frame` Socket.IO event at variable speed, driven by `server.js`'s `/api/engine-sim/replay/*` routes |

### Two ground-truth sources, on purpose

There are two independent engine models in this repo, not one — this was a
deliberate integration choice, not an oversight:

- **`simulator.js`'s `EngineTwin`** — a lightweight mean-reverting random
  walk. It drives the always-on 3-UAV fleet feed (`TICK_MS = 2000` in
  `server.js`) that the live dashboard renders continuously.
- **`engine_sim/`'s `PhysicsEngine`** — the real mean-value thermodynamic
  model (Phase 1 of the master plan). It is invoked on demand, per mission,
  through `POST /api/engine-sim/run` (see `server.js`), which runs it
  end-to-end via `replay/missionRunner.js`, persists every tick through
  `twin_core/store.js`, and returns a summary — this is the "generate a
  labeled dataset for ML training" and "run a mission profile" workflow from
  Phases 1/5/6 of the plan.

`analytics/`'s health-index/anomaly/RUL layer is wired only into
`simulator.js`'s live loop today (every `/api/snapshot` tick carries an
`analytics` field). It is not yet also called from inside
`engine_sim/`'s mission runner — a recorded `engine_sim/` mission can be
replayed on the dashboard via `replay-frame` events, but does not currently
get its own live analytics computed during the run itself. Wiring
`analytics/` into `replay/missionRunner.js`'s per-tick callback is the
natural next step (see `docs/ROADMAP.md`).

## Data flow

```
                    ┌─────────────────────────────────────────────┐
                    │                 L4 Dashboard                 │
                    │   public/index.html + app.js (Socket.IO      │
                    │   client) — live gauges, health rings,       │
                    │   alert feed, AI situation report panel      │
                    └───────────────▲───────────────┬─────────────┘
                                    │ snapshot / ai-analysis         │ /api/ai-analysis/:id/refresh
                                    │ (Socket.IO push, 2s tick)      │ (on-demand POST)
                    ┌───────────────┴───────────────▼─────────────┐
                    │              L3 AI/ML Analytics               │
                    │  simulator.js: rolling z-score + threshold    │
                    │  health/RUL/predicted-fault model (today)     │
                    │  analytics/: rate-aware health index,         │
                    │  multivariate anomaly detector, RUL model     │
                    │  ai/: retriever.js + providers.js (Gemini →   │
                    │  Groq) + analysisEngine.js — RAG narrative   │
                    └───────────────▲───────────────────────────────┘
                                    │ per-tick engine snapshot (readings, statuses, health, RUL, faults)
                    ┌───────────────┴───────────────────────────────┐
                    │              L2 Digital Twin Core               │
                    │  server.js: Express REST API (/api/snapshot,   │
                    │  /api/series/:id, /api/alerts, /api/meta) +    │
                    │  Socket.IO broadcast loop (TICK_MS = 2000ms)   │
                    │  twin_core/: persisted history, mission store  │
                    └───────────────▲───────────────────────────────┘
                                    │ readings, statuses, alerts (per-engine, per-tick)
                    ┌───────────────┴───────────────────────────────┐
                    │         L1 Data Acquisition / Edge               │
                    │  simulator.js: per-sensor noise, threshold       │
                    │  classification (nominal/warning/critical)       │
                    │  — transport is an in-process Socket.IO emit,    │
                    │  not a CAN/MQTT bus (see below)                  │
                    └───────────────▲───────────────────────────────┘
                                    │ true physical state (RPM, CHT, EGT, oil P/T, fuel flow, vibration, MAP, battery V)
                    ┌───────────────┴───────────────────────────────┐
                    │            L0 Virtual Engine                     │
                    │  simulator.js: EngineTwin mean-reverting random  │
                    │  walk + fault drift (today)                      │
                    │  engine_sim/: mean-value physics model, mission  │
                    │  profiles, parametrized fault-injection curves   │
                    └───────────────────────────────────────────────┘

     Maintenance advisories / fault predictions / AI narratives flow back
     UP through the same stack to the dashboard (there is no downward
     command path — this prototype is observe-only, it does not actuate
     anything on the simulated engine).
```

## What was **not** built (vs. the original master plan)

The master plan specified CAN-bus simulation via Linux `vcan`/SocketCAN +
`python-can`, an MQTT broker for telemetry transport, and a Python/FastAPI +
TimescaleDB/InfluxDB backend. None of that is present in this repository:

- **No CAN bus.** `vcan`/SocketCAN is Linux-only kernel functionality; this
  prototype was developed and runs on Windows, so there is no virtual CAN
  interface, no arbitration-ID frame encoding, and no DBC-style signal
  definitions. `simulator.js`'s `EngineTwin.step()` produces a JSON reading
  object directly — there is no bus-framing step to decode.
- **No MQTT.** Telemetry transport is **Socket.IO** (`server.js`, `io.emit('snapshot', ...)`)
  over a local Express HTTP server, not a pub/sub broker with topics like
  `engine/<tail>/<parameter>`. This is architecturally simpler (no broker
  process to run) but does not exercise a real message-bus pattern
  (no independent publishers/subscribers, no QoS, no topic-based routing).
- **No Python/FastAPI/TimescaleDB.** The entire backend is Node.js/Express.
  Time-series storage, where implemented at all, lives in `twin_core/`
  as part of this same Node process rather than a dedicated time-series
  database.

None of this blocks the functional goal (a working health-monitoring +
fault-prediction + dashboard loop over simulated data) — Socket.IO
legitimately plays the "telemetry bus" role end-to-end, and the REST/socket
API surface in `server.js` is exactly what would stay unchanged if a real
CAN/MQTT ingest layer were dropped in later (see `docs/ROADMAP.md`). But if
"CAN bus simulation" or "MQTT" specifically are graded/scored deliverables,
they are gaps, not just implementation-detail differences, and should be
called out as such rather than implied as done.

## Module responsibilities (current + planned)

- **`simulator.js`** — today's L0/L1: per-engine true-state random walk,
  four fault scenarios (`FAULT_TYPES`), threshold classification, rolling
  z-score anomaly scoring, rule-based health/RUL/predicted-fault
  computation, alert generation. See `docs/FAULT_TAXONOMY.md` and
  `docs/MODEL_CARDS.md`.
- **`engine_sim/`** — mean-value physics engine model, ISA-based altitude
  derating, mission-profile drivers, parametrized degradation-curve fault
  injection. Wired into `server.js` via `POST /api/engine-sim/run` and
  `GET /api/engine-sim/profiles` — a separate, on-demand ground-truth source
  from `simulator.js`'s always-on live fleet feed (see "Two ground-truth
  sources," above).
- **`server.js`** — L2: Express static file serving + REST API + Socket.IO
  broadcast loop; owns the fleet tick interval (`TICK_MS`) and the
  `engine_sim`/`replay`/`twin_core` mission routes.
- **`twin_core/`** — L2: `store.js` persists every `engine_sim/` mission
  tick to `twin_core/data/<engineId>/<missionId>.jsonl` (buffered writes,
  streamed reads); `stateStore.js` is an in-memory live-state cache
  (a Redis stand-in) not yet wired into `server.js`.
- **`analytics/`** — L3: statistical/ML layer beyond the inline rules in
  `simulator.js`, called from inside `EngineTwin.computeAdvancedAnalytics()`
  every live tick — rate-of-change-aware health indexing, multivariate
  Mahalanobis anomaly detection (with a warm-up fit on the engine's own
  healthy telemetry), RUL estimation, and offline explainability, all
  exposed on each engine's `analytics` field in `/api/snapshot`.
- **`ai/`** — L3: RAG-based plain-language "situation report" per engine
  (`knowledgeBase.js` + `retriever.js` + `analysisEngine.js`), calling an LLM
  through `providers.js`: Gemini first, Groq as fallback (`geminiClient.js`,
  `groqClient.js`), with a per-provider circuit breaker/cooldown and
  per-provider request spacing. When no key is configured, or every provider
  fails or is cooling down, a rule-based one-line summary is cached instead
  and flagged `degraded`. Each analysis records `provider`, `fallbackUsed`
  and `degraded`.
- **`replay/`** — L4: `missionRunner.js` drives `engine_sim/`'s
  `PhysicsEngine` end-to-end and persists it via `twin_core/`;
  `replayEngine.js` plays a recorded mission back out, paced by its
  original timestamps, over the `replay-frame` Socket.IO event
  (`server.js`'s `/api/engine-sim/replay/:engineId/:missionId` and
  `/control` routes start/pause/resume/seek/stop it).
- **`public/js/twin3d.js`** — L4: the 3D visual twin (three.js). Consumes
  the same per-engine snapshot as the dashboard (`window.twin3d.update`),
  never recomputes status client-side, and uses `/api/meta` SENSORS bands
  only to scale visual intensity (glow, shake, flow rate).
- **`public/`** — L4: the operator dashboard (vanilla JS, self-hosted charts),
  consuming `server.js`'s REST API and Socket.IO stream. Does not yet have
  UI for triggering `engine_sim/` missions or `replay-frame` playback —
  those are API-only today (see `docs/ROADMAP.md`).

## Runtime hardening and operations (v1.1)

Cross-cutting pieces added around the layers above (none change the data
model):

- **`config.js`** — parses and validates every server-level environment
  variable once, fails fast with a list of all problems, and never logs
  secrets. (`GEMINI_*`, `GROQ_*`, `AI_*` and `TWIN_*` variables are read by
  the modules that own them.) Full reference: `.env.example`.
- **`middleware/`** — `security.js` (helmet with a CSP matching what
  `public/index.html` loads, CORS allowlist for REST and Socket.IO,
  `express-rate-limit` with a stricter tier for mission run / replay / AI
  refresh, optional `ADMIN_API_KEY` guard on mutating routes), `logger.js`
  (structured JSON logs in production, request ids), `errors.js` (uniform
  `{ error, detail? }` responses, no internals in production), `validate.js`
  (input validation for route parameters and bodies).
- **Probes** — `GET /api/health` (liveness) and `GET /api/ready` (readiness:
  fleet snapshot exists, data directory writable, not shutting down) are
  registered before the rate limiter.
- **Lifecycle** — `createServer()` builds the app without side effects
  (used by tests); running `server.js` directly installs SIGTERM/SIGINT
  handlers that stop the tick loop and replays, close sockets and exit within
  `SHUTDOWN_TIMEOUT_MS`.
- **State and scaling** — the live fleet, alert history, AI cache/cooldowns
  and replay sessions are in-process memory; only `engine_sim/` mission
  recordings are persisted (`TWIN_DATA_DIR`, bounded by
  `TWIN_MAX_MISSIONS_PER_ENGINE`). Together with Socket.IO's in-memory adapter
  this means the service is **single-instance** by design (see
  `docs/DEPLOYMENT.md`).
- **Tests and CI** — `tests/server`, `tests/ai`, `tests/core` (`node:test`),
  ESLint flat config, and a GitHub Actions workflow (lint, test on Node 20/24,
  audit, Docker build).
