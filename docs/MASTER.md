# Master Reference — Aero Piston Engine Digital Twin

**Single self-contained reference for the entire project.** This document
consolidates the README, architecture notes, fault taxonomy, model cards,
deployment guide, operations runbook and roadmap into one file, and adds
sections none of the individual documents cover.

> **Prototype status.** Smart India Hackathon prototype. **All telemetry is
> simulated** — there is no real UAV, FADEC bus or CAN hardware involved. **No
> model here has been validated against real engine data.** It is an
> advisory/explanatory demonstrator, not a safety-of-flight system.

## Table of contents

1. [What the project is](#1-what-the-project-is)
2. [Correctness notes — docs that had drifted](#2-correctness-notes--docs-that-had-drifted)
3. [Quick start](#3-quick-start)
4. [Configuration](#4-configuration)
5. [API reference](#5-api-reference)
6. [Socket.IO events](#6-socketio-events)
7. [Fleet and sensors](#7-fleet-and-sensors)
8. [Live fault library (9 classes)](#8-live-fault-library-9-classes)
9. [Mission-replay fault library (20 classes)](#9-mission-replay-fault-library-20-classes)
10. [Architecture — the 5 layers](#10-architecture--the-5-layers)
11. [The models](#11-the-models)
12. [AI situation analysis (RAG)](#12-ai-situation-analysis-rag)
13. [AI provider fallback chain](#13-ai-provider-fallback-chain)
14. [Mission replay and artificial CAN](#14-mission-replay-and-artificial-can)
15. [Accident taxonomy](#15-accident-taxonomy)
16. [3D digital twin](#16-3d-digital-twin)
17. [Frontend modules](#17-frontend-modules)
18. [Project structure](#18-project-structure)
19. [Testing and CI](#19-testing-and-ci)
20. [Deployment](#20-deployment)
21. [Operations runbook](#21-operations-runbook)
22. [Roadmap to real hardware](#22-roadmap-to-real-hardware)
23. [Honest limitations](#23-honest-limitations)

---

## 1. What the project is

A **real-time digital twin** for aero piston engines in MALE UAVs. A Node.js
backend simulates a fleet of UAV engines, streams telemetry, scores engine
health, predicts faults, and serves a live operator dashboard with a 3D engine
twin and LLM-written plain-language situation reports.

- **Fleet:** 3 simulated engines, all Rotax-912 iS class.
- **Telemetry:** 13 sensors per engine, broadcast every `TICK_MS` (default 2 s).
- **Health model:** rule + rolling z-score, plus a richer `analytics/` layer.
- **AI:** retrieval-augmented generation over a hand-tagged knowledge base,
  Gemini primary with Groq fallback, rule-based last resort.
- **Replay:** two independent recorders — a physics-based one and a
  spec-driven deterministic one — plus a J1939-flavoured artificial CAN bus.

### Documents this replaces as the single source of truth

| Document | Role | Now authoritative? |
|---|---|---|
| `README.md` | Overview, quick start, config, API | Yes, but its sensor/fault counts are stale (see §2) |
| `docs/ARCHITECTURE.md` | 5-layer design, data flow | Yes |
| `docs/FAULT_TAXONOMY.md` | Live + replay fault classes | **Stale** — see §2 |
| `docs/MODEL_CARDS.md` | Model scope + limits | **Stale** — see §2 |
| `docs/ACCIDENT_TAXONOMY.md` | Accident-class reasoning | Yes |
| `docs/3D_TWIN_REALISM_GUIDE.md` | 3D twin detail (633 lines) | Yes, referenced |
| `docs/DEPLOYMENT.md` | Docker, proxy, TLS, backups, scaling | Yes |
| `docs/OPERATIONS.md` | Probes, logs, troubleshooting | Yes |
| `docs/ROADMAP.md` | Simulated → real FADEC | Yes |
| `docs/SIH2026-Garuda-x-slide-script.md` | Pitch deck content | Yes |
| `CHANGELOG.md` | Release history | Yes |

---

## 2. Correctness notes — docs that had drifted

While consolidating, several documented facts were found **out of date versus
the code**. This section records the verified truth; treat it as authoritative
where it contradicts the older docs.

| Fact | Older docs said | Actual code (verified) |
|---|---|---|
| Sensor count | 9 | **13** (`simulator.js` `SENSORS`) |
| Live fault types | 4 | **9** (`simulator.js` `FAULT_TYPES`) |
| Misfire fault | "Not covered" | **Implemented** (`misfire`) |
| Combustion instability | "Partially covered" | **Implemented** (`combustionInstability`) |
| Injector abnormality | "Partially covered" | **Implemented** (`injectorAbnormality`) |
| Cooling / coking | "Not covered" | **Implemented** (`coking`, plus `engine_sim/coking.js`) |
| Sensor drift / failure | "Not covered" | **Implemented** (`sensorDrift`, bias-only) |
| API routes | 26 listed | **28 exist** — `GET /api/history/:engineId` and `GET /api/maintenance` are undocumented in the README (both are included in §5 below) |
| `analytics/` scope | "described prescriptively… verify once merged" | **Fully implemented**, and much larger than described (Isolation Forest, RUL regressor, SHAP, rainflow/Miner fatigue, trend forecast) |
| Repo root folder | `SIH/` | `aero-piston` |

The 8-category master-plan taxonomy is therefore now **fully covered** by the
live fleet simulator. The gaps that remain are in the *replay* recorder's
persistent-state faults (coking still needs a cross-mission cumulative state).

---

## 3. Quick start

Requires **Node.js >= 20** (developed on Node 24).

```bash
npm install
cp .env.example .env     # optional - every variable has a default
npm start                # runs start.js: installs deps if needed, starts server, opens browser
```

Open **http://localhost:5000**.

Alternative entry points:

```bash
npm run server           # node server.js          (servers/containers - no browser)
npm run dev              # node --watch server.js  (auto-restart on file change)
```

Runtime dependencies: `express`, `socket.io`, `cors`, `helmet`,
`express-rate-limit`, `dotenv`, `three`. Charts and three.js are served
locally; only the Inter web font comes from Google Fonts (page falls back to
system fonts).

---

## 4. Configuration

All configuration is via environment variables; `.env` is loaded
automatically. **Every variable is optional.** Secrets are never logged — the
startup `configuration` line reports only `set`/unset.

Validation is split by ownership, which matters when diagnosing a bad value:

- **`config.js`** parses and validates the **server-level** variables once at
  startup and **fails fast listing every problem** (bad `PORT`, malformed
  `CORS_ORIGIN`, `ADMIN_API_KEY` under 8 characters, etc.).
- **The modules that own a variable read it themselves** — `ai/providers.js`,
  `ai/geminiClient.js`, `ai/groqClient.js`, `ai/aiUtil.js`,
  `ai/analysisEngine.js` for the `GEMINI_*` / `GROQ_*` / `AI_*` families, and
  `twin_core/store.js` for `TWIN_MAX_*`. These are **not** validated by
  `config.js`, so a malformed value there surfaces as a runtime error in that
  subsystem rather than a startup failure.

`docs/OPERATIONS.md` and `docs/DEPLOYMENT.md` remain the operational reference;
this is the complete variable list, and `.env.example` is the commented
source of truth.

### Core / server

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` ⇒ CORS same-origin, no error detail, HSTS |
| `PORT` | `5000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | unset | Comma-separated origin allowlist (REST **and** Socket.IO). Unset ⇒ open in dev, same-origin in production. `*` = open |
| `TRUST_PROXY` | unset | `true`, hop count, or subnet list. Set behind a reverse proxy; **do not** set when internet-reachable |
| `LOG_LEVEL` | `info` | `silent`\|`error`\|`warn`\|`info`\|`debug` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Max drain time on SIGTERM/SIGINT |
| `TICK_MS` | `2000` | Live telemetry tick interval |

### Security / limits

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_API_KEY` | unset | If set (≥ 8 chars), mutating `POST` routes require an `x-api-key` header |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `RATE_LIMIT_MAX` | `120` | Requests per IP per window on `/api/*` |
| `RATE_LIMIT_HEAVY_MAX` | `10` | Per-window cap on expensive routes (mission run, replay, AI refresh) |
| `SOCKET_MAX_PER_IP` | `20` | Socket.IO per-IP connection cap |
| `SOCKET_MAX_TOTAL` | `500` | Socket.IO global connection cap |
| `MAX_CONCURRENT_MISSIONS` | `2` | Simultaneous `engine-sim/run` executions; extras get 429 |

### AI providers

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | unset | Primary provider key |
| `GEMINI_MODEL` | see `.env.example` | Gemini model name |
| `GEMINI_MIN_GAP_MS` | `13000` | Fleet-wide min gap between Gemini calls |
| `GROQ_API_KEY` | unset | Fallback provider key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model name |
| `GROQ_MIN_GAP_MS` | `2000` | Min gap between Groq calls |
| `AI_PROVIDER_ORDER` | `gemini,groq` | Provider preference order |
| `AI_PROVIDER_COOLDOWN_MS` | `300000` | How long a provider is skipped after a quota/rate-limit failure |
| `AI_ANALYSIS_INTERVAL_MS` | `300000` | Min interval between automatic re-analyses of an unchanged engine |

Neither key is required. With neither set, the app runs fully in degraded mode
with rule-based summaries.

### Storage

| Variable | Default | Purpose |
|---|---|---|
| `TWIN_DATA_DIR` | `./twin_core/data` | Mission recording root (`/data` in Docker) |
| `TWIN_MAX_MISSIONS_PER_ENGINE` | `50` | Retention — oldest recordings beyond this are pruned |
| `TWIN_MAX_READINGS_PER_MISSION` | `50000` | Cap on readings per recording; further appends dropped |

---

## 5. API reference

Base URL `http://localhost:5000`. Errors are JSON:
`{ "error": "...", "detail"?: "..." }`.

Routes marked **heavy** are subject to `RATE_LIMIT_HEAVY_MAX`. All non-GET
`/api` routes require `x-api-key` when `ADMIN_API_KEY` is set. `/api/health` and
`/api/ready` are never rate-limited.

### Fleet, health and telemetry

| Method & path | Description |
|---|---|
| `GET /api/health` | Liveness: `{ ok, service, uptime }` |
| `GET /api/ready` | Readiness: `200 { ready, checks: { fleet, store } }`, else `503` |
| `GET /api/snapshot` | Latest fleet snapshot — every engine incl. `analytics` and `aiAnalysis` |
| `GET /api/alerts` | Recent alerts |
| `GET /api/meta` | Sensor and fault metadata (incl. `SENSORS` bands) |
| `GET /api/series/:engineId` | Per-engine time series |
| `GET /api/history/:engineId` | Live in-memory reading history + per-sensor stats |
| `GET /api/maintenance` | Fleet-wide maintenance recommendation roll-up |

### AI analysis

| Method & path | Description |
|---|---|
| `GET /api/ai-analysis` | Situation reports, all engines |
| `GET /api/ai-analysis/:engineId` | Situation report, one engine |
| `POST /api/ai-analysis/:engineId/refresh` | Force a fresh analysis now — **heavy** |

`refresh` also accepts a **session-scoped provider override** via the
`x-ai-provider` / `x-ai-api-key` headers (see §12).

### Physics mission simulation (`engine_sim/` + `replay/` + `twin_core/`)

| Method & path | Description |
|---|---|
| `GET /api/engine-sim/profiles` | Available mission profiles |
| `POST /api/engine-sim/run` | Run and record a physics mission — **heavy** |
| `GET /api/engine-sim/recordings/:engineId` | List recorded missions |
| `GET /api/engine-sim/recordings/:engineId/:missionId` | Full recorded time series |
| `POST /api/engine-sim/replay/:engineId/:missionId` | Start a replay — **heavy** |
| `POST /api/engine-sim/replay/:engineId/control` | `pause`/`resume`/`seek`/`speed`/`stop` |

Profiles: `climbCruiseDescent`, `highAltitudeLongEndurance`, `hotWeather`,
`rapidThrottleTransients`.

```bash
POST /api/engine-sim/run
{ "engineId": "uav-01", "profileId": "hotWeather",
  "durationSeconds": 3600, "faultTypes": ["overheat"] }
```
`durationSeconds` 10–14400 (default 1800); `dtSeconds` 0.5–30 (default 2).
`faultTypes` optional — omit for a randomized 0–2 concurrent faults per run.

### Spec-driven mission replay (`missionreplay/`)

| Method & path | Description |
|---|---|
| `GET /api/mission-replay` | List generated mission ids |
| `POST /api/mission-replay/generate` | Generate a deterministic mission log — **heavy** |
| `GET /api/mission-replay/:missionId/manifest` | Schema version, profile, RNG seed |
| `GET /api/mission-replay/:missionId/faults` | Fault-event table (onset / detected / resolved / precursor) |
| `GET /api/mission-replay/:missionId/phases` | Phase schedule |
| `GET /api/mission-replay/:missionId/state` | Interpolated sample at `?t_s=` with anomaly overlay |
| `GET /api/mission-replay/:missionId/range` | Bounded slice: `?start_s=&end_s=&maxSamples=` |
| `GET /api/mission-replay/:missionId/snapshot` | Current playhead state |
| `POST /api/mission-replay/:missionId/control` | `seek`/`step`/`play`/`pause`/`resume`/`stop` |
| `GET /api/mission-replay/:missionId/evaluation` | Score detectors vs injected ground truth |
| `GET /api/can/status` | Artificial CAN bus: nodes, sent/dropped counts, ring-buffer load |

```bash
POST /api/mission-replay/generate
{ "missionId": "MSN-2026-0001", "duration": 21600,
  "faults": [{ "type": "oil_pressure_degradation", "onset_s": 9000, "severity": "moderate" }],
  "seed": 42 }
```
`duration` 30–86400 s (default 21600); `sampleRateHz` 1–10 (default 1);
`phases[]` optional override; `recordCan` optional. Default seed is an FNV hash
of the mission id + inputs.

Writes `<TWIN_DATA_DIR>/missionreplay/<missionId>/`: `manifest.json`,
`telemetry.jsonl`, `faults.json`, `telemetry.idx`, and optionally `can.jsonl`.

`evaluation` supports `?margin=` (baseline margin) and `?threshold=`
(force absolute mode instead of self-calibration), returns precision/recall/F1
per detector, per-fault detection latency, and a `marginSweep`.
Reproduce with `node scripts/evaluate-missionreplay.js`.

---

## 6. Socket.IO events

Server → client:

| Event | When |
|---|---|
| `snapshot` | Every tick, and once on connect |
| `ai-analysis` | When a fresh analysis completes |
| `replay-frame` | During an `engine_sim/` replay |
| `mission-replay-frame` | During a `mission-replay` playback (also pushes frames onto the CAN bus) |

---

## 7. Fleet and sensors

### Fleet

| Engine id | Tail | Engine model |
|---|---|---|
| `uav-01` | RQ-M1 "Falcon" | Rotax-912 iS (sim) |
| `uav-02` | RQ-M2 "Kestrel" | Rotax-912 iS (sim) |
| `uav-03` | RQ-M3 "Harrier" | Rotax-912 iS (sim) |

### Sensors — 13 channels

Illustrative values loosely modelled on a Rotax-912-class four-stroke piston
engine. **Not sourced from a certified type-data sheet** — treat every
nominal/warning/critical band as representative, not authoritative.

| Sensor | Unit | Nominal band | Low warn / crit | High warn / crit |
|---|---|---|---|---|
| `rpm` | RPM | 4600–5600 | 4200 / 3800 | 5800 / 6100 |
| `cht` | °C | 90–145 | — | 145 / 168 |
| `egt` | °C | 650–760 | — | 760 / 800 |
| `oilPressure` | psi | 45–62 | 45 / 30 | — |
| `oilTemp` | °C | 80–108 | — | 108 / 125 |
| `fuelFlow` | L/h | 12–18 | 12 / 8 | — |
| `vibration` | mm/s | 0.4–2.4 | — | 2.4 / 4.2 |
| `manifoldPressure` | kPa | 88–106 | 88 / 78 | — |
| `batteryVoltage` | V | 12.6–14.6 | 12.6 / 11.8 | — |
| `lambda` | AFR | 13.2–15.0 | 12.6 / 11.5 | 15.2 / 16.0 |
| `injectorPulseWidth` | ms | 2.4–4.4 | — | 4.4 / 5.2 |
| `injectionTiming` | °BTDC | 20–30 | 18 / 15 | 30 / 34 |
| `alternatorCurrent` | A | 6–32 | 6 / 4 | — |

Note: the 3D twin shows the engine's single CHT/EGT values on every cylinder —
the telemetry has **no per-cylinder channels**, so it does not invent any. Real
per-cylinder data would slot in per the `cylinders[]` entry.

---

## 8. Live fault library (9 classes)

`simulator.js`'s `FAULT_TYPES`. Each fault is a named drift applied to specific
sensors' random walk, ramped in over its active duration and cleared after a
randomized number of ticks. Values below are the **exact `drift` objects as
coded**; `wobble` adds a periodic oscillation on top.

| Key | Label | Affected sensors | Drift | Wobble |
|---|---|---|---|---|
| `overheat` | Thermal Overload (CHT/EGT Rising) | `cht`, `egt`, `oilTemp` | cht +1.0, egt +1.3, oilTemp +0.9 | — |
| `oilLoss` | Oil Pressure Loss | `oilPressure`, `oilTemp`, `vibration` | oilPressure −1.5, oilTemp +0.6, vibration +0.05 | — |
| `vibration` | Mechanical Imbalance / Vibration Anomaly | `vibration`, `rpm` | vibration +1.1, rpm −0.9 | vibration 0.25, rpm 10 |
| `fuelStarvation` | Fuel System Degradation | `fuelFlow`, `rpm`, `manifoldPressure` | fuelFlow −0.9, rpm −1.0, manifoldPressure −0.9 | — |
| `sensorDrift` | Sensor Drift / Failure | `batteryVoltage` | **bias** batteryVoltage −1.2, drift −0.8 | — |
| `coking` | Cooling / Coking Degradation | `cht`, `egt`, `oilTemp`, `manifoldPressure` | cht +1.1, egt +1.0, oilTemp +0.9, manifoldPressure −0.8 | — |
| `injectorAbnormality` | Injector Abnormality | `lambda`, `injectorPulseWidth`, `fuelFlow`, `rpm` | lambda +0.7, injectorPulseWidth +0.7, fuelFlow +0.9, rpm −0.8 | lambda 0.12, injectorPulseWidth 0.1 |
| `misfire` | Misfire | `rpm`, `egt`, `lambda` | rpm −0.85, egt −1.0, lambda −0.8 | rpm 18, egt 8, lambda 0.12 |
| `combustionInstability` | Combustion Instability | `lambda`, `rpm`, `egt`, `manifoldPressure` | lambda +0.8, rpm −0.8, egt +1.0, manifoldPressure +0.9 | lambda 0.25, rpm 12, egt 10, manifoldPressure 1.2 |

`sensorDrift` is deliberately the cleanest possible mis-attribution case: it
biases `batteryVoltage` only, a channel shared with no other fault, so the
*reported* value goes wrong while the *physical* engine stays healthy. This is
exactly the failure mode that correlated-fault detectors structurally cannot
see.

### Timing

- A fault starts probabilistically on an eligible tick after a cooldown
  (`FAULT_BREAK_MIN = 40` ticks after a fault resolves; `NEXT_FAULT_MIN`/`NEXT_FAULT_MAX`
  bound the next opportunity).
- Alert re-announcement is paced by cooldowns rather than spamming:
  `VALIDITY_COOLDOWN_MS = 30000`, `CRITICAL_COOLDOWN_MS = 90000`,
  `PREDICTED_COOLDOWN_MS = 90000`.

### Mapping to the 8-category master-plan taxonomy

| Master-plan category | Status |
|---|---|
| Overheating trend | **Covered** — `overheat` |
| Lubrication issues | **Covered** — `oilLoss` |
| Abnormal vibration pattern | **Covered** — `vibration` |
| Cooling / coking degradation | **Covered** — `coking` |
| Injector abnormality | **Covered** — `injectorAbnormality` |
| Combustion instability | **Covered** — `combustionInstability` |
| Misfire | **Covered** — `misfire` |
| Sensor drift / failure | **Covered** — `sensorDrift` |

All 8 categories are now implemented in the live simulator. Two qualifications
remain: `coking` is still a single-episode window rather than a persistent
cross-mission cumulative state, and every fault is engine-level — there is no
per-cylinder or per-cycle signal.

---

## 9. Mission-replay fault library (20 classes)

`missionreplay/faultLib.js`. Deliberately **separate** from §8: it models
*time-windowed degradation events* on a labeled synthetic mission log, not a
probabilistic drift on the live feed. Each class carries an injected
onset/detected/resolved timeline with a `precursor_window_s` and a severity
multiplier.

| Fault type | Class | Affected parameters | Detection rule |
|---|---|---|---|
| `oil_pressure_degradation` | Lubrication | oil_pressure_kpa down | < 350 kPa for 10 consecutive samples |
| `oil_starvation` | Lubrication (severe) | oil_pressure_kpa, oil_temp_c | < 250 kPa for 3 consecutive |
| `fuel_starvation` | Fuel system | fuel_flow_lph, rpm, manifold_pressure_kpa | fuel_flow_lph < 5 for 10 consecutive |
| `detonation_risk` | Combustion instability | afr, egt_c | AFR > 15.5 (lean) for 8 consecutive |
| `vibration_anomaly` | Vibration | vibration_mm_s, rpm, cht_c | > 6.0 mm/s for 5 consecutive |
| `overheating` | Cooling / thermal | cht_c, egt_c, oil_temp_c | cht_c above phase target + 240 K for 3 consecutive |
| `plug_fouling` | Misfire-adjacent | afr, rpm oscillation, egt_c | rpm-jerk threshold, or egt_c < 620 K in flight (3 consecutive) |
| `sensor_dropout` | **Sensor failure** | none — reported value goes `OVERRANGE_SENSOR` | reported value is NaN or exactly −32000 |
| `carburetor_icing` | Intake / ice | fuel_flow_lph, mixture_ratio, egt_c, rpm | fuel_flow_lph < 6.5 (climb/cruise/loiter, 12) or egt_c < 620 K (6) |
| `fuel_filter_blockage` | Fuel system (progressive) | fuel_flow_lph, egt_c, rpm | fuel_flow_lph < 6.5 (climb/cruise/loiter, 20) |
| `water_ingestion` | Fuel contamination | egt_c, rpm, cht_c, vibration | egt_c > 860 K for 2 consecutive |
| `prop_imbalance` | Propeller / airframe | vibration_mm_s, rpm | > 4.4 mm/s for 15 consecutive |
| `bearing_wear` | Mechanical (slow) | vibration_mm_s, oil_temp_c, oil_pressure_kpa | > 4.6 mm/s for 25, or oil_temp_c > 118 K for 20 |
| `clutch_slip` | Drivetrain | rpm, vibration_mm_s, fuel_flow_lph | rpm below phase target − 480 (floor 1900) for 10 flight samples |
| `turbo_overboost` | Induction (wastegate) | mixture_ratio, egt_c, cht_c, fuel_flow_lph | mixture ratio rich > 15.3 for 10 consecutive |
| `exhaust_leak` | Exhaust | egt_c, rpm, mixture_ratio | egt_c < 620 K in climb/cruise/loiter for 12 |
| `magneto_failure` | Ignition | rpm, egt_c, vibration_mm_s | rpm < 1500 and below phase target − 620 for 3 flight samples |
| `battery_fault` | Electrical / charging | rpm, vibration_mm_s, fuel_flow_lph | rpm < 2100 and below phase target − 330 for 12 flight samples |
| `air_filter_clog` | Intake air restriction | mixture_ratio, egt_c, rpm | mixture ratio rich > 15.2 for 15 consecutive |
| `static_discharge` | Electrical noise | vibration_mm_s | > 6.2 mm/s for 2 consecutive |

### Detection-rule design notes

- Rules are **phase-gated** where the signal is phase-sensitive: low-EGT and
  fuel-flow rules run in flight phases only, because taxi, takeoff and landing
  legitimately run cold EGT, low flow and low rpm.
- RPM floors are expressed `min(below, target − belowOfTarget)` so a takeoff
  spool-up never trips them.
- Rules require N **consecutive** out-of-band samples, with margin guards.
- Variance-based detectors are deliberately avoided: the first-order lag makes
  RPM swing outside any variance band on every phase transition, so a variance
  detector false-fires on a clean takeoff.
- **A clean mission must produce zero events.** Enforced by
  `scripts/calibrate-fault-rules.js` and the unit tests.
- Operator-injected events carry `injected: true`; events that *emerge* from
  the rules over nominal-but-noisy data carry `injected: false` and recover
  automatically. The emergent form is what makes the log useful as labeled
  training data.
- `sensor_dropout` serialises as the `OVERRANGE_SENSOR = -32000` sentinel
  because JSON has no NaN.
- `missionreplay/missions/eval-probe/` holds a committed probe mission used by
  the evaluator.

---

## 10. Architecture — the 5 layers

| Layer | Role | Implementation here |
|---|---|---|
| L0 — Virtual engine | Ground-truth physics | `simulator.js` `EngineTwin` (random walk + fault drift) for the live feed; `engine_sim/` `PhysicsEngine` (Wiebe combustion, ISA altitude derating, thermal lag) on demand |
| L1 — Acquisition / edge | Sensor realism, framing, transport | `simulator.js` per-sensor noise + threshold classification; live transport is Socket.IO; replay additionally frames through `missionreplay/can.js` |
| L2 — Twin core | Ingest, live state, history, APIs | `server.js` (Express REST + Socket.IO loop, `TICK_MS = 2000`); `twin_core/` persists missions (JSON-Lines) |
| L3 — AI/ML analytics | Anomaly detection, RUL, explainability | `analytics/` runs inside `EngineTwin.step()` every tick, exposed as each engine's `analytics` field; `ai/` runs alongside in `server.js` |
| L4 — Dashboard / replay | Operator HMI, replay | `public/` consumes the live feed; `replay/` streams `engine_sim/` missions as `replay-frame`; `missionreplay/` adds the spec-driven path |

### Two ground-truth sources, on purpose

This is a deliberate integration choice, not an oversight:

- **`simulator.js` `EngineTwin`** — lightweight mean-reverting random walk
  driving the always-on 3-UAV fleet feed.
- **`engine_sim/` `PhysicsEngine`** — the real mean-value thermodynamic model,
  invoked per mission via `POST /api/engine-sim/run`, persisted through
  `twin_core/store.js`.

`analytics/` is currently wired only into the live loop. A recorded
`engine_sim/` mission replays onto the dashboard but does **not** get its own
live analytics computed during the run — wiring `analytics/` into
`replay/missionRunner.js`'s per-tick callback is the natural next step.

### Data flow

```
L4  public/index.html + app.js  ── snapshot / ai-analysis ──┐
L3  simulator.js rules + analytics/ + ai/ RAG  ◄────────────┤
L2  server.js REST + Socket.IO loop; twin_core/  ◄───────────┤
L1  simulator.js noise + classification ───────────────────►┤
L0  EngineTwin random walk  +  engine_sim/ PhysicsEngine    │
```

Advisories, predictions and AI narratives flow **up** through the same stack.
**There is no downward command path** — this prototype is observe-only and does
not actuate anything.

### What was *not* built vs. the master plan

- **No real vcan/SocketCAN.** `vcan` is Linux-only and this runs on Windows, so
  `missionreplay/can.js` implements a *J1939-flavoured artificial bus in JS*
  instead (see §14). No real CAN adapter, no external publisher/subscriber, no
  DBC schema.
- **No MQTT.** Transport is Socket.IO, not a topic-based broker — architecturally
  simpler but it does not exercise a real pub/sub pattern (no independent
  publishers/subscribers, no QoS, no topic routing). **This is a genuine gap,
  not an implementation detail.**
- **No Python/FastAPI/TimescaleDB.** The backend is entirely Node.js/Express;
  time-series storage lives in `twin_core/` and `missionreplay/` JSON-Lines.

None of this blocks the functional goal, and the REST/socket surface in
`server.js` is exactly what would stay unchanged if a real CAN/MQTT ingest
layer were dropped in later.

### Runtime hardening (v1.1)

- **`config.js`** — validates all env once, fails fast with a full problem
  list, never logs secrets.
- **`middleware/`** — `security.js` (helmet + CSP, CORS allowlist for REST and
  Socket.IO, rate limits with a heavy tier, optional `ADMIN_API_KEY`),
  `logger.js` (structured JSON in production, request ids), `errors.js`
  (uniform `{ error, detail? }`, no internals in production), `validate.js`.
- **Probes** — `/api/health` and `/api/ready` registered before the rate limiter.
- **Lifecycle** — `createServer()` builds the app with no side effects (used by
  tests); running `server.js` directly installs SIGTERM/SIGINT handlers that
  stop the tick loop and replays, close sockets, and exit within
  `SHUTDOWN_TIMEOUT_MS`.

---

## 11. The models

### 11.1 Rule + rolling z-score health/RUL (`simulator.js`)

**Status:** implemented, running today. **Not a trained model** — a hand-tuned
rule engine with hard-coded constants, no training data, no held-out set.

- **Purpose:** per-tick composite health (0–100), remaining-useful-life in
  engine hours, predicted-fault classification with confidence.
- **Inputs:** 13 current readings, their `classify()` band, and a rolling
  z-score per sensor over the last 30 samples (`HISTORY_WINDOW`, ~60 s at 2 s).
- **Outputs:** `health` (100 − accumulated penalty, clamped), `predictedFault`
  (the `FAULT_TYPES` entry with the strongest combined warning/critical +
  z-score signal, if score ≥ 1.6), and `rul` (exponentially relaxes toward
  `200 + health*3.2`, clamped 0–900 h).
- **Limitations:** thresholds tuned by hand for a convincing demo, not fit to
  failure data; a fault developing slowly relative to the 30-sample window is
  under-detected because the rolling mean drifts with it; RUL is a smoothed
  function of instantaneous health, not a time-to-failure model, so two engines
  with the same health but different fault dynamics get the same RUL trend.
  **Not validated against any real engine telemetry.**

### 11.2 `analytics/` — the real ML layer

**Status:** implemented and wired into every live tick, plus replay scoring.
Exposed on each engine's `analytics` field in `/api/snapshot`. Much broader
than `docs/MODEL_CARDS.md` describes; modules verified in `analytics/index.js`:

| Module | Exports / purpose |
|---|---|
| `healthIndex.js` | `computeHealthIndex`, `classify`, `SENSOR_DEFS`, `TREND_CATEGORY_MAP` — **rate-aware** index that flags a sensor trending toward a band *before* it crosses |
| `anomalyDetection.js` | `MultivariateAnomalyDetector` (Mahalanobis distance against a running mean/covariance fitted on the engine's own healthy telemetry), `DEFAULT_FEATURE_ORDER` |
| `isolationForest.js` | `IsolationForest`, `avgPathLength` — actual unsupervised anomaly model |
| `rulModel.js` | `estimateRUL`, `deriveRulFeatures`, `MAX_RUL_HOURS` |
| `rulRegressor.js` | `trainRulModel`, `predictRul`, `saveRulModel`, `emitRulModelModule`, `loadRulModel`, `RUL_MODEL_PATH`, `RUL_HARDCODED_PATH`, `HARDCODED_MODEL` — trained regressor persisted at `analytics/models/rul-regressor.json` with a hardcoded fallback module |
| `trendForecast.js` | `forecastSensor`, `forecastEngine`, `hoursToHealthFloor` |
| `shap.js` | `shapAttribution` — feature attribution for the regressor |
| `explain.js` | `explain`, `labelFor`, `categoryLabel` — offline narrative |
| `maintenanceRecommendation.js` | `recommend`, `CATEGORY_ACTION` |
| `materialDB.js` | `MATERIALS`, `PARTS`, `kfOf`, `snParams`, `goodmanEquivalent`, `thermalKnockdown`, `cyclesToFailure`, `damagePerCycle`, `getPart`, `materialFor` — materials/parts database with S-N curves and Goodman-equivalent correction |
| `rainflow.js` | `rainflowCount`, `turningPoints`, `cycleHistogram` — rainflow cycle counting |
| `fatigueRul.js` | `createFatigueState`, `partDutyStress`, `advanceFatigue`, `fatigueReport`, `missionFatigue`, `missionReport`, `monteCarloFatigue`, `partHoursToD1`, `partStatus`, `statusLabel`, `MAX_FATIGUE_HOURS`, `DEFAULT_SCATTER` — Miner's-rule fatigue life with Monte Carlo scatter |
| `missionReplayMetrics.js` | `evaluateMissionReplay`, `toAnalyticValues` — scores detectors vs injected ground truth |
| `mathUtils.js` | Shared numeric helpers |

Train/extend with `node scripts/train-rul.js`. Bands can be recalibrated with
`node scripts/calibrate-missionlab-bands.js`.

**Limitations:** every model here has only ever seen this project's own
simulator output and cannot be assumed to generalize to a real engine's noise
characteristics or failure signatures. The trained RUL regressor is only as
good as the synthetic missions it was trained on. SHAP-style attribution
explains *what the model attended to*, not what is physically true — read it as
"why the model flagged this," not as an engineering diagnosis.
**Not validated against any real engine telemetry.**

### 11.3 Cross-pipeline replay scoring

`analytics/missionReplayMetrics.js` closes the loop between the L3 layer and
the recorder: it replays a generated log through `healthIndex` and scores the
rule-based detector **and** the analytics health model against injected ground
truth. Because the health model's absolute bands are fleet-tuned, the analytics
detector is **self-calibrated to the mission's own known-good baseline** by
default, with an absolute-threshold override.

Notable emergent finding: a `−32000` dropout on a sensor whose band is
high-only reads as **nominal** to the health index. The rule-based dropout rule
exists precisely because of that gap.

---

## 12. AI situation analysis (RAG)

Each engine gets a running plain-language situation report instead of raw
numbers, e.g. *"RQ-M2 Kestrel is showing early signs of oil pressure loss:
pressure has dropped to 38 psi against a 45 psi warning threshold while oil
temperature climbs in step. Recommend reducing power and inspecting the oil
system before the next flight."*

### Pipeline

1. **`ai/knowledgeBase.js`** — small hand-written, hand-tagged corpus: what
   each fault means/causes, what each sensor's nominal/danger side represents,
   what health score / RUL / mission reliability mean. Includes
   **combined-signature** docs (`pattern-cooling-vibration`, `pattern-power-loss`)
   whose tags span *multiple* sensors, so they surface only when those sensors
   are out of band **together**.
2. **`ai/retriever.js`** — scores every doc by tag overlap against the engine's
   active/predicted fault and any out-of-band sensors, returning the top few.
   Simple tag matching, **not** embeddings — the corpus is small and
   hand-tagged, so this stays accurate without a vector DB.
3. **`ai/analysisEngine.js`** — builds the prompt from retrieved docs plus live
   telemetry JSON, asks the provider pool, caches per engine. Re-analyzes
   immediately when condition changes (nominal → warning → critical, or a
   fault starts/resolves), otherwise on `AI_ANALYSIS_INTERVAL_MS`.
4. **`ai/providers.js`**, **`geminiClient.js`**, **`groqClient.js`** — thin
   REST wrappers over Node's built-in `fetch` (no SDKs), plus the resilience
   layer in §13. `ai/aiUtil.js` holds shared helpers.

Results ride on every `/api/snapshot` as `aiAnalysis`, push immediately via the
`ai-analysis` socket event, and render in the dashboard's **AI Engine Situation
Report** panel with an **Explain now** button.

### Session-only provider override

`public/js/aiSession.js` lets an operator point a **single manual re-analysis**
at their own key without configuring the server:

- the key is held in a **page closure only**
- sent as `x-ai-provider` / `x-ai-api-key` on
  `POST /api/ai-analysis/:engineId/refresh`
- `server.js` builds a **request-scoped `ProviderPool`** for that one call, then
  closes it
- **never** written to disk, cookies, `localStorage`, `sessionStorage`,
  IndexedDB, or the process-wide pool, and **redacted** from any log line

---

## 13. AI provider fallback chain

```
request → Gemini (primary, per AI_PROVIDER_ORDER)
            │ 429 / quota / auth error / timeout / empty or blocked reply
            ▼
         Groq (fallback)
            │ also unavailable
            ▼
         rule-based one-line summary  (degraded)
```

- A provider with **no key is skipped silently** — that is configuration, not an
  error.
- **Circuit breaker per provider.** Quota/rate-limit (429/402) → cooldown of the
  server's `Retry-After`/`retryDelay` hint, else `AI_PROVIDER_COOLDOWN_MS`
  (5 min). Auth or model-not-found → **1 h**. Repeated timeouts/5xx → 60 s.
  Cooldown start/end is logged **once per transition**.
- Per-provider minimum gap (`GEMINI_MIN_GAP_MS` 13 s, `GROQ_MIN_GAP_MS` 2 s) to
  stay inside free-tier RPM limits.
- Each `aiAnalysis` reports `provider` (`gemini` / `groq` / `null`),
  `fallbackUsed`, `degraded`, `error`, `cooldownUntil`, `fallbackReason`.
- The dashboard labels which provider/model wrote the text, marks fallback
  text, and marks rule-based text as degraded (not AI-generated). The rest of
  the dashboard is unaffected.

**Quota caveat:** some free-tier Gemini models are capped at only ~20
requests/**day**. `AI_ANALYSIS_INTERVAL_MS` and `GEMINI_MIN_GAP_MS` default to
conservative values for this reason. Adding a Groq key gives a free second
provider so a Gemini quota hit degrades gracefully. See
<https://ai.google.dev/gemini-api/docs/rate-limits>.

---

## 14. Mission replay and artificial CAN

### Physics recorder (`engine_sim/` + `replay/` + `twin_core/`)

`engine_sim/` implements a mean-value physics model — Wiebe-style combustion
heat release, thermal lag, ISA altitude derating (`environment.js`), mission
profiles (`missions.js`), parametrized degradation curves (`faults.js`,
`coking.js`), plus `observer.js` and `rng.js`. `replay/missionRunner.js` runs a
mission end-to-end and persists every tick via `twin_core/store.js`;
`replay/replayEngine.js` plays it back at variable speed as `replay-frame`.

The dashboard has **no UI** for these — they are API/Socket.IO-only.

### Spec-driven recorder (`missionreplay/`)

Every bounded step is committed to disk so a **regenerated flight is
byte-identical given the same seed**. All downstream logic uses logical sample
time `t_s`, never wall-clock, so there is no async drift.

**Synthesis pipeline** (`generator.js`), per 1 s sample:

```
eased phase target (cosine over a 15 s transition)
  → first-order lag (thermal params respond slowly)
  → gaussian noise from the seeded RNG
  → fault overlay
  → clamps
```

Phase schedule (`profiles.js`) has **7 phases**: taxi, takeoff, climb, cruise,
loiter, descent, landing.

**Replay** (`replay.js`): `stateAt(t_s)` interpolates (floor-index + linear
interpolation) but **snaps** across fault onset/resolution boundaries rather
than blending. `getRange` returns time- and sample-bounded slices.
`.seek/.step/.play/.pause/.resume/.stop` drive a playhead. A **3-tier anomaly
overlay** labels every sample `nominal` / `precursor` / `active`.

### Artificial J1939 CAN (`missionreplay/can.js`)

A pure-JS replacement for the Linux `vcan`/SocketCAN plan:

- 29-bit arbitration IDs with priority / PGN / source address layout
- an **11-signal PGN map**
- a **5-node bus** (ECU, oil system, thermal, fuel system, MEMS)
- uint16 **byte-scale** signal encoding with a bit-perfect
  `encodeSample` / `decodeFrames` round trip
- a bounded ring-buffer receive window with dropped-frame accounting

The bus is a first-class citizen of the deterministic record (each logged
sample carries its CAN frames), and live `play` streams push frames onto it so
`GET /api/can/status` shows live traffic.

### Audit trail

Ground-truth vs detector comparisons are logged to CSV on disk, with
`scripts/evaluate-missionreplay.js` acting as a CI tripwire.

---

## 15. Accident taxonomy

The evaluators score **isolated** injected faults. Real accidents are what
happen when several degrading channels arrive **at the same time** and start
reinforcing each other.

| Channel | Early, still-manageable read | Accident read (combined) |
|---|---|---|
| Thermal (CHT/EGT/oil temp) | "Overheating trend, reduce power / richen mixture" | Thermal + mechanical + fuel degrading *together* — cooling/coking reaching accident class |
| Mechanical (vibration/RPM) | "Vibration anomaly, propeller/mount inspection due" | Vibration rising **while** the engine is already off-trend thermally |
| Fuel (fuel flow/MAP/RPM) | "Fuel starvation, switch to backup pump / RTB trigger" | Power-loss landing on an already-degraded thermal + mechanical state |

When the retriever sees CHT **and** EGT **and** vibration **and** RPM **and**
fuel flow **and** MAP all out of band at once, single-sensor docs are not
enough — they each explain "this one sensor is drifting". The combined docs
(`pattern-cooling-vibration`, `pattern-power-loss`) exist so the AI says:

> This is a cooling/coking degradation that has progressed **through** a
> mechanical imbalance and **into** a fuel-system power-loss cascade — an
> ACCIDENT-class event, not three independent faults.

That is the difference between "three separate maintenance items" (wrong) and
"one cascading accident that needs an immediate flight-termination response"
(right).

### Runnable demonstration

`node scripts/demo-accident-scenario.js` runs one deterministic mission where
three faults **overlap and cascade**:

| Fault | Onset (fraction) | Duration (fraction) | Severity |
|---|---|---|---|
| `overheating` | 0.23 | 0.65 | moderate |
| `vibration_anomaly` | 0.58 | 0.42 | severe |
| `fuel_starvation` | 0.75 | 0.25 | critical |

It feeds the mission through both detectors and **exits non-zero** if the
combined accident is missed — usable as a CI regression tripwire. Works in and
out of Docker via `TWIN_DATA_DIR`.

The AI box shows a source badge (**LIVE** / fallback / degraded) next to each
explanation, with an "Explain" button to re-run on demand.

---

## 16. 3D digital twin

`public/js/twin3d.js` (three.js, ES module, served from `node_modules` at
`/vendor/three` so it works offline). A procedural horizontally-opposed
**six-cylinder** engine modelled on `public/img/engine-photo.png`, driven by the
same live telemetry:

- crank/prop speed follows RPM, shown in slow motion
- cylinder heads and headers glow with CHT/EGT
- the whole engine shakes with vibration
- air / fuel / exhaust / oil particles flow at rates tied to their sensors
- every component glows nominal / warning / critical from backend status
- pistons and connecting rods use real slider-crank kinematics on a phased boxer crank

**Controls:** orbit/zoom, camera presets, **X-ray** (pistons, rods, crank,
per-cylinder firing flashes), **explode**, **flow layers**, and click any
component for its reading, trend, and what the sensor means.

It consumes the same snapshot as the dashboard via `window.twin3d.update`,
**never recomputes status client-side**, and uses `/api/meta` `SENSORS` bands
only to scale visual intensity.

Full detail: `docs/3D_TWIN_REALISM_GUIDE.md` (633 lines).

---

## 17. Frontend modules

| File | Purpose |
|---|---|
| `public/index.html` | Dashboard markup |
| `public/css/style.css` | SIH theme — navy / saffron / tricolor |
| `public/css/missionlab.css` | MISSION LAB operator console styling |
| `public/js/app.js` | Dashboard rendering + Socket.IO client |
| `public/js/charts.js` | Self-hosted canvas line chart (no chart CDN) |
| `public/js/twin3d.js` | three.js 3D twin |
| `public/js/missionlab.js` | MISSION LAB operator console: replay, CAN, safety verdict |
| `public/js/aiSession.js` | Session-only provider override (in-memory key) |
| `public/img/engine-photo.png` | Reference photo the 3D twin is modelled on |
| `public/img/favicon.svg` | Favicon |

The dashboard shows a **stale telemetry** banner when snapshots stop arriving.

---

## 18. Project structure

Verified against the working tree (excludes `node_modules`, `.git`,
`twin_core/data`, `public/vendor`).

```
aero-piston/
├── server.js                    # Express + Socket.IO backend, REST API, tick loop
├── simulator.js                 # Telemetry generator, 13 SENSORS, 9 FAULT_TYPES,
│                                #   health/RUL model + analytics/ integration
├── config.js                    # Validated env configuration (fails fast)
├── start.js                     # npm start: install-if-needed + open browser
├── eslint.config.js
│
├── engine_sim/                  # Mean-value physics engine
│   ├── physics.js  environment.js  missions.js
│   ├── faults.js   coking.js     observer.js   rng.js   index.js
│
├── analytics/                   # L3 ML layer (see §11.2)
│   ├── healthIndex.js       anomalyDetection.js  isolationForest.js
│   ├── rulModel.js          rulRegressor.js       rulHardcoded.js
│   ├── trendForecast.js     shap.js               explain.js
│   ├── maintenanceRecommendation.js               materialDB.js
│   ├── rainflow.js          fatigueRul.js        mathUtils.js
│   ├── missionReplayMetrics.js
│   └── models/rul-regressor.json
│
├── twin_core/                   # Persisted history + live-state caches
│   ├── store.js  liveHistoryStore.js  stateStore.js  index.js
│
├── replay/                      # engine_sim runner + paced playback
│   ├── missionRunner.js  replayEngine.js  index.js
│
├── missionreplay/               # Spec-driven deterministic recorder
│   ├── profiles.js  generator.js  loader.js  replay.js
│   ├── faultLib.js  can.js  index.js
│   └── missions/eval-probe/     # Committed probe mission
│
├── ai/                          # RAG situation reports
│   ├── knowledgeBase.js  retriever.js  providers.js
│   ├── geminiClient.js   groqClient.js  analysisEngine.js  aiUtil.js
│
├── middleware/                  # security.js  logger.js  errors.js  validate.js
│
├── scripts/
│   ├── run-tests.js             # Cross-version test runner
│   ├── train-rul.js             # Train + emit the RUL regressor
│   ├── calibrate-fault-rules.js
│   ├── calibrate-missionlab-bands.js
│   ├── evaluate-missionreplay.js
│   └── demo-accident-scenario.js
│
├── tests/                       # node:test — 293 tests
│   ├── server/   (api, security, validation, twin, missionReplay, helpers)
│   ├── ai/       (providers, analysisEngine, retriever, aiUtil)
│   ├── core/     (simulator, observer, replay, store, liveHistory)
│   ├── analytics/(ml, fatigue, missionReplayMetrics, rulHardcoded)
│   ├── frontend/ (aiSession, missionlab)
│   └── missionreplay/
│
├── docs/                        # This file + 10 focused docs
├── public/                      # See §17
├── Dockerfile  docker-compose.yml  .dockerignore
├── .github/workflows/ci.yml
├── .env.example  package.json  package-lock.json
└── image.png  image copy.png    # Root images
```

---

## 19. Testing and CI

```bash
npm test              # all suites under tests/ via scripts/run-tests.js
npm run test:server   # tests/server - HTTP API, security, validation, lifecycle
npm run test:ai       # tests/ai     - providers, circuit breaker, analysis engine
npm run test:core     # tests/core   - simulator, observer, replay, store, history
npm run lint          # eslint (flat config)
npm run check         # lint + tests (what CI runs)
```

`npm test` passes an explicit file list to `node --test` so behaviour is
identical on Node 20 and 24. **Tests need no network access and no API keys.**

CI (`.github/workflows/ci.yml`) runs **lint, tests, `npm audit` and a Docker
build on Node 20 and Node 24**. Current state: **293/293 tests passing**, lint
clean.

**Known audit finding:** `npm audit` reports **2 moderate** advisories in
`qs` (array-limit bypass via bracket-key comma parsing, and a DoS via
attacker-controlled `isBuffer`), pulled in transitively by `express` 4.22.2.
Remediation is `npm audit fix`. CI runs the audit non-blocking, so this does not
gate a merge today — but it is a real finding, not a clean bill of health.

`npm run test:server`, `test:ai` and `test:core` are the only suite shortcuts;
`tests/analytics`, `tests/frontend` and `tests/missionreplay` run as part of
`npm test`.

---

## 20. Deployment

See `docs/DEPLOYMENT.md` for the full guide with nginx and Caddy configs.

### Docker (recommended)

```bash
cp .env.example .env
docker compose up -d --build       # http://localhost:5000
docker compose ps                  # (healthy) once /api/health passes
docker compose logs -f twin
```

| Aspect | Setting |
|---|---|
| Base | `node:24-alpine`, multi-stage (`npm ci --omit=dev`) |
| User | non-root `node` |
| Env | `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=5000`, `TWIN_DATA_DIR=/data` |
| Entrypoint | `node server.js` (not `start.js`) |
| Signals | `init: true` / `--init`; drains up to `SHUTDOWN_TIMEOUT_MS`; compose `stop_grace_period` 15 s |
| Health | `HEALTHCHECK` → `/api/health` via Node `fetch` |
| Filesystem | read-only root, `/tmp` tmpfs, `/data` named volume `twin-data` |
| Hardening | `cap_drop: ALL`, `no-new-privileges` |
| Secrets | runtime `env_file`; `.dockerignore` excludes `.env*` except `.env.example` |

Without Docker: `npm ci --omit=dev && NODE_ENV=production node server.js`.

### Reverse proxy

Two things matter: forward the **WebSocket upgrade** for `/socket.io/`
(otherwise Socket.IO silently degrades to long-polling), and set
**`TRUST_PROXY`** to the number of proxy hops so rate limits see the real client
IP. Do **not** set `TRUST_PROXY`** when the app is internet-reachable — clients
could spoof `X-Forwarded-For`. Bind to loopback when co-located
(`HOST=127.0.0.1`).

### Access control

`ADMIN_API_KEY` (≥ 8 chars) guards non-GET `/api` routes only — it is **not**
dashboard login. GET routes, probes and the dashboard stay open. The bundled
dashboard does **not** send the header, so its **Explain now** button returns
`401` when the key is set; either leave that unused or have the proxy inject the
header inside an authenticated location.

### Data and backups

Recordings are JSON-Lines under `TWIN_DATA_DIR`, one directory per engine,
capped by `TWIN_MAX_MISSIONS_PER_ENGINE` and
`TWIN_MAX_READINGS_PER_MISSION`. **The live 3-UAV telemetry is not persisted** —
it is regenerated in memory, and alert history/time series reset on restart.
Back up when no mission run is active (files are appended during a run).

### Scaling

**Run exactly one instance.** Fleet state, alert history, AI cache, provider
cooldowns and replay sessions are all in one process's memory, and Socket.IO
uses its in-memory adapter. Two replicas would each simulate a *different*
fleet. Scaling out needs sticky sessions **and** shared state **and** the
Socket.IO Redis adapter. None of that exists here; vertical headroom is ample.

### Upgrade

```bash
git pull && docker compose up -d --build
docker compose ps && curl -fsS localhost:5000/api/ready
```

---

## 21. Operations runbook

Full troubleshooting table in `docs/OPERATIONS.md`. All data is simulated —
"operational" here means keeping the demo/staging service healthy.

### Probes

| Endpoint | Use | Healthy | Unhealthy |
|---|---|---|---|
| `GET /api/health` | **Liveness** | `200 { ok: true, service, uptime }` | no response |
| `GET /api/ready` | **Readiness** | `200 { ready: true, checks: { fleet, store } }` | `503` with the failing check `false` |

`/api/ready` fails when the fleet has not produced a snapshot yet (`fleet:
false`, startup only), when the data directory is not writable (`store:
false`), or while shutting down. Both bypass rate limiting.

`/api/health` does **not** verify AI availability — the app is
healthy-but-degraded when no provider works. Check `aiAnalysis.degraded`,
`.provider` and `.cooldownUntil` in `/api/ai-analysis`.

### Logs

Structured JSON to stdout/stderr in production, human-readable in development.
`LOG_LEVEL` = `silent|error|warn|info|debug`. Every request logs a `reqId`,
method, URL, status, duration and client IP, echoed in the `X-Request-Id`
response header. Provider cooldown transitions log **once**, not per call. API
keys are never logged.

```bash
docker compose logs twin | grep '"level":"error"'
docker compose logs twin | grep -i cooldown
```

### Common failure modes

- **AI quota exhausted (429)** — cooldown, fall back to Groq, else `degraded:
  true` and a rule-based summary. Mitigate: add the other key, raise
  `AI_ANALYSIS_INTERVAL_MS`, choose a higher-quota `GEMINI_MODEL`, or raise
  `GEMINI_MIN_GAP_MS`.
- **Stale telemetry** — the dashboard banner appears when snapshots stop. Check
  `/api/health`, then proxy websocket config, then logs for `telemetry tick
  failed`.
- **Disk full** — `/api/ready` reports `store: false` and new mission runs
  fail. Free space or lower `TWIN_MAX_MISSIONS_PER_ENGINE`.
- **429 from the API** — `RATE_LIMIT_*` or `MAX_CONCURRENT_MISSIONS`. Behind a
  proxy without `TRUST_PROXY`, every user shares one IP.
- **Socket refused** — `SOCKET_MAX_PER_IP` / `SOCKET_MAX_TOTAL` reached, or the
  browser origin is not in `CORS_ORIGIN`.

### Routine checks

`docker compose ps` shows `(healthy)`; `/api/ready` returns 200; no sustained
error lines; volume usage stable; `npm audit --omit=dev` clean or triaged.

---

## 22. Roadmap to real hardware

### The easy seam

`server.js` depends only on `simulator.js` exporting a fleet with a `.step()`
returning the snapshot shape (`readings`, `statuses`, `health`, `rul`,
`activeFault`, `predictedFault`, `alerts`). Everything above — REST, Socket.IO,
dashboard, `analytics/`, `ai/` — is written against that **shape**, not its
provenance. Swapping in real hardware means replacing the random-walk generator
with a real bus listener that decodes real frames into the same shape on a real
timer.

What the seam does **not** solve: real sensors fail independently (dropout,
drift, out-of-range garbage) in ways a clean random walk never models. The new
acquisition layer needs its own noise/dropout/validation handling.

### Required for certification-grade reliability

- **Redundant sensor validation** — cross-check safety-relevant readings against
  a second sensor or a physics-based estimate.
- **Watchdogs and fail-safe defaults** — currently "sensor stopped reporting"
  and "sensor reports a nominal value" look identical downstream. *Partial,
  UI-level only:* a stale-telemetry banner exists, but per-sensor dropout
  detection and fail-safe values in the models are still absent.
- **Offline validation against real flight-test data** — every model is trained
  and evaluated exclusively on this project's own simulator output.
- **A safety case for AI-driven advisories** — an explicit documented boundary
  for what an AI advisory may influence (maintenance scheduling, yes; in-flight
  engine control, no) and what happens when the AI layer is unavailable.

### Stages

| Stage | Scope |
|---|---|
| **1 — this repo, today** | Fully simulated. Proves the end-to-end pipeline shape and the UX. Artificial CAN as a stepping stone. **No real vcan/SocketCAN, no MQTT**, no real sensors, no real engine. |
| **2 — hardware-in-the-loop** | Real Rotax-class test stand with real thermocouples, oil-pressure transducer, accelerometer. Transport still simulated. Validate real sensor noise/dropout/failure characteristics and start collecting a real labeled dataset. |
| **3 — real UAV flight-test data** | Real airframe FADEC downlink, engineering flights only. Retrain and validate `analytics/` against real distributions. First real ground truth for sensor drift and coking/misfire. |
| **4 — certified deployment** | Redundant validation, watchdogs, documented AI safety case, models frozen/versioned against their validation dataset. **Out of scope for a hackathon prototype** — listed only so the gap is explicit. |

### Service hardening vs. certification

v1.1 hardened the *service* (config validation, rate limiting, optional API key,
probes, graceful shutdown, tests, CI, Docker). That makes the demo reliable to
run; it does **not** change any model's validation status and is not a step
toward certification by itself.

---

## 23. Honest limitations

- **All telemetry is simulated.** No real UAV, engine, FADEC bus or CAN
  hardware is involved.
- **No model has been validated against real engine data.** Rolling z-score,
  Mahalanobis detection, Isolation Forest, the RUL regressor, fatigue life and
  the LLM narratives are all trained/evaluated only on this project's own
  simulator output.
- **Sensor bands are illustrative**, loosely modelled on a Rotax-912-class
  engine — not from a certified type-data sheet.
- **The AI narrative is only as correct as the health model feeding it.** The
  LLM grounds language on numbers the simulator produced; it does not
  independently reason about engine physics. Two providers may word the same
  situation differently and neither is validated.
- **Not a safety-of-flight system.** Observe-only, advisory, fail-soft by
  design. If ever connected to real data, sending telemetry to third-party LLM
  APIs would need a data-handling review.
- **Single instance only** — state is in-process, Socket.IO has no shared
  adapter.
- **No real vcan/SocketCAN and no MQTT.**
- **No persistent cross-mission degradation state** — `coking` is still a
  single-episode window rather than a slow cumulative state.
- **Engine-level sensors only** — no per-cylinder or per-cycle channels, so
  the 3D twin cannot show true per-cylinder variation.
- **Requires third-party LLM APIs** for AI-written reports; without them the
  app degrades gracefully to rule-based text.
