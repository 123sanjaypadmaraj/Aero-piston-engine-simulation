# AI-Enabled Real-Time Digital Twin — Aero Piston Engine Health Monitoring

Smart India Hackathon prototype for **health monitoring, fault prediction, and
mission reliability enhancement** of aero piston engines used in MALE UAVs.

This prototype simulates a fleet of 3 UAVs (Rotax-912-class piston engines),
streams spoofed sensor telemetry from a backend in real time, and visualizes
engine health, predicted faults, and mission reliability on a live dashboard.

## What it does

- **Backend (`server.js` + `simulator.js`)** — a Node/Express server that
  generates realistic, continuously-varying telemetry for 9 sensors per
  engine (RPM, cylinder head temp, exhaust gas temp, oil pressure/temp, fuel
  flow, vibration, manifold pressure, battery voltage), occasionally injects
  one of four fault scenarios (thermal overload, oil pressure loss,
  mechanical imbalance/vibration, fuel system degradation), and streams it
  over **Socket.IO** every 2 seconds. This stands in for the real UAV
  telemetry downlink / FADEC bus.
- **Fault prediction** — a lightweight statistical model (rolling
  mean/standard-deviation z-scores per sensor + threshold rules) computes a
  0–100 health score, a remaining-useful-life estimate, and a predicted
  fault type/confidence *before* thresholds are fully crossed — no external
  ML runtime required, so the whole stack runs with just Node.js.
- **Frontend (`public/`)** — a live dashboard (vanilla HTML/CSS/JS with
  self-hosted canvas charts) showing fleet-wide mission reliability, per-engine health rings,
  a sensor grid with live status coloring, trend charts, and a fault
  prediction / alert feed — styled in an SIH-inspired navy/saffron/tricolor
  theme.

- **3D digital twin (`public/js/twin3d.js`)** — a procedural
  horizontally-opposed six-cylinder engine (modelled on
  `public/img/engine-photo.png`) rendered with three.js and driven by the same
  live telemetry: crank/prop speed follows RPM (shown in slow motion), cylinder
  heads and headers glow with CHT/EGT, the whole engine shakes with vibration,
  air/fuel/exhaust/oil particles flow at rates tied to their sensors, and every
  component glows nominal/warning/critical from the backend status. Pistons
  and connecting rods use real slider-crank kinematics on a phased boxer
  crank. Controls: orbit/zoom, camera presets, X-ray (see pistons, rods,
  crank and per-cylinder firing flashes), explode, flow layers, click any
  component for its reading, trend and what the sensor means. three.js is
  served from `node_modules` (`/vendor/three`), so it works offline.

- **AI Engine Situation report (`ai/`)** — a lightweight retrieval-augmented
  generation (RAG) layer that turns each engine's live telemetry into a
  plain-language explanation using an LLM (**Gemini**, with automatic **Groq** fallback): a small hand-curated
  knowledge base of engine/fault domain facts (`ai/knowledgeBase.js`) is
  retrieved by tag-matching against the engine's current active/predicted
  fault and any out-of-band sensors (`ai/retriever.js`), then grounded into
  a prompt sent to the provider pool (`ai/providers.js`, `ai/geminiClient.js`,
  `ai/groqClient.js`), orchestrated with caching, event-driven + interval-based
  refresh, and graceful fallback (`ai/analysisEngine.js`). See **AI Engine Situation Analysis** below.

- **Spec-driven mission replay + artificial CAN (`missionreplay/`)** — a
  separate synthetic recorder that generates **deterministic, labeled mission
  logs** (7-phase profile → eased transitions → lagged, noisy telemetry →
  time-windowed fault injection → clamped output) with an operator-supplied
  seed, then replays them with interpolation, fault-boundary snapping and a
  3-tier anomaly overlay. Each generated mission log is byte-identical across
  runs with the same seed, which makes it a ready source of labeled training
  data. A J1939-flavoured artificial CAN bus (`missionreplay/can.js`) pushes
  replay frames onto a 5-node bus exposed at `GET /api/can/status`. See
  **Spec-driven mission replay & artificial CAN** below.

## Quick start

Requires **Node.js >= 20** (developed on Node 24).

```bash
npm install
cp .env.example .env     # optional - every variable has a default
npm start                # launches server.js and opens the dashboard
```

Then open **http://localhost:5000**. `npm start` runs `start.js` (installs
dependencies if missing, starts the server, opens a browser). For servers,
containers and process managers run `node server.js` directly, or `npm run dev`
for auto-restart on file changes.

The dashboard's charts (`public/js/charts.js`), three.js and the Socket.IO
client are served locally; only the Inter web font is fetched from Google Fonts
(the page falls back to system fonts without it).

### Configuration

All configuration is via environment variables (`.env` is loaded
automatically). **Every variable is optional**; `.env.example` is the fully
commented reference. Invalid values make the server fail fast at startup with
a message listing every problem.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` => CORS same-origin by default, no error detail in API responses, HSTS header |
| `PORT` / `HOST` | `5000` / `0.0.0.0` | Listen port / bind address |
| `CORS_ORIGIN` | unset | Comma-separated origin allowlist. Unset = open in dev, same-origin in production; `*` = open |
| `TRUST_PROXY` | unset | `true`, hop count (`1`) or subnet list; set when behind a reverse proxy |
| `LOG_LEVEL` | `info` | `silent` | `error` | `warn` | `info` | `debug` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Max time to drain connections on SIGTERM/SIGINT |
| `TICK_MS` | `2000` | Live telemetry tick interval |
| `ADMIN_API_KEY` | unset | If set (>= 8 chars), mutating `POST` routes require an `x-api-key` header |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `RATE_LIMIT_MAX` | `120` | Requests per IP per window on `/api/*` |
| `RATE_LIMIT_HEAVY_MAX` | `10` | Per-window cap on expensive routes (mission run, replay, AI refresh) |
| `SOCKET_MAX_PER_IP` / `SOCKET_MAX_TOTAL` | `20` / `500` | Socket.IO connection caps |
| `MAX_CONCURRENT_MISSIONS` | `2` | Simultaneous `engine-sim/run` executions (extra requests get 429) |
| `GEMINI_API_KEY` | unset | Gemini key (primary AI provider) |
| `GEMINI_MODEL` | see `.env.example` | Gemini model name |
| `GEMINI_MIN_GAP_MS` | `13000` | Min gap between Gemini calls, fleet-wide |
| `GROQ_API_KEY` | unset | Groq key (fallback AI provider) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model name |
| `GROQ_MIN_GAP_MS` | `2000` | Min gap between Groq calls |
| `AI_PROVIDER_ORDER` | `gemini,groq` | Provider preference order |
| `AI_PROVIDER_COOLDOWN_MS` | `300000` | How long a provider is skipped after a quota/rate-limit failure |
| `AI_ANALYSIS_INTERVAL_MS` | `300000` | Min interval between automatic re-analyses of an unchanged engine |
| `TWIN_DATA_DIR` | `./twin_core/data` | Where mission recordings are stored (`/data` in Docker) |
| `TWIN_MAX_MISSIONS_PER_ENGINE` | `50` | Retention: oldest recordings beyond this are pruned |
| `TWIN_MAX_READINGS_PER_MISSION` | `50000` | Cap on readings stored per recording (further appends are dropped) |

Neither AI key is required. Set at least one to get LLM-written situation
reports; without any, the app runs in a degraded mode with rule-based summaries
(see **AI provider fallback** below).

### API

Base URL `http://localhost:5000`. Errors are JSON: `{ "error": "...", "detail"?: "..." }`.

| Method & path | Description |
|---|---|
| `GET /api/health` | Liveness probe: `{ ok, service, uptime }`. Never rate-limited. |
| `GET /api/ready` | Readiness probe: `200 { ready: true, checks: { fleet, store } }`, or `503` while starting, shutting down, or if the data directory is not writable. Never rate-limited. |
| `GET /api/snapshot` | Latest fleet snapshot (all engines, incl. `analytics` and `aiAnalysis`) |
| `GET /api/alerts` | Recent alerts |
| `GET /api/meta` | Sensor and fault metadata |
| `GET /api/series/:engineId` | Per-engine time series (e.g. `uav-01`) |
| `GET /api/ai-analysis` | AI situation reports, all engines |
| `GET /api/ai-analysis/:engineId` | AI situation report, one engine |
| `POST /api/ai-analysis/:engineId/refresh` | Force a fresh AI analysis now (*heavy*, admin key if configured) |
| `GET /api/engine-sim/profiles` | Available mission profiles |
| `POST /api/engine-sim/run` | Run and record a physics mission (*heavy*, admin key if configured) |
| `GET /api/engine-sim/recordings/:engineId` | List recorded missions |
| `GET /api/engine-sim/recordings/:engineId/:missionId` | Full recorded time series |
| `POST /api/engine-sim/replay/:engineId/:missionId` | Start a replay (*heavy*, admin key if configured) |
| `POST /api/engine-sim/replay/:engineId/control` | pause / resume / seek / speed / stop (admin key if configured) |
| `GET /api/mission-replay` | List generated mission-replay ids |
| `POST /api/mission-replay/generate` | Generate a deterministic mission log (*heavy*, admin key if configured) |
| `GET /api/mission-replay/:missionId/manifest` | Generated mission manifest (schema version, profile, RNG seed) |
| `GET /api/mission-replay/:missionId/faults` | Fault-event table (onset / detected / resolved / precursor window) |
| `GET /api/mission-replay/:missionId/phases` | Phase schedule (taxi / takeoff / climb / ... / landing) |
| `GET /api/mission-replay/:missionId/state` | Interpolated sample at `?t_s=` with anomaly overlay |
| `GET /api/mission-replay/:missionId/range` | Time/sample-bounded slice: `?start_s=&end_s=&maxSamples=` |
| `GET /api/mission-replay/:missionId/snapshot` | Current playhead state |
| `POST /api/mission-replay/:missionId/control` | seek / step / play / pause / resume / stop (admin key if configured) |
| `GET /api/can/status` | Artificial J1939 CAN bus: nodes, sent/dropped counts, ring-buffer load |

Socket.IO events (server -> client): `snapshot` (every tick, and once on
connect), `ai-analysis` (when a fresh analysis completes), `replay-frame`
(during an `engine_sim/` replay), `mission-replay-frame` (during a
`mission-replay` playback).

When `ADMIN_API_KEY` is set, every non-GET request under `/api` must send
`x-api-key: <key>`; GET routes and the dashboard stay open. The bundled
dashboard does not send this header, so its **Explain now** button will get
`401` when a key is set - see `docs/DEPLOYMENT.md`.

Every engine object in `/api/snapshot` also carries an `analytics` field -
a second, independent health/anomaly/RUL model (see **Advanced analytics**
below) computed alongside the original rolling z-score model.

## Physics-based mission simulation & replay (`engine_sim/`, `twin_core/`, `replay/`)

Separate from the always-on 3-UAV live feed above, `engine_sim/` implements
a proper mean-value physics model (Wiebe-style combustion heat release,
thermal lag, ISA altitude derating) that can run a full mission profile
on demand, persist every tick, and be replayed back later:

- List available mission profiles: `GET /api/engine-sim/profiles`
  (`climbCruiseDescent`, `highAltitudeLongEndurance`, `hotWeather`,
  `rapidThrottleTransients`)
- Run a mission end-to-end (persists to `twin_core/data/`, returns a
  summary; data directory is `TWIN_DATA_DIR`, and only the newest
  `TWIN_MAX_MISSIONS_PER_ENGINE` recordings per engine are kept): `POST /api/engine-sim/run`
  `{ "engineId": "uav-01", "profileId": "hotWeather", "durationSeconds": 3600, "faultTypes": ["overheat"] }`
  (`durationSeconds` 10-14400, default 1800; `dtSeconds` 0.5-30, default 2;
  `faultTypes` is optional — omit it to get a randomized 0-2 concurrent
  faults per run)
- List recorded missions for an engine: `GET /api/engine-sim/recordings/:engineId`
- Read a recorded mission's full time series: `GET /api/engine-sim/recordings/:engineId/:missionId`
- Replay a recorded mission at variable speed, streamed as `replay-frame`
  Socket.IO events: `POST /api/engine-sim/replay/:engineId/:missionId`
  `{ "speed": 10 }`
- Control an in-progress replay: `POST /api/engine-sim/replay/:engineId/control`
  `{ "action": "pause" | "resume" | "seek" | "speed" | "stop", "value": ... }`

The dashboard does not yet have UI for these — they're API/Socket.IO-only
for now (see `docs/ROADMAP.md`).

## Spec-driven mission replay & artificial CAN (`missionreplay/`)

A second, independent synthetic recorder built around an operator-supplied
spec rather than a physics sim. Every bounded step is committed to disk so a
**regenerated flight is byte-identical given the same seed** — the log itself
is the labeled training artifact:

- Generate a mission (default seed = FNV hash of mission id + inputs, or pin
  your own): `POST /api/mission-replay/generate`
  `{ "missionId": "MSN-2026-0001", "duration": 21600, "faults": [{ "type": "oil_pressure_degradation", "onset_s": 9000, "severity": "moderate" }], "seed": 42 }`
  (`duration` 30-86400 s, default 21600; `sampleRateHz` 1-10, default 1;
  `faults[].type` ∈ the 8 classes in `docs/FAULT_TAXONOMY.md`;
  `phases[]` optional override of the 7-phase schedule; `recordCan` optional)
- Writes `<TWIN_DATA_DIR>/missionreplay/<missionId>/` —
  `manifest.json` (schema version "1.0", engine model, phase schedule, RNG
  seed), `telemetry.jsonl` (one sample per `t_s`), `faults.json` (windowed
  fault events), `telemetry.idx` (byte offsets for O(1) seek) and optionally
  `can.jsonl`.
- Query it back: `GET /api/mission-replay/<missionId>/manifest|faults|phases`,
  `GET .../state?t_s=7000` (interpolated sample + anomaly tier), `GET
  .../range?start_s=&end_s=&maxSamples=` (bounded slice), `GET .../snapshot`.
- Advance a playhead: `POST /api/mission-replay/<missionId>/control`
  `{ "action": "seek" | "step" | "play" | "pause" | "resume" | "stop", "value": ... }`
  — `play` streams `mission-replay-frame` Socket.IO events and pushes every
  frame onto the artificial CAN bus.
- The artificial J1939 bus (`missionreplay/can.js`) uses 29-bit arbitration
  IDs, an 11-signal PGN map, a 5-node table and uint16 byte-scale encoding;
  `GET /api/can/status` reports node/load/error state.

## Advanced analytics (`analytics/`)

Layered on top of (not replacing) the original rolling z-score + threshold
model, every engine's live tick also runs through `analytics/`:

- a rate-of-change-aware health index that flags a sensor trending toward a
  warning/critical band *before* it crosses the static threshold, mapped
  onto the 8-category fault taxonomy from `docs/FAULT_TAXONOMY.md`
- a multivariate anomaly detector (Mahalanobis distance against a
  running mean/covariance fitted on the engine's own healthy telemetry)
  that catches a combination of individually-normal readings that is
  jointly implausible
- an RUL estimate with a confidence band, and an offline (no network call,
  runs every tick) explainability narrative — a free complement to the
  LLM-based situation report above

See `docs/MODEL_CARDS.md` for what each model is/isn't validated against.

## AI Engine Situation Analysis (RAG + Gemini/Groq)

Every engine gets a running plain-language "situation report" - e.g. *"RQ-M2
Kestrel is showing early signs of oil pressure loss: pressure has dropped to
38 psi against a 45 psi warning threshold while oil temperature climbs
in step. Recommend reducing power and inspecting the oil system before the
next flight."* - instead of just raw numbers. It is an explanatory, advisory
layer over simulated data, not a validated diagnostic.

**How it works** (`ai/` folder):
1. `knowledgeBase.js` - a small set of hand-written domain notes: what each
   of the four simulated fault types means/causes, what each sensor's
   nominal/danger side represents, and what health score / RUL / mission
   reliability mean.
2. `retriever.js` - the "R" in RAG: given one engine's current snapshot, it
   scores every knowledge doc by tag overlap with that engine's active
   fault, predicted fault, and any sensor currently in warning/critical, and
   returns the top few most relevant docs. (Simple tag matching, not
   embeddings - the knowledge base is small and hand-tagged, so this stays
   accurate without a vector DB dependency.)
3. `analysisEngine.js` - builds a prompt from those retrieved docs plus the
   live telemetry JSON, asks the provider pool for text, and caches the result
   per engine. It decides *when* to re-analyze: immediately whenever an
   engine's condition changes (nominal -> warning -> critical, or a fault
   starts/resolves), and otherwise on a longer timer
   (`AI_ANALYSIS_INTERVAL_MS`) so a quiet, nominal engine isn't re-analyzed
   constantly.
4. `providers.js`, `geminiClient.js`, `groqClient.js` - thin wrappers over each
   provider's REST API (Node's built-in `fetch`, no SDK) plus the resilience
   layer described next.

The result rides along on every `/api/snapshot` response and `snapshot`
socket event as each engine's `aiAnalysis` field, and a fresh one is also
pushed the moment it is ready via the `ai-analysis` socket event. The
dashboard's **AI Engine Situation Report** panel renders it live, with an
**Explain now** button to force an on-demand analysis for the selected engine.

### AI provider fallback

```
request -> Gemini (primary, per AI_PROVIDER_ORDER)
              | 429 / quota / auth error / timeout / empty or blocked reply
              v
           Groq (fallback)
              | also unavailable
              v
           rule-based one-line summary (degraded)
```

- A provider with **no API key is skipped** silently - that is configuration,
  not an error. The first keyed provider in `AI_PROVIDER_ORDER` is "primary".
- **Circuit breaker per provider.** On a quota/rate-limit failure (429/402) the
  provider enters a **cooldown** (the server's `Retry-After` / `retryDelay` hint
  if given, else `AI_PROVIDER_COOLDOWN_MS`, default 5 minutes) during which no
  request is sent to it, so an exhausted free-tier key is not hammered. Auth
  or model-not-found errors trigger a longer (1 h) cooldown; repeated
  timeouts/5xx cool down for 60 s. Cooldown start/end is logged once.
- Requests to one provider are serialized with a minimum gap
  (`GEMINI_MIN_GAP_MS` 13 s, `GROQ_MIN_GAP_MS` 2 s) to stay inside free-tier
  RPM limits.
- Each `aiAnalysis` object reports what happened: `provider` (`gemini`,
  `groq`, or `null`), `fallbackUsed` (a non-primary provider answered),
  `degraded` (text is the static rule-based fallback), `error`,
  `cooldownUntil` and `fallbackReason`.
- **What the dashboard shows:** the report panel labels which provider/model
  produced the text. When Groq answered, it is marked as a fallback; when no
  provider is available, the panel shows the rule-based summary marked as
  degraded (not AI-generated). Degraded engines are retried as soon as the
  blocking cooldown ends. The rest of the dashboard (telemetry, health,
  alerts, 3D twin) is unaffected.

**A note on quotas:** free-tier Gemini keys can carry surprisingly tight
limits - some models are capped at only ~20 requests/**day**, not just per
minute. `AI_ANALYSIS_INTERVAL_MS` and `GEMINI_MIN_GAP_MS` default to
conservative values for this reason; tighten them (or switch `GEMINI_MODEL`)
once you know your key's actual limits at
https://ai.google.dev/gemini-api/docs/rate-limits. Adding a Groq key gives a
free second provider so a Gemini quota hit degrades gracefully instead of
falling straight to rule-based text.

## Testing and quality

```bash
npm test              # all suites (node:test) under tests/
npm run test:server   # tests/server - HTTP API, security, lifecycle
npm run test:ai       # tests/ai     - providers, circuit breaker, analysis engine
npm run test:core     # tests/core   - simulator, physics, analytics, store, replay
npm run lint          # eslint (flat config, eslint.config.js)
npm run check         # lint + tests (what CI runs)
```

`npm test` uses `scripts/run-tests.js`, which passes an explicit file list to
`node --test` so it behaves the same on Node 20 and Node 24. Tests need no
network access and no API keys. CI (`.github/workflows/ci.yml`) runs lint,
tests, `npm audit` and a Docker build on Node 20 and 24.

## Docker

```bash
cp .env.example .env                 # add keys / ADMIN_API_KEY as desired
docker compose up -d --build         # http://localhost:5000
docker compose ps                    # STATUS shows (healthy) once /api/health passes
docker compose logs -f twin
```

Or without compose:

```bash
docker build -t aero-engine-digital-twin .
docker run -d --init --name twin -p 5000:5000 --env-file .env \
  -v twin-data:/data --read-only --tmpfs /tmp aero-engine-digital-twin
```

The image is multi-stage, runs as the non-root `node` user with
`NODE_ENV=production`, stores recordings in the `/data` volume
(`TWIN_DATA_DIR=/data`) and has a `HEALTHCHECK` against `/api/health`. Secrets are
never baked into the image (`.env` is excluded by `.dockerignore`). See
`docs/DEPLOYMENT.md` (reverse proxy, TLS, backups, scaling) and
`docs/OPERATIONS.md` (health checks, logs, troubleshooting).

**Single instance only:** fleet state, alert history and replay sessions live in
process memory and Socket.IO is not configured with a shared adapter, so run
exactly one replica (see `docs/DEPLOYMENT.md`).

## Project structure

```
SIH/
├── server.js             # Express + Socket.IO backend, REST API, tick loop
├── simulator.js          # Spoofed telemetry generator, fault injection, health/RUL model + analytics/ integration
├── engine_sim/           # Mean-value physics engine model, mission profiles, fault-injection curves
│   ├── physics.js
│   ├── environment.js    # ISA altitude/atmosphere model
│   ├── missions.js       # Mission profile library
│   ├── faults.js         # Parametrized fault degradation curves
│   └── index.js          # PhysicsEngine
├── analytics/            # Rate-aware health index, multivariate anomaly detection, RUL, explainability
│   ├── healthIndex.js
│   ├── anomalyDetection.js
│   ├── rulModel.js
│   ├── explain.js
│   ├── maintenanceRecommendation.js
│   └── index.js
├── twin_core/            # Persisted mission history (JSON-Lines) + live-state cache
│   ├── store.js
│   ├── stateStore.js
│   └── index.js
├── replay/               # Runs engine_sim missions end-to-end; replays them back at variable speed
│   ├── missionRunner.js
│   ├── replayEngine.js
│   └── index.js
├── ai/
│   ├── knowledgeBase.js  # RAG corpus: fault/sensor/health domain knowledge
│   ├── retriever.js      # RAG retrieval: picks relevant docs per engine snapshot
│   ├── providers.js      # Provider pool: order, per-provider circuit breaker/cooldown, spacing
│   ├── geminiClient.js   # Gemini generateContent REST wrapper
│   ├── groqClient.js     # Groq chat-completions REST wrapper (fallback)
│   └── analysisEngine.js # Orchestration: prompts, caching, refresh policy, rule-based fallback
├── docs/                 # Architecture, fault taxonomy, model cards, deployment roadmap
├── config.js             # Validated env configuration (fails fast)
├── middleware/           # Security (helmet/CORS/rate limits/admin key), logging, errors, validation
├── tests/                # node:test suites: server/, ai/, core/
├── scripts/run-tests.js  # Cross-version test runner
├── Dockerfile, docker-compose.yml, .dockerignore
├── .github/workflows/ci.yml
├── .env.example          # Complete, commented environment reference (copy to .env)
├── package.json
└── public/
    ├── index.html
    ├── css/style.css    # SIH theme (navy / saffron / tricolor accents)
    └── js/
        ├── app.js       # Dashboard rendering + Socket.IO client
        ├── charts.js    # Self-hosted canvas line chart
        └── twin3d.js    # three.js 3D engine twin (ES module)
```

## Notes

- The 3D twin shows the engine's single CHT/EGT sensor values on every
  cylinder — the telemetry has no per-cylinder channels, so it does not
  invent any. Real per-cylinder data would slot in per `cylinders[]` entry.
- All telemetry is **simulated** for demonstration — there is no real UAV or
  FADEC bus connection.
- To swap in real sensor data later, replace `simulator.js`'s tick loop with
  an ingest layer reading the actual data bus; the REST API, socket
  broadcast, and dashboard should need few changes (the data contract is
  the per-engine snapshot shape).
- **Prototype status.** This is a hackathon prototype for advisory/demo use.
  None of its models (rolling z-score, Mahalanobis anomaly detection, RUL,
  LLM narratives) has been validated against real engine data, and it is not
  certified or intended as a safety-of-flight system. See `docs/MODEL_CARDS.md`
  and `docs/ROADMAP.md`.
- **Operating it.** See `docs/DEPLOYMENT.md` (Docker, reverse proxy, TLS,
  backups, scaling) and `docs/OPERATIONS.md` (probes, logs, troubleshooting);
  release notes are in `CHANGELOG.md`.
