/**
 * knowledgeBase.js
 * -----------------------------------------------------------------------
 * Small, hand-curated domain knowledge base for the aero piston engine
 * digital twin. This is the "corpus" side of the retrieval-augmented
 * generation (RAG) pipeline in ./retriever.js + ./analysisEngine.js:
 * instead of sending the LLM raw numbers, we retrieve the handful of
 * documents relevant to the engine's *current* condition (active fault,
 * predicted fault, out-of-band sensors) and ground the model's narrative
 * in that text, so explanations stay accurate and use consistent
 * terminology instead of the model inventing causes.
 *
 * Kept as a plain in-memory array (no vector DB / embeddings dependency)
 * to match the rest of this project's "runs anywhere with just Node.js"
 * philosophy — retrieval here is simple tag matching (see retriever.js),
 * which is plenty for a knowledge base this size.
 * -----------------------------------------------------------------------
 */

'use strict';

const KNOWLEDGE_BASE = Object.freeze([
  {
    id: 'fault-overheat',
    tags: ['overheat', 'cht', 'egt', 'oilTemp'],
    title: 'Thermal Overload (CHT/EGT Rising)',
    text: 'Rising cylinder head temperature (CHT) and exhaust gas temperature (EGT) together point to a thermal overload: typical causes are a lean fuel-air mixture, restricted cooling airflow, or high power settings sustained too long. Left unaddressed it accelerates cylinder/piston wear and can lead to detonation. Recommended action: reduce power/climb rate, richen mixture if manually controlled, and inspect cooling baffles/inlets after landing.',
  },
  {
    id: 'fault-oilLoss',
    tags: ['oilLoss', 'oilPressure', 'oilTemp', 'vibration'],
    title: 'Oil Pressure Loss',
    text: 'Falling oil pressure combined with rising oil temperature indicates a lubrication system problem: low oil quantity, a failing oil pump, a clogged filter, or a leak. This is one of the most time-critical fault modes on a piston engine because bearing surfaces can be damaged within minutes of oil starvation. Recommended action: reduce power immediately, plan for a precautionary landing/RTB, and do not delay maintenance inspection of the oil system.',
  },
  {
    id: 'fault-vibration',
    tags: ['vibration', 'rpm'],
    title: 'Mechanical Imbalance / Vibration Anomaly',
    text: 'Elevated vibration, especially paired with an RPM sag, usually signals a mechanical imbalance: a propeller strike/imbalance, a loosening mount, worn bearings, or an ignition/cylinder misfire. Sustained vibration fatigues engine mounts and airframe structure. Recommended action: reduce RPM to the smoothest available setting, monitor for further RPM drop, and schedule a propeller/mount inspection before the next flight.',
  },
  {
    id: 'fault-fuelStarvation',
    tags: ['fuelStarvation', 'fuelFlow', 'rpm', 'manifoldPressure'],
    title: 'Fuel System Degradation',
    text: 'Falling fuel flow alongside drooping RPM and manifold pressure suggests fuel system degradation: a clogging filter, a failing fuel pump, fuel vaporization, or a restricted line. This can progress to a partial or full power loss. Recommended action: switch to backup fuel pump/tank if available, monitor for further flow decay, and treat this as a mission-abort trigger if flow continues to fall.',
  },
  {
    id: 'sensor-rpm',
    tags: ['rpm', 'general'],
    title: 'Engine Speed (RPM)',
    text: 'RPM is a two-sided health indicator: over-speed risks mechanical overstress, while under-speed usually reflects a developing fault elsewhere (fuel, ignition, mechanical) rather than being a primary failure itself. Sudden RPM changes without a matching throttle/altitude change are a strong anomaly signal.',
  },
  {
    id: 'sensor-oilPressure',
    tags: ['oilPressure', 'general'],
    title: 'Oil Pressure',
    text: 'Oil pressure below the nominal band is a one-sided danger sign only — there is no "too high" failure mode here. Even a brief dip during maneuvering is worth logging; a sustained dip is a maintenance-now item.',
  },
  {
    id: 'sensor-cht-egt',
    tags: ['cht', 'egt', 'general'],
    title: 'Cylinder Head & Exhaust Gas Temperature',
    text: 'CHT and EGT only have an upper danger side. They normally track together; if EGT rises much faster than CHT it points more toward a lean mixture or ignition timing issue than a cooling-airflow problem, and vice versa.',
  },
  {
    id: 'sensor-oilTemp',
    tags: ['oilTemp', 'general'],
    title: 'Oil Temperature',
    text: 'Oil temperature only has an upper danger side. A slow climb usually tracks CHT and points to a cooling or power-setting issue; a climb that arrives together with falling oil pressure points to a lubrication problem and is more urgent than either reading alone.',
  },
  {
    id: 'sensor-vibration',
    tags: ['vibration', 'general'],
    title: 'Vibration',
    text: 'Vibration has only an upper danger side. Because it is measured as a rolling statistic, a spike that is brief and returns to baseline is far less concerning than a slow upward trend, which usually means a developing mechanical fault rather than a transient gust/maneuver.',
  },
  {
    id: 'sensor-fuelFlow',
    tags: ['fuelFlow', 'general'],
    title: 'Fuel Flow',
    text: 'Fuel flow below nominal for the current power setting is the danger side to watch; it has no upper failure threshold in this configuration. It should move in proportion to manifold pressure/RPM — a fuel flow drop without a throttle change is a red flag.',
  },
  {
    id: 'sensor-manifoldPressure',
    tags: ['manifoldPressure', 'general'],
    title: 'Manifold Pressure',
    text: 'Manifold pressure below nominal for the commanded throttle setting suggests induction restriction, a throttle linkage issue, or an altitude/turbo compensation problem; it has no upper danger side in this configuration.',
  },
  {
    id: 'sensor-batteryVoltage',
    tags: ['batteryVoltage', 'general'],
    title: 'Battery Voltage',
    text: 'Battery voltage sagging below nominal points to a charging system fault (alternator/regulator) or a battery nearing end of life; ignition and engine control electronics depend on this rail, so a sustained low reading is a maintenance-priority item even if the engine is otherwise running fine.',
  },
  {
    id: 'concept-health',
    tags: ['health', 'general'],
    title: 'Composite Health Score',
    text: 'The 0-100 health score blends rule-based threshold breaches (nominal/warning/critical per sensor) with a statistical anomaly signal (rolling z-score per sensor). A score can drop even before any single sensor crosses a hard threshold, if several sensors are simultaneously drifting away from their recent baseline — this is what lets the system "predict" a fault a little early.',
  },
  {
    id: 'concept-rul',
    tags: ['rul', 'general'],
    title: 'Remaining Useful Life (RUL)',
    text: 'The remaining-useful-life estimate trends down when health is poor and recovers slowly toward a nominal baseline otherwise. It should be read as a relative trend indicator for this simulated fleet, not a certified maintenance-interval number.',
  },
  {
    id: 'concept-missionReliability',
    tags: ['general'],
    title: 'Mission Reliability',
    text: 'Fleet-wide mission reliability combines the average health across all engines with a penalty for any engine currently in a critical state, giving a single number for go/no-go style situational awareness across the fleet.',
  },
]);

module.exports = { KNOWLEDGE_BASE };
