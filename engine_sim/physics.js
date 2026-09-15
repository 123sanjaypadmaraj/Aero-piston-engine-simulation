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
 * Bands below (redline, CHT/EGT/oil limits, nominal fuel flow) are aligned
 * with the SENSORS thresholds already used by the rest of this project
 * (see simulator.js) so this model is a drop-in ground-truth source.
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

function lag(current, target, dt, timeConstS) {
  const alpha = 1 - Math.exp(-dt / timeConstS);
  return current + (target - current) * alpha;
}

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
  };
}

/**
 * Advance the physical engine state by dt seconds given a throttle command
 * (0..1) and the current environment (from environment.js). Returns the
 * next clean (fault-free) physical state — faults.js perturbs this
 * afterwards.
 */
function step(prevState, controls, env, dt) {
  const throttle = Math.max(0, Math.min(1, controls.throttle));

  const mapTarget = manifoldPressureTarget(throttle, env.pressureKPa);
  const manifoldPressureKPa = lag(prevState.manifoldPressureKPa, mapTarget, dt, MAP_TIME_CONST_S);

  const rpmTgt = rpmTarget(throttle, env.densityRatio) * env.powerFactor;
  const rpm = lag(prevState.rpm, Math.max(IDLE_RPM * 0.9, rpmTgt), dt, RPM_TIME_CONST_S);

  const heat = heatRelease(manifoldPressureKPa, rpm, env.pressureKPa);

  const chtTarget = env.tempC + 55 + heat * 155;
  const cht = lag(prevState.cht, chtTarget, dt, CHT_TIME_CONST_S);

  const egtTarget = env.tempC + 480 + heat * 420;
  const egt = lag(prevState.egt, egtTarget, dt, EGT_TIME_CONST_S);

  const oilTempTarget = env.tempC + 35 + heat * 85;
  const oilTemp = lag(prevState.oilTemp, oilTempTarget, dt, OIL_TEMP_TIME_CONST_S);

  // Gear-pump-driven oil pressure: scales with RPM, thins (drops) as oil warms.
  const viscosityFactor = Math.max(0.55, 1 - (oilTemp - 90) * 0.006);
  const oilPressureTarget = 18 + (rpm / REDLINE_RPM) * 48 * viscosityFactor;
  const oilPressure = lag(prevState.oilPressure, oilPressureTarget, dt, OIL_PRESSURE_TIME_CONST_S);

  const fuelFlowTarget = 2.2 + (manifoldPressureKPa / env.pressureKPa) * (rpm / NOMINAL_CRUISE_RPM) * 13.5;
  const fuelFlow = lag(prevState.fuelFlow, Math.max(0.5, fuelFlowTarget), dt, 1.2);

  const vibrationTarget = 0.5 + 1.1 * Math.pow(rpm / REDLINE_RPM, 2.2);
  const vibration = lag(prevState.vibration, vibrationTarget, dt, VIBRATION_TIME_CONST_S);

  const alternatorTarget = rpm > IDLE_RPM * 1.15 ? 14.1 : 12.4 + 1.2 * (rpm / (IDLE_RPM * 1.15));
  const batteryVoltage = lag(prevState.batteryVoltage, alternatorTarget, dt, BATTERY_TIME_CONST_S);

  return {
    rpm,
    manifoldPressureKPa,
    cht,
    egt,
    oilTemp,
    oilPressure,
    fuelFlow,
    vibration,
    batteryVoltage,
    heat,
  };
}

module.exports = {
  step,
  initialState,
  combustionEfficiency,
  manifoldPressureTarget,
  rpmTarget,
  IDLE_RPM,
  REDLINE_RPM,
  NOMINAL_CRUISE_RPM,
};
