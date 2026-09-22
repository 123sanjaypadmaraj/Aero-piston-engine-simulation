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
| L1 — Data acquisition / edge | Sensor realism, framing, transport | `simulator.js`'s per-sensor noise/random-walk + threshold classification; live transport is **Socket.IO**; the synthetic mission recorder additionally pushes replay frames through an in-process **artificial J1939-flavoured CAN bus** (`missionreplay/can.js`) exposed at `/api/can/status` (see below) |
| L2 — Digital twin core | Ingest, live state, history, APIs | `server.js` (Express REST + Socket.IO broadcast); `twin_core/store.js` persists every `engine_sim/` mission run to disk (JSON-Lines) and backs the replay endpoints |
| L3 — AI/ML analytics | Anomaly detection, RUL, explainability | `analytics/` (rate-aware health index, multivariate Mahalanobis anomaly detector, RUL estimator, offline explainability) runs **inside** `simulator.js`'s per-tick `EngineTwin.step()` — its output rides along on every engine's `analytics` field in `/api/snapshot`; `ai/` (RAG "situation report" via Gemini with automatic Groq fallback, then a rule-based sentence) runs alongside it in `server.js` |
| L4 — Dashboard / replay | Operator HMI, mission replay | `public/` (vanilla HTML/CSS/JS dashboard with a self-hosted canvas chart) consumes the live feed; `replay/` streams a recorded `engine_sim/` mission back out over the `replay-frame` Socket.IO event at variable speed, driven by `server.js`'s `/api/engine-sim/replay/*` routes; `missionreplay/` adds a **second, spec-driven** replay path — deterministic synthetic mission logs (JSON-Lines telemetry + manifest + fault table + byte-offset index) served over `/api/mission-replay/*` |

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
TimescaleDB/InfluxDB backend. This remains true of the **live** telemetry
path — `simulator.js`'s fleet feed is still emitted directly over Socket.IO.
The mission-replay recorder, however, gained a pure-JS replacement:

- **No real vcan/SocketCAN.** `vcan` is Linux-only kernel functionality and
  this prototype runs on Windows, so frames can never ride a kernel virtual
  interface here. In its place, `missionreplay/can.js` implements a
  *J1939-flavoured artificial CAN bus in JS*: 29-bit arbitration IDs (CAN
  ID layout with priority / PGN / source address), an 11-signal PGN map, a
  5-node table (ECU, oil system, thermal, fuel system, MEMS), uint16
  byte-scale signal encoding, a bounded ring-buffer receive window with
  dropped-frame accounting, and a bit-perfect `encodeSample`/`decodeFrames`
  round trip. The bus is a first-class citizen of the deterministic mission
  record (each logged sample also carries its CAN frames), and it is wired
  into `server.js` so that live mission-replay playback streams frames onto
  the bus while `GET /api/can/status` reports node/load/error state. There
  is still no *real* CAN adapter, no outside publisher/subscriber, and no
  DBC-style external schema — but the bus-framing + BAM-session + byte-scale
  encode/decode mechanics the master plan asked for now exist and are
  exercised by tests.
- **No MQTT.** Telemetry transport is **Socket.IO** (`server.js`, `io.emit('snapshot', ...)`)
  over a local Express HTTP server, not a pub/sub broker with topics like
  `engine/<tail>/<parameter>`. This is architecturally simpler (no broker
  process to run) but does not exercise a real message-bus pattern
  (no independent publishers/subscribers, no QoS, no topic-based routing).
- **No Python/FastAPI/TimescaleDB.** The entire backend is Node.js/Express.
  Time-series storage, where implemented at all, lives in `twin_core/`
  (and `missionreplay/`'s JSON-Lines mission logs) as part of this same Node
  process rather than a dedicated time-series database.

None of this blocks the functional goal (a working health-monitoring +
fault-prediction + dashboard loop over simulated data) — Socket.IO
legitimately plays the "telemetry bus" role end-to-end, and the REST/socket
API surface in `server.js` is exactly what would stay unchanged if a real
CAN/MQTT ingest layer were dropped in later (see `docs/ROADMAP.md`). On the
grading question: "CAN bus simulation" is now *partially* covered — `missionreplay/`
demonstrates J1939-style arbitration-ID framing, byte-scale signal
encode/decode, a multi-node bus, and a status endpoint, but on an
in-process JS bus rather than a Linux `vcan`/SocketCAN interface. MQTT is
still a genuine gap, not just an implementation-detail difference, and
should be called out as such rather than implied as done.

## Mission replay synthesis + artificial CAN (`missionreplay/`)

This subsystem generates **deterministic, labeled mission logs** for the
"labeled synthetic training data" workflow the master plan's Phases 1/5/6
called for. It is deliberately independent from `engine_sim/` + `replay/`:
its ground truth is a phase-profile planner (`profiles.js`) rather than the
mean-value physics model, so the two recorder families can cross-check each
other. Everything downstream of generation is expressed against the logical
sample time `t_s`, not wall-clock (no async drift).

- **Synthesis pipeline** (`generator.js`) — for each 1 s sample: eased phase
  target (cosine over a 15 s transition window) → first-order lag (thermal
  params respond slowly) → gaussian noise from the seeded RNG → fault overlay
  → clamps. Each run is **byte-identical to any other run with the same
  seed**; the seed defaults to an FNV hash of the mission id + inputs and can
  be pinned deliberately so a "regenerate the same flight tomorrow" test is
  possible. Output: `manifest.json` (`schema_version: "1.0"` gate), the JSON-
  Lines telemetry log, `faults.json` (time-windowed events), `telemetry.idx`
  (byte offset per line so the loader can seek in O(1)), and `can.jsonl`
  when CAN recording is on.
- **Fault injection** (`faultLib.js`) — 8 fault classes run on an
  onset/detected/resolved time window with a `precursor_window_s`:
  `oil_pressure_degradation`, `oil_starvation`, `fuel_starvation`,
  `detonation_risk`, `vibration_anomaly`, `overheating`, `plug_fouling`,
  `sensor_dropout`. Injection degrades a severity-multiplied parameter over
  the window; a detection-rule table marks the `detected_s` (fires only on
  N consecutive out-of-band samples, with margin guards so phase ramps don't
  trip it). Events injected by the operator are `injected: true`; events
  that emerge from the detection rules alone are `injected: false` and
  recover automatically. Sensor dropout serialises as the
  `OVERRANGE_SENSOR = -32000` sentinel (JSON has no NaN).
- **Replay** (`replay.js`) — `stateAt(t_s)` returns an interpolated sample
  (floor-index + linear interpolation) but *snaps* cleanly across a fault
  onset/resolution boundary rather than blending, `getRange` returns
  time-bounded, sample-bounded slices, `.seek/.step/.play/.pause/.resume/
  .stop` drive a playhead, and a **3-tier anomaly overlay** labels every
  sample `nominal` / `precursor` / `active` based on detected fault windows.
- **Artificial J1939 CAN** (`can.js`) — a JS-only replacement for the
  Linux `vcan`/SocketCAN plan (see "What was not built," above): each
  engine signal has its own PGN, is byte-scaled into uint16, and is loaded
  into 29-bit arbitration IDs; a 5-node bus with a bounded receive window
  and dropped-frame counters exposes `createCanBus().status()`.
- **HTTP surface** (`server.js`) — `POST /api/mission-replay/generate`,
  `GET /api/mission-replay/:missionId/{manifest,faults,phases}`,
  `GET /api/mission-replay/:missionId/{state,range,snapshot}`,
  `POST /api/mission-replay/:missionId/control` (seek/step/play/pause/
  resume/stop), and `GET /api/can/status`. Live `play` frames are also
  emitted as `mission-replay-frame` Socket.IO events and pushed onto the
  bus so the CAN status endpoint shows live traffic.

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
- **`missionreplay/`** — L4+ (spec-driven synthetic recorder + replay +
  artificial CAN): `profiles.js` (7-phase mission schedule, cosine transition
  windows, per-parameter noise/clamps/lag), `faultLib.js` (8 injected fault
  classes with time-windowed degradation and consecutive-sample detection
  rules), `can.js` (J1939-flavoured artificial bus: 29-bit arbitration,
  11-signal PGN map, 5 nodes, byte-scale encode/decode round trip),
  `generator.js` (deterministic `generateMission({seed})` — seed from the
  mission id unless overridden; writes `manifest.json`, `telemetry.jsonl`,
  `faults.json`, a byte-offset index `telemetry.idx`, and optionally
  `can.jsonl`), `loader.js` (schema-gated load + O(1) seek on the offset
  index), `replay.js` (interpolated `.stateAt/.getRange`, fault-boundary
  snapping, 3-tier anomaly overlay). Served by `server.js` at
  `/api/mission-replay/*` and `/api/can/status`; detailed design in
  "Mission replay synthesis + artificial CAN" below.
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
