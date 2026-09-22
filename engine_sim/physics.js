/**
 * Mean-value / thermodynamic model of a Rotax-912-class four-stroke,
 * horizontally-opposed, naturally-aspirated aero piston engine.
 *
 * Rather than a full crank-angle-resolved combustion simulation, each
 * sub-system is modelled as a first-order lag toward a physically-derived
 * target value (manifold filling, thermal masses, oil circuit, electrical
 * system) — the standard "mean-value engine model" approach used for
 * control-oriented / real-time engine simulation. A simplified Wiebe-style
 * heat-release fraction drives the combustion heat that feeds the thermal
 * masses, so CHT/EGT respond to throttle+RPM+altitude with realistic lag
 * rather than snapping instantly.
 *
 * Sensor output is aligned with the SENSORS thresholds already used by the
 * rest of this project (see simulator.js + analytics/healthIndex.js), and
 * also generates the fuel/electrical sensors the master plan requires —
 * air-fuel ratio (λ), injector pulse width, injection timing and alternator
 * current — plus derived energy metrics (brake power, torque, BSFC, thermal
 * efficiency, cumulative fuel consumed) that "mission reliability" and
 * "maintenance advisory" calculations can use.
 */

'use strict';

const IDLE_RPM = 1900;
const REDLINE_RPM = 5800;
const NOMINAL_CRUISE_RPM = 5100;

const RPM_TIME_CONST_S = 3.2; // crank/flywheel inertia
const MAP_TIME_CONST_S = 0.45; // manifold filling dynamics (fast)
const CHT_TIME_CONST_S = 55; // cylinder head thermal mass (slow)
const EGT_TIME_CONST_S = 12; // exhaust gas responds faster than metal mass
const OIL_TEMP_TIME_CONST_S = 140; // oil circuit — slowest thermal lag
const OIL_PRESSURE_TIME_CONST_S = 1.8; // pump responds quickly to RPM
const BATTERY_TIME_CONST_S = 2.5;
const VIBRATION_TIME_CONST_S = 1.0;
const LAMBDA_TIME_CONST_S = 1.2; // mixture loop reacts within a few cycles
const PW_TIME_CONST_S = 0.8; // injector pulse width tracks fuel demand
const TIMING_TIME_CONST_S = 2.0; // ignition/injection advance actuator lag
const ELECTRICAL_TIME_CONST_S = 1.0; // alternator load response
const MAX_DT_S = 600; // longest single integration step accepted

// Rotax-912-class constants used for the derived energy metrics.
const PEAK_POWER_KW = 73.5; // ~100 hp class at sea level
const FUEL_DENSITY_KG_PER_L = 0.75;
const GASOLINE_LHV_MJ_PER_KG = 43.1;
const N_CYLINDERS = 6; // matches the 3D twin's six-cylinder layout

function lag(current, target, dt, timeConstS) {
  const alpha = 1 - Math.exp(-dt / timeConstS);
  return current + (target - current) * alpha;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/** Simplified Wiebe-style normalized combustion heat-release efficiency vs RPM. */
function combustionEfficiency(rpm) {
  const x = (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM);
  // Peaks near mid-high RPM, tapers at idle and near redline (pumping/friction losses).
  return 0.55 + 0.45 * Math.sin(Math.PI * Math.min(Math.max(x, 0), 1) * 0.9);
}

function manifoldPressureTarget(throttle, ambientPressureKPa) {
  const idleFraction = 0.32;
  const wotFraction = 0.95; // intake restriction losses even at wide-open throttle
  return ambientPressureKPa * (idleFraction + (wotFraction - idleFraction) * throttle);
}

function rpmTarget(throttle, densityRatio) {
  const effectiveThrottle = throttle * (0.85 + 0.15 * densityRatio);
  return IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * effectiveThrottle;
}

/** Heat energy delivered to the cylinder head / exhaust per unit time (relative units, not SI-calibrated). */
function heatRelease(mapKPa, rpm, ambientPressureKPa) {
  const loadFraction = mapKPa / ambientPressureKPa;
  const rpmFraction = rpm / REDLINE_RPM;
  return loadFraction * rpmFraction * combustionEfficiency(rpm);
}

/**
 * Air-fuel ratio target (λ, absolute AFR). Rich (low AFR) at high load for
 * charge cooling and component protection, leaner (high AFR) at light load.
 */
function lambdaTarget(throttle) {
  return 12.7 + 1.9 * (1 - throttle);
}

/** Injector pulse width target (ms): scales with air mass per cylinder per cycle. */
function injectorPulseWidthTarget(mapKPa, rpm, ambientPressureKPa) {
  const loadFraction = mapKPa / ambientPressureKPa;
  return 2.0 + loadFraction * 1.5 + (rpm / REDLINE_RPM) * 0.9;
}

/** Ignition/injection advance target (deg before TDC): advances with RPM and load. */
function injectionTimingTarget(rpm, mapKPa, ambientPressureKPa) {
  return 14 + 6 * (rpm / REDLINE_RPM) + 6 * (mapKPa / ambientPressureKPa);
}

/** Electrical system: bus load in watts grows with RPM (belt-driven alternator) + a constant payload draw. */
function electricalLoad(rpm) {
  return 180 + 0.02 * rpm;
}

/** Brake power (kW) at the prop flange, derated by air density (Gagg-Farrar). */
function brakePowerKw(env, mapKPa, rpm) {
  const loadFraction = mapKPa / env.pressureKPa;
  const speedFraction = rpm / NOMINAL_CRUISE_RPM;
  return PEAK_POWER_KW * env.powerFactor * Math.pow(Math.max(0.12, loadFraction), 1.05) * Math.max(0.08, Math.pow(speedFraction, 1.15));
}

function initialState(env) {
  return {
    rpm: IDLE_RPM,
    manifoldPressureKPa: manifoldPressureTarget(0, env.pressureKPa),
    cht: env.tempC + 40,
    egt: env.tempC + 120,
    oilTemp: env.tempC + 30,
    oilPressure: 0,
    fuelFlow: 0,
    vibration: 0.6,
    batteryVoltage: 12.6,
    lambda: lambdaTarget(0),
    injectorPulseWidth: injectorPulseWidthTarget(manifoldPressureTarget(0, env.pressureKPa), IDLE_RPM, env.pressureKPa),
    injectionTiming: injectionTimingTarget(IDLE_RPM, manifoldPressureTarget(0, env.pressureKPa), env.pressureKPa),
    alternatorCurrent: electricalLoad(IDLE_RPM) / 12.6,
    electricalLoadW: electricalLoad(IDLE_RPM),
    cumulativeFuelL: 0,
    perCylinderFuelTrim: Array(N_CYLINDERS).fill(1),
  };
}

/**
 * Advance the physical engine state by dt seconds given a throttle command
 * (0..1), the current environment (from environment.js) and an optional
 * degradation factor (0..1, e.g. accumulated coking deposits that reduce
 * breathing and raise heat load). Returns the next clean (fault-free)
 * physical state — faults.js perturbs this afterwards.
 */
function step(prevState, controls, env, dt, degradation = 0) {
  // A NaN/negative dt or throttle would poison every lagged state forever
  // (each value feeds the next tick), so sanitize at the boundary.
  dt = Number.isFinite(dt) ? Math.max(0, Math.min(MAX_DT_S, dt)) : 0;
  const rawThrottle = controls && Number.isFinite(controls.throttle) ? controls.throttle : 0;
  const throttle = clamp01(rawThrottle);
  // Degradation (coking) shrinks effective power and breathing slightly.
  const derate = Number.isFinite(degradation) ? Math.max(0, Math.min(1, degradation)) : 0;

  const mapTarget = manifoldPressureTarget(throttle, env.pressureKPa);
  const deratedMap = mapTarget * (1 - derate * 0.10);
  const manifoldPressureKPa = lag(prevState.manifoldPressureKPa, deratedMap, dt, MAP_TIME_CONST_S);

  const rpmTgt = rpmTarget(throttle, env.densityRatio) * (1 - derate * 0.04);
  const rpm = lag(prevState.rpm, Math.max(IDLE_RPM * 0.9, rpmTgt), dt, RPM_TIME_CONST_S);

  const heat = heatRelease(manifoldPressureKPa, rpm, env.pressureKPa) * (1 + derate * 0.25);

  const chtTarget = env.tempC + 55 + heat * 155 + derate * 14;
  const cht = lag(prevState.cht, chtTarget, dt, CHT_TIME_CONST_S);

  const egtTarget = env.tempC + 480 + heat * 420 + derate * 20;
  const egt = lag(prevState.egt, egtTarget, dt, EGT_TIME_CONST_S);

  const oilTempTarget = env.tempC + 35 + heat * 85 + derate * 12;
  const oilTemp = lag(prevState.oilTemp, oilTempTarget, dt, OIL_TEMP_TIME_CONST_S);

  // Gear-pump-driven oil pressure: scales with RPM, thins (drops) as oil warms.
  const viscosityFactor = Math.max(0.55, 1 - (oilTemp - 90) * 0.006);
  const oilPressureTarget = 18 + (rpm / REDLINE_RPM) * 48 * viscosityFactor;
  const oilPressure = lag(prevState.oilPressure, oilPressureTarget, dt, OIL_PRESSURE_TIME_CONST_S);

  const fuelFlowTarget = (2.2 + (manifoldPressureKPa / env.pressureKPa) * (rpm / NOMINAL_CRUISE_RPM) * 13.5) * (1 + derate * 0.05);
  const fuelFlow = lag(prevState.fuelFlow, Math.max(0.5, fuelFlowTarget), dt, 1.2);

  const vibrationTarget = 0.5 + 1.1 * Math.pow(rpm / REDLINE_RPM, 2.2) + derate * 0.4;
  const vibration = lag(prevState.vibration, vibrationTarget, dt, VIBRATION_TIME_CONST_S);

  // Electrical: bus load grows with RPM; voltage is lifted by the alternator
  // above ~15% above idle and sags toward the battery's resting voltage when
  // the alternator is not driving.
  const electricalLoadW = electricalLoad(rpm);
  const alternatorActive = rpm > IDLE_RPM * 1.15;
  const batteryTarget = alternatorActive
    ? 14.2 - Math.min(0.6, electricalLoadW * 0.0012)
    : 12.4 - Math.min(0.6, electricalLoadW * 0.0012);
  const batteryVoltage = lag(prevState.batteryVoltage, batteryTarget, dt, BATTERY_TIME_CONST_S);
  const alternatorCurrent = lag(prevState.alternatorCurrent, electricalLoadW / Math.max(9, batteryVoltage), dt, ELECTRICAL_TIME_CONST_S);

  // Mixture + injection/ignition advance.
  const lambda = lag(prevState.lambda, lambdaTarget(throttle), dt, LAMBDA_TIME_CONST_S);
  const injectorPulseWidth = lag(prevState.injectorPulseWidth, injectorPulseWidthTarget(manifoldPressureKPa, rpm, env.pressureKPa), dt, PW_TIME_CONST_S);
  const injectionTiming = lag(prevState.injectionTiming, injectionTimingTarget(rpm, manifoldPressureKPa, env.pressureKPa), dt, TIMING_TIME_CONST_S);

  // Fuel accounting.
  const fuelConsumed = (fuelFlow * FUEL_DENSITY_KG_PER_L * GASOLINE_LHV_MJ_PER_KG) / 3600; // MJ added this step
  const cumulativeFuelL = prevState.cumulativeFuelL + (fuelFlow * dt) / 3600;

  // Derived energy metrics.
  const powerKw = brakePowerKw(env, manifoldPressureKPa, rpm);
  const torqueNm = (powerKw * 1000) / Math.max(1, (rpm * 2 * Math.PI) / 60);
  const fuelMassKgH = fuelFlow * FUEL_DENSITY_KG_PER_L;
  const bsfcGPerKwh = powerKw > 0.5 ? (fuelMassKgH * 1000) / powerKw : 0;
  const thermalEfficiency = fuelConsumed > 0 ? (powerKw * 0.001 * dt) / (fuelConsumed / GASOLINE_LHV_MJ_PER_KG) : 0;

  const next = {
    rpm,
    manifoldPressureKPa,
    cht,
    egt,
    oilTemp,
    oilPressure,
    fuelFlow,
    vibration,
    batteryVoltage,
    lambda,
    injectorPulseWidth,
    injectionTiming,
    alternatorCurrent,
    electricalLoadW,
    cumulativeFuelL,
    powerKw,
    torqueNm,
    bsfcGPerKwh,
    thermalEfficiency,
    heat,
  };
  // Last line of defense: never let a non-finite value into the state chain.
  for (const k of Object.keys(next)) {
    if (!Number.isFinite(next[k])) next[k] = Number.isFinite(prevState[k]) ? prevState[k] : 0;
  }
  return next;
}

module.exports = {
  step,
  initialState,
  combustionEfficiency,
  manifoldPressureTarget,
  rpmTarget,
  lambdaTarget,
  injectorPulseWidthTarget,
  injectionTimingTarget,
  electricalLoad,
  brakePowerKw,
  IDLE_RPM,
  REDLINE_RPM,
  NOMINAL_CRUISE_RPM,
  N_CYLINDERS,
  PEAK_POWER_KW,
  FUEL_DENSITY_KG_PER_L,
  GASOLINE_LHV_MJ_PER_KG,
};