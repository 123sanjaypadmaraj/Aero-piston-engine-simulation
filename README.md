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
- **Frontend (`public/`)** — a live dashboard (vanilla HTML/CSS/JS +
  Chart.js) showing fleet-wide mission reliability, per-engine health rings,
  a sensor grid with live status coloring, trend charts, and a fault
  prediction / alert feed — styled in an SIH-inspired navy/saffron/tricolor
  theme.

- **AI Engine Situation report (`ai/`)** — a lightweight retrieval-augmented
  generation (RAG) layer that turns each engine's live telemetry into a
  plain-language explanation using the **Gemini API**: a small hand-curated
  knowledge base of engine/fault domain facts (`ai/knowledgeBase.js`) is
  retrieved by tag-matching against the engine's current active/predicted
  fault and any out-of-band sensors (`ai/retriever.js`), then grounded into
  a prompt sent to Gemini (`ai/geminiClient.js`), orchestrated with caching,
  event-driven + interval-based refresh, and graceful fallback
  (`ai/analysisEngine.js`). See **AI Engine Situation Analysis** below.

## Running it

```bash
npm install
npm start
```

Then open **http://localhost:5000**.

- REST snapshot: `GET /api/snapshot`
- Alert history: `GET /api/alerts`
- Sensor/fault metadata: `GET /api/meta`
- Per-engine time series: `GET /api/series/:engineId` (e.g. `uav-01`)
- Live stream: Socket.IO `snapshot` event, emitted every 2s
- AI situation report, all engines: `GET /api/ai-analysis`
- AI situation report, one engine: `GET /api/ai-analysis/:engineId`
- Force a fresh AI analysis now: `POST /api/ai-analysis/:engineId/refresh`
- Live stream: Socket.IO `ai-analysis` event, emitted whenever a fresh analysis completes

## AI Engine Situation Analysis (RAG + Gemini)

Every engine gets a running plain-language "situation report" — e.g. *"RQ-M2
Kestrel is showing early signs of oil pressure loss: pressure has dropped to
38 psi against a 45 psi warning threshold while oil temperature climbs
in step. Recommend reducing power and inspecting the oil system before the
next flight."* — instead of just raw numbers.

**How it works** (`ai/` folder):
1. `knowledgeBase.js` — a small set of hand-written domain notes: what each
   of the four simulated fault types means/causes, what each sensor's
   nominal/danger side represents, and what health score / RUL / mission
   reliability mean.
2. `retriever.js` — the "R" in RAG: given one engine's current snapshot, it
   scores every knowledge doc by tag overlap with that engine's active
   fault, predicted fault, and any sensor currently in warning/critical, and
   returns the top few most relevant docs. (Simple tag matching, not
   embeddings — the knowledge base is small and hand-tagged, so this stays
   accurate without a vector DB dependency.)
3. `analysisEngine.js` — builds a prompt from those retrieved docs plus the
   live telemetry JSON, calls Gemini, and caches the result per engine. It
   also decides *when* to re-analyze: immediately whenever an engine's
   condition changes (nominal → warning → critical, or a fault starts/
   resolves), and otherwise on a longer timer (`AI_ANALYSIS_INTERVAL_MS`) so
   a quiet, nominal engine isn't re-analyzed constantly. Every Gemini call is
   queued through one global rate limiter (`GEMINI_MIN_GAP_MS`) so 3 engines
   becoming "due" on the same tick don't burst the API at once.
4. `geminiClient.js` — a thin wrapper over Gemini's REST `generateContent`
   endpoint (uses Node's built-in `fetch`, no SDK dependency).

The result rides along on every `/api/snapshot` response and `snapshot`
socket event as each engine's `aiAnalysis` field, and a fresh one is also
pushed the moment it's ready via the `ai-analysis` socket event — the
dashboard's **AI Engine Situation Report** panel renders it live, with an
**Explain now** button to force an immediate on-demand analysis for the
selected engine.

**Setup:**
```bash
cp .env.example .env
# then edit .env and set GEMINI_API_KEY (get one at https://aistudio.google.com/apikey)
```
If `GEMINI_API_KEY` is unset, or a Gemini call errors/times out/hits a rate
limit, the feature fails **soft**: a rule-based one-line fallback summary is
shown instead (clearly labeled, never a crash) — the rest of the dashboard
is unaffected either way.

**A note on quotas:** free-tier Gemini keys can carry surprisingly tight
limits — some models are capped at only ~20 requests/**day**, not just per
minute. `AI_ANALYSIS_INTERVAL_MS` and `GEMINI_MIN_GAP_MS` (see
`.env.example`) default to conservative values for this reason; tighten
them (or switch `GEMINI_MODEL`) once you know your key's actual limits at
https://ai.google.dev/gemini-api/docs/rate-limits.

## Project structure

```
SIH/
├── server.js            # Express + Socket.IO backend, REST API, tick loop
├── simulator.js         # Spoofed telemetry generator, fault injection, health/RUL model
├── ai/
│   ├── knowledgeBase.js  # RAG corpus: fault/sensor/health domain knowledge
│   ├── retriever.js      # RAG retrieval: picks relevant docs per engine snapshot
│   ├── geminiClient.js   # Gemini generateContent REST wrapper
│   └── analysisEngine.js # Orchestration: prompts, caching, throttling, fallback
├── .env.example         # GEMINI_API_KEY and related config (copy to .env)
├── package.json
└── public/
    ├── index.html
    ├── css/style.css    # SIH theme (navy / saffron / tricolor accents)
    └── js/app.js        # Dashboard rendering + Socket.IO client
```

## Notes

- All telemetry is **simulated** for demonstration — there is no real UAV or
  FADEC bus connection.
- To swap in real sensor data later, replace `simulator.js`'s tick loop with
  an ingest layer reading the actual data bus; the REST API, socket
  broadcast, and dashboard require no changes.
