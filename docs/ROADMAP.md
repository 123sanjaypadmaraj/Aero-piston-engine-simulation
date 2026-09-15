# Deployment Roadmap — From Simulated Demonstrator to Real ECU/FADEC Feed

This repo's `README.md` already states the intended seam: *"To swap in real
sensor data later, replace `simulator.js`'s tick loop with an ingest layer
reading the actual data bus; the REST API, socket broadcast, and dashboard
require no changes."* This document expands that one-line design intent
into a staged plan, and is honest about what else has to change beyond
that seam for this to become anything more than a demo.

## What changes at the L0/L1 boundary (the easy part)

`server.js` (L2) only depends on `simulator.js` exporting a
`DigitalTwinFleet` with a `.step()` method that returns the per-engine
snapshot shape it already consumes (`readings`, `statuses`, `health`,
`rul`, `activeFault`, `predictedFault`, `alerts`). Everything above that
line — REST API, Socket.IO broadcast, dashboard, `analytics/`, `ai/` — is
written against that snapshot shape, not against how it was produced.
Concretely, moving to real hardware means replacing `simulator.js`'s
random-walk generator with a real bus listener (CAN/ARINC-429/whatever the
actual FADEC exposes) that decodes real frames into the same snapshot
shape and calls `fleet.step()`'s equivalent on a real timer instead of a
`setInterval`. This is the "easy part" specifically because this repo was
built with that seam as an explicit design goal — it is not automatically
true of every prototype.

What is **not** automatically solved by that seam: real sensors fail
independently (dropout, drift, out-of-range garbage) in ways this
simulator's clean random walk does not model. The acquisition layer taking
over from `simulator.js` needs its own noise/dropout/validation handling —
see Stage 2 below — not just a frame decoder.

## What has to change for certification-grade reliability

None of this is done in the current prototype, and it is a materially
larger effort than the acquisition swap above:

- **Redundant sensor validation.** A real safety-relevant reading (e.g. oil
  pressure) needs cross-checks against a second sensor or a physics-based
  estimate before it's trusted, not a single transducer value fed straight
  into a threshold check.
- **Watchdogs and fail-safe defaults.** The current code has no notion of
  "this sensor stopped reporting" vs. "this sensor reports a value that
  happens to be nominal" — a stalled telemetry feed and a healthy engine
  currently look identical downstream. A real system needs staleness
  detection and defined fail-safe behavior (e.g. flag as unknown/critical,
  not silently hold the last value).
- **Offline model validation against real flight-test data.** Every model
  in `docs/MODEL_CARDS.md` is trained and evaluated exclusively on this
  project's own simulator output. Before any anomaly-detection or RUL
  output is trusted operationally, it needs evaluation against real
  logged engine data with known ground-truth failures — which does not
  exist yet for this project.
- **A safety case for AI-driven advisories.** Both the `analytics/`
  predictions and the `ai/` Gemini narrative are advisory/explanatory, not
  actuating — that's the right posture for a prototype, but a fielded
  system needs an explicit, documented boundary for what an AI-derived
  advisory is allowed to influence (e.g. maintenance scheduling, yes;
  in-flight engine control, no) and what happens when the AI layer is
  unavailable (the current fail-soft fallback in `ai/analysisEngine.js` is
  a reasonable pattern to carry forward, but the *dashboard's* handling of
  "this is a fallback, not a real analysis" would need to be much more
  visually explicit than it is today for operational use).

## Staged plan

**Stage 1 — this repo, today.** Fully simulated: `simulator.js` (soon
`engine_sim/`) generates ground truth, Socket.IO stands in for the
telemetry bus, `analytics/`+`ai/` produce health/fault/RUL/narrative
output, `public/` displays it. Purpose: prove the end-to-end pipeline
shape and demonstrate the UX, not to produce operationally trustworthy
numbers. No CAN/MQTT (see `docs/ARCHITECTURE.md` for why), no real
sensors, no real engine.

**Stage 2 — hardware-in-the-loop.** Swap `simulator.js`'s generator for a
real Rotax-class test-stand engine instrumented with real sensors (CHT/EGT
thermocouples, an actual oil-pressure transducer, a real accelerometer for
vibration, etc.), but keep the transport simulated (still Socket.IO, or a
real CAN bus over an actual SocketCAN adapter if moving off Windows) rather
than a flight-qualified data bus. Goal: validate that the acquisition layer
handles real sensor noise/dropout/failure characteristics, and start
collecting a real labeled dataset (known induced faults on a test stand)
to replace the purely synthetic training data behind `analytics/`.

**Stage 3 — real UAV flight-test data collection.** Move to an actual UAV
airframe's FADEC/telemetry downlink, still non-operational (test/
engineering flights only). Collect real flight data across real mission
profiles (climb/cruise/descent, altitude/temperature variation) to retrain
and validate the `analytics/` models against real, not simulated,
distributions. This is also where sensor drift/failure and
coking/misfire fault categories (currently unmodeled — see
`docs/FAULT_TAXONOMY.md`) would first get real ground truth, since they
are hard to synthesize convincingly and easy to observe on a real
airframe over time.

**Stage 4 — certified onboard/ground-station deployment.** Only after
Stage 3 validation: redundant sensor validation, watchdogs/fail-safe
behavior, and a documented AI-advisory safety case (all described above)
are implemented and independently reviewed, the models are frozen/
versioned against their validation dataset (not silently retrained in
place), and the system is deployed as a ground-station or onboard
advisory tool under whatever certification regime applies to the
platform. This stage is out of scope for a hackathon prototype and is
listed here only so the gap between "working demo" and "fielded system"
is explicit rather than implied away.
