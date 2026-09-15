# Fault Taxonomy

## Implemented fault scenarios (`simulator.js`, `FAULT_TYPES`)

Four fault scenarios are implemented today. Each is a named drift applied to
specific sensors' random walk, ramped in over its active duration
(`severityRamp`, 0→24 ticks) and cleared after a randomized number of ticks
(18–40, ~36–80s at the 2s tick rate). Exact values as coded:

| Key | Label | Affected sensors | Drift (per tick, scaled by span × 0.03 × severity ramp) |
|---|---|---|---|
| `overheat` | Thermal Overload (CHT/EGT Rising) | `cht`, `egt`, `oilTemp` | cht +0.9, egt +1.6, oilTemp +0.45 |
| `oilLoss` | Oil Pressure Loss | `oilPressure`, `oilTemp`, `vibration` | oilPressure −0.55, oilTemp +0.3, vibration +0.03 |
| `vibration` | Mechanical Imbalance / Vibration Anomaly | `vibration`, `rpm` | vibration +0.16, rpm −6 |
| `fuelStarvation` | Fuel System Degradation | `fuelFlow`, `rpm`, `manifoldPressure` | fuelFlow −0.22, rpm −12, manifoldPressure −0.6 |

A fault starts probabilistically (12% chance per eligible tick, after a
15–35 tick cooldown) and only one fault is active per engine at a time —
there is no current support for two simultaneous overlapping faults on the
same engine.

Sensor definitions and thresholds (`SENSORS` table) are illustrative values
loosely modeled on a Rotax-912-class four-stroke piston engine, **not**
sourced from a certified type-data sheet — treat all nominal/warning/critical
bands as representative, not authoritative:

| Sensor | Nominal band | Warn / Crit (bad side only shown) |
|---|---|---|
| RPM | 4600–5600 | low 4200/3800, high 5800/6100 |
| CHT (°C) | 90–145 | high 145/168 |
| EGT (°C) | 650–760 | high 760/800 |
| Oil pressure (psi) | 45–62 | low 45/30 |
| Oil temp (°C) | 80–108 | high 108/125 |
| Fuel flow (L/h) | 12–18 | low 12/8 |
| Vibration (mm/s) | 0.4–2.4 | high 2.4/4.2 |
| Manifold pressure (kPa) | 88–106 | low 88/78 |
| Battery voltage (V) | 12.6–14.6 | low 12.6/11.8 |

## Mapping to the master plan's 8-category taxonomy

The master plan specifies 8 target fault categories. Mapping what's
implemented against that list:

| Master-plan category | Status | Notes |
|---|---|---|
| Overheating trend | **Covered** | `overheat` — direct CHT/EGT/oilTemp drift |
| Lubrication issues | **Covered** | `oilLoss` — oil pressure loss + oilTemp rise |
| Abnormal vibration pattern | **Covered** | `vibration` — mechanical imbalance, vibration RMS rise + RPM sag |
| Injector abnormality | **Partially covered** | `fuelStarvation` approximates fuel-system degradation generically; it does not model injector-specific signatures (e.g. per-cylinder fuel trim divergence, injector pulse-width anomalies) |
| Combustion instability | **Partially covered** | No dedicated fault; `fuelStarvation`'s RPM/manifold-pressure drift is the closest existing proxy, but there's no cylinder-level pressure/torque-ripple signal to represent misfire-adjacent instability |
| Misfire | **Not covered** | No per-cylinder or per-cycle signal exists in the sensor set (`SENSORS` is engine-level, not per-cylinder) — misfire would need a distinct fault type and likely a higher-rate/per-cycle signal that isn't modeled |
| Cooling / coking degradation | **Not covered** | No slow, irreversible degradation-curve fault exists — all 4 implemented faults are transient (they start, ramp, and fully resolve within ~1 minute); coking is a long-horizon, cumulative degradation that would need a persistent per-mission or per-engine-hours state, not a per-fault-episode drift |
| Sensor drift / failure | **Not covered** | All faults today model true physical degradation; none model a sensor itself reporting incorrect values while the underlying engine is healthy (e.g. a stuck oil-pressure transducer). This is a meaningfully different failure mode for the anomaly detector to learn — it should not correlate across otherwise-healthy sensors the way a real fault does |

**Future work**, in priority order for closing these gaps: (1) sensor
drift/failure faults (highest safety value — the health model as currently
written would misattribute a bad sensor to a healthy engine or vice versa,
and it's cheap to add since it only requires biasing one signal
independently of the "true" physics state), (2) a persistent coking/cooling
degradation state that accumulates slowly across a mission library rather
than resolving within one episode, (3) per-cylinder or per-cycle signals to
support misfire and combustion-instability fault types, which requires
extending the sensor model itself, not just adding a new entry to
`FAULT_TYPES`.
