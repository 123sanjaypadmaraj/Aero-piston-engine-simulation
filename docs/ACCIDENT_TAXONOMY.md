# Accident Taxonomy

> Read this together with `docs/FAULT_TAXONOMY.md` (single injected faults)
> and `scripts/demo-accident-scenario.js` (the runnable accident-class
> demonstration). This document is about the line between a **developing
> fault** — which a well-trained crew can manage — and an **accident**, which
> is a state the engine cannot be expected to come back from.

## The core distinction the AI box exists to make

The mission-replay evaluators and the analytics health index both score
detectors against *isolated injected faults*: one sensor channel drifts,
the detectors say so, the mission resolves. Real accidents are **not like
that** — they are what happens when several degrading channels arrive at
the *same time* and start reinforcing each other:

| Channel | Early, still-manageable read | Accident read (combined) |
|---|---|---|
| Thermal (CHT / EGT / oil temp) | "Overheating trend, reduce power / richen mixture" | Thermal + mechanical + fuel degrading *together* — cooling/coking degradation reaching accident class |
| Mechanical (vibration / RPM) | "Vibration anomaly, propeller/mount inspection due" | Vibration rise WHILE the engine is already off-trend thermally |
| Fuel (fuel flow / manifold pressure / RPM) | "Fuel starvation, switch to backup pump / RTB trigger" | Power-loss lands on top of an already-degraded thermal + mechanical state |

## Why "one accident, not three faults" is the right conclusion

When the retriever sees CHT **and** EGT **and** vibration **and** RPM **and**
fuel flow **and** manifold pressure all out of band at once, the single-sensor
knowledge-base documents are not enough — they each explain "this one sensor
is drifting". The **combined-signature** KB documents
(`pattern-cooling-vibration`, `pattern-power-loss`) exist precisely so the AI
box says:

> This is a cooling/coking degradation that has progressed **through** a
> mechanical imbalance and **into** a fuel-system power-loss cascade — an
> ACCIDENT-class event, not three independent faults.

That is the difference between "three separate maintenance items" (wrong) and
"one cascading accident that needs an immediate flight-termination response"
(right). The retriever only surfaces the combined docs when all the relevant
channels are off together, which is what keeps the AI's explanation honest.

## Injected accident-class signatures

The mission-replay `faultLib` supports overlapping, multi-channel injection.
`scripts/demo-accident-scenario.js` demonstrates the canonical accident —
three faults whose windows **overlap** instead of resolving one-by-one:

| Fault | Onset (fraction of mission) | Duration (fraction) | Severity |
|---|---|---|---|
| `overheating` | 0.23 | 0.65 | moderate |
| `vibration_anomaly` | 0.58 | 0.42 | severe |
| `fuel_starvation` | 0.75 | 0.25 | critical |

By the end of the mission all three are degrading the same engine at once —
the exact combined signature the AI box and the `pattern-*` docs exist to
explain. The demo exits non-zero if both detectors miss any injected event,
so it can be wired into CI as a regression tripwire for the accident path.

## Badges / source attribution

The AI box shows a source badge (LIVE / fallback / degraded) next to each
explanation and an "Explain" button that re-runs the analysis on demand. The
*where does the explanation come from* story is in `docs/ARCHITECTURE.md`
(AI section) and the combined-pattern grounding lives in `ai/knowledgeBase.js`.
