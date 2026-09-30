# SIH 2026 — Garuda-x — Slide Script

**Problem ID:** SIH26054
**Title:** AI-Enabled Real-Time Digital Twin System for Health Monitoring, Fault Prediction and Mission Reliability Enhancement of Aero Piston Engines used in MALE UAVs
**Category:** Robotics and Drones / Software
**Team:** Manthan (NHCE-SIH-18) · **Product:** Garuda-x

Six slides, ~8 minutes. The timing in each heading is a target, not a hard rule.
Every number below was measured from the repository on 2026-09-30. If a figure changes,
re-measure it rather than retyping from memory — the commands are in the margin notes.

**Golden rule for the whole deck:** telemetry is simulated and the ML models are
unvalidated. Never imply flight-certified output. Say "simulated", say "trained on
simulated data", say "on the roadmap" whenever a thing does not exist yet.

> **Where the numbers come from (re-measurable).**
> - Fault classes: `Object.keys(require('./missionreplay/faultLib').FAULT_TYPES).length` → 20
> - Knowledge-base docs: `Object.keys(require('./ai/knowledgeBase').KNOWLEDGE_BASE).length` → 17
> - Live sensors: 13 · live fault classes: 9 · `engine_sim` fault families: 9
> - Tests: `npm run check` → 293 passing (0 fail), lint clean
> - Detection rate + lag: inject each class at `onset_s: 700`, `duration_s: 600`,
>   `severity: 'critical'` on the cruise-centred phase schedule and read `detected_s`
>   off the returned fault events → 20/20 detected, median lag 185 s, max 563 s.
> - Clean-mission silence: `scripts/calibrate-fault-rules.js` exits non-zero if a clean
>   mission raises any event, and a unit test asserts the same.

---

## Slide 1 — Title (0:20)

- "Garuda-x" and the full problem title, problem ID SIH26054, team Manthan, NHCE-SIH-18.
- One line positioning: *a digital twin of the aero piston engine that watches health, predicts
  faults, and explains itself in plain language while the mission is still flying.*
- Live demo standing by in the browser (the deck is presented **on** the running site).

Say: "Everything you will see runs in a browser tab against a live server. The aircraft
engine is simulated; the health logic is real software."

Do not: claim hardware, flight-test data, or a deployed system.

---

## Slide 2 — Problem, USP, and how it flows (1:30)

**Problem (three lines, with the numbers).**
1. A MALE UAV piston engine fails on a handful of channels at once — and a single-channel
   threshold is what most monitors use. CHT alone is a bad day; CHT + EGT + vibration
   *while RPM and fuel flow collapse* is a different event entirely.
2. When it does fail, the operator gets an alarm, not an answer: which sensor drove it,
   how bad, and what to do before the next sortie.
3. Faults on a real engine are recorded in a log after the fact. Nothing correlates them
   with mission phase, so the same reading means "taxi" in one phase and "crisis" in another.

**Unique Selling Points (one line each).**
- **Phase-aware detection.** Every rule is gated on mission phase, so a normal takeoff
  does not look like a stall.
- **Deterministic safety floor.** The combined-signature verdict is computed locally
  before any LLM is called. The AI explains; it never decides.
- **Self-diagnosing replay.** Any recorded mission can be replayed with the faults
  re-injected on demand and the detectors scored against ground truth.
- **Session-only AI provider.** The operator can paste their own key in the page; it is
  never written to disk, cookies, or the server.

**Flow (single arrow strip).**
`Simulated engine (13 sensors) → Twin core → Health index + RUL → Anomaly/Fault detection
→ Deterministic verdict → LLM narrative (Gemini → Groq fallback) → Dashboard / MISSION LAB`

Say: "The point of the design is that the AI is the last step, not the first. Every safety
decision is made by code we can test, with or without a network connection."

> Do not put performance numbers on this slide. There are none yet, and inventing a
> "99.5% accuracy" is the fastest way to lose a judge's trust.

---

## Slide 3 — Technical approach (2:30)

Walk the stack bottom-up, one box per beat.

1. **Two ground-truth sources, side by side.**
   - Live fleet (`simulator.js`): per-sensor noise + random walk + threshold classification,
     streamed over Socket.IO, always on. 9 live fault classes.
   - Mission model (`engine_sim/`): mean-value physics — Wiebe-style combustion, ISA
     altitude derating, first-order thermal lag. 9 injected fault families.
2. **Twin core.** Rolling window per channel, Kalman observer with steady-state gain,
   validity + staleness marking (a dropout is a data state, not a fault).
3. **Analytics.** Health index, hard-coded + ridge RUL regressor, isolation forest
   (unsupervised), trend forecast, SHAP attribution, rainflow/Miner fatigue, and a
   self-calibrating threshold detector. 13 sensors feed these.
4. **Fault detection.** 20 mission-replay fault classes with calibrated detection rules
   (`missionreplay/faultLib.js`), phase-gated, with per-class severity multipliers.
5. **Deterministic verdict.** `classifySignature()` splits *accident* from *degradation*
   using the knowledge base's combined patterns — computed locally, identical with or
   without an LLM. 17 knowledge-base documents are the grounding corpus.
6. **Explain layer.** A prompt is built from the retrieved documents + live readings +
   the verdict as an explicit constraint, then Gemini answers, with Groq as fallback and
   a deterministic rule-based sentence if both fail. Circuit breakers and cooldowns mean
   a dead provider degrades the sentence, never the verdict.
7. **MISSION LAB.** Replay any recorded mission, step and scrub frame by frame, inject
   faults by hand, and score the detectors against ground truth.

**The one-sentence closer for this slide:**
"The AI is a narrator. It is handed a verdict it is not allowed to contradict."

> Roadmap (say the word "roadmap" out loud): the same replay ground truth is what a
> future engine-flash validation set would be built from. The scoring harness exists;
> the real engine data does not. Do not blur that line.

---

## Slide 4 — Feasibility, validation, and risks (2:00)

**What is already true, and provable in the repo.**
- The full stack runs on a laptop: `npm start` → live dashboard + MISSION LAB.
- 293 automated tests (`npm run check`) cover physics, analytics, detection, the AI
  pipeline, the API, and the front end. Lint is clean.
- A clean 1700 s mission raises **zero** false events. All 20 replay fault classes are
  detectably injected inside a cruise window — **20/20** — with a median detection lag of
  about **185 s** (worst case ~9 min). Both are asserted by tests, not claimed.
- MISSION LAB's evaluation panel scores the detectors against the mission's own
  ground truth and reports precision / recall / F1 per detector, per fault, plus a
  margin sweep. **Say "the harness reports them" — do not quote a headline accuracy
  number.** Per-sample precision is low because detectors hold their flag for a whole
  excursion window, not a single sample; quoting the aggregate F1 would mislead.

**Risks, and the honest answer to each.**
| Risk | How we handle it |
| --- | --- |
| Simulation ≠ reality | Every number is labelled simulated; real engine data is roadmap, not claim. |
| LLM hallucination | The verdict is computed locally and passed as a hard constraint; the LLM can only phrase it. |
| Both AI providers down | Circuit breakers + cooldowns; the rule-based sentence still renders, verdict still correct. |
| API key security | The dashboard accepts a session-only key held in browser memory, sent per request and discarded; the server keeps no copy. |
| False alarms in normal flight | Phase-gated rules + relative RPM floors, calibrated against a clean mission. |
| Detector tuning is self-calibrated | Thresholds are learned from the data itself and the mode is shown in the UI, not hidden. |

**Say this before moving on:**
"The honest summary is: the software is real and tested, the data is synthetic, and the
path to real validation is a specific piece of work, not a vague intention."

---

## Slide 5 — Impact (1:00)

- **For the operator:** one screen that answers *what is wrong, how bad, and what do I do
  next* — instead of a scrolling alarm log to interpret at altitude.
- **For maintenance:** fatigue cycles, health trend and remaining useful life accumulate
  per airframe, so parts are scheduled on evidence rather than on a fixed interval.
- **For the mission:** mission reliability and the number of critical engines are tracked
  fleet-wide, continuously.
- **For the team / for India:** the whole thing is open source and runs offline on a
  laptop — a small UAV operator team gets a health-monitoring capability that currently
  exists only in large commercial engines. No licence, no cloud account, no per-seat cost.
- **For SIH's mission:** every capability runs on simulated data today, and the replay
  ground-truth harness is the exact scaffold a future real-engine dataset plugs into.

Say: "The deliverable is not a dashboard. It is the evaluation harness and the safety floor —
the two things you cannot bolt on after you have real engines."

> Roadmap (label it): real engine-flash dataset, CAN hardware-in-the-loop, and a certified
> advisory product are all *next*, not now.

---

## Slide 6 — References and close (0:40)

**References (only ones the project actually leans on).**
- Wiebe / mean-value combustion modelling — the basis of `engine_sim/`'s fuel and torque model.
- Park & Miller, *A RUL estimator for aircraft engines* — the RUL feature set used in `analytics/rulRegressor.js`.
- SAE JA2271 / ARP4754 concepts — safety-partition vocabulary for the "AI explains, code decides" split.
- NASA prognostic-centre practice — knowledge-base + signature-driven diagnosis.
- Gemini and Groq API documentation — the two LLM providers behind the narrative layer.

**Close (one sentence, then stop talking):**
"Garuda-x turns a piston engine into something that explains itself — and proves its
explanations against ground truth every time."

Then: live demo, and take questions. Have the site already open with MISSION LAB expanded
and a faulted mission loaded so the first question ("how do you know it's right?") can be
answered by scrolling to the evaluation panel rather than by describing it.

---

## Speaker notes / failure drills

- **If the demo dies:** the deck stands alone. Slide 3 boxes are the architecture; slide 4
  the table is the argument. Do not apologise at length — say "the dashboard will be back,
  let me show you the recorded run" and use MISSION LAB's evaluation panel offline.
- **If asked "what accuracy do you claim?"** — "Every one of the 20 fault classes is
  detected when injected in cruise, with a median lag around three minutes, and a clean
  mission produces zero detections — both are asserted in the test suite. The evaluation
  panel reports precision/recall/F1 per detector; I won't quote a single headline number,
  because per-sample precision is depressed by design: a detector holds its flag for the
  whole excursion, not one sample. On real data we have no number at all, and I won't
  invent one."
- **If asked "can you prove it right now?"** — "Yes: `npm run check` runs 293 tests
  including the clean-mission and all-20-detected assertions. Want me to run it?"
- **If asked "is the AI making safety decisions?"** — "No. The verdict is computed locally
  from the knowledge base's combined patterns before any model is called, and the prompt
  passes it as a constraint the model must not contradict."
- **If asked "where is the key stored?"** — "Nowhere. It is held in a closure in the page, sent
  as a request header for one analysis, used once, and discarded. There is a test asserting
  the module touches no storage API."
- **If asked about flight data:** "Simulated only. That is the stated limitation on slide 4."
