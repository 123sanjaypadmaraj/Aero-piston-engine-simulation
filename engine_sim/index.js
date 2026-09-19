/**
 * Barrel module: a PhysicsEngine instance owns one mission assignment, one
 * randomized fault schedule, and the running physical state, and produces
 * a per-tick reading with the same 9 sensor keys simulator.js already uses
 * (rpm, cht, egt, oilPressure, oilTemp, fuelFlow, vibration,
 * manifoldPressure, batteryVoltage) so it is a drop-in ground-truth source
 * for the acquisition/twin layers.
 */

'use strict';

const physics = require('./physics');
const { isaAtmosphere } = require('./environment');
const { MISSIONS } = require('./missions');
const faults = require('./faults');
const { createRng } = require('./rng');

const CLIMB_DESCENT_RATE_M_S = 6;
const FAULT_TYPES = ['overheat', 'oilLoss', 'vibration', 'fuelStarvation'];
const MAX_STEP_DT_S = 600; // sanity ceiling on a single step

class PhysicsEngine {
  // `rng` (a () => [0,1) function) or `seed` make a run deterministic; with
  // neither, Math.random is used exactly as before.
  constructor({ missionName, faultTypes, rng, seed, seedAltitude } = {}) {
    if (rng !== undefined && rng !== null && typeof rng !== 'function') {
      throw new TypeError('PhysicsEngine: rng must be a function');
    }
    if (faultTypes !== undefined && faultTypes !== null) {
      if (!Array.isArray(faultTypes)) throw new TypeError('PhysicsEngine: faultTypes must be an array');
      const unknown = faultTypes.filter((f) => !FAULT_TYPES.includes(f));
      if (unknown.length) {
        throw new RangeError(`PhysicsEngine: unknown fault type(s) ${unknown.map(String).join(', ')}; allowed: ${FAULT_TYPES.join(', ')}`);
      }
    }
    // hasOwnProperty: a missionName like "constructor"/"__proto__" must not hit Object.prototype
    this.missionName = missionName && Object.prototype.hasOwnProperty.call(MISSIONS, missionName) ? missionName : 'climbCruiseDescent';
    this.mission = MISSIONS[this.missionName];
    this.rng = rng || createRng(seed);
    this.elapsedS = 0;
    this.altitude = Number.isFinite(seedAltitude) ? seedAltitude : 300;
    const env0 = isaAtmosphere(this.altitude, this.mission.ambientTempOffsetC);
    this.state = physics.initialState(env0);
    this.faultSchedule = faults.createFaultSchedule(
      faultTypes ? [...new Set(faultTypes)] : this._randomFaultSelection(),
      this.rng,
    );
    this._last = null; // last fully-finite output, fallback if a value ever goes non-finite
  }

  _randomFaultSelection() {
    // 0-2 concurrent faults per mission run, matching the plan's guidance to
    // blend simultaneous faults so ML training data isn't unrealistically clean.
    const count = this.rng() < 0.55 ? 1 : this.rng() < 0.85 ? 0 : 2;
    // Fisher-Yates (Array#sort with a random comparator is biased)
    const pool = [...FAULT_TYPES];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }

  step(dt = 2) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > MAX_STEP_DT_S) {
      throw new RangeError(`PhysicsEngine.step: dt must be a finite number in (0, ${MAX_STEP_DT_S}] seconds`);
    }
    this.elapsedS += dt;
    const control = this.mission.control(this.elapsedS);

    const altError = control.targetAltitude - this.altitude;
    const maxStep = CLIMB_DESCENT_RATE_M_S * dt;
    this.altitude += Math.max(-maxStep, Math.min(maxStep, altError));

    const env = isaAtmosphere(this.altitude, this.mission.ambientTempOffsetC);
    this.state = physics.step(this.state, { throttle: control.throttle }, env, dt);

    const severities = faults.computeSeverities(this.faultSchedule, this.elapsedS);
    const perturbed = faults.applyFaults(
      {
        rpm: this.state.rpm,
        cht: this.state.cht,
        egt: this.state.egt,
        oilPressure: this.state.oilPressure,
        oilTemp: this.state.oilTemp,
        fuelFlow: this.state.fuelFlow,
        vibration: this.state.vibration,
        manifoldPressureKPa: this.state.manifoldPressureKPa,
        batteryVoltage: this.state.batteryVoltage,
      },
      severities,
      this.elapsedS,
    );

    const airspeed = 70 + control.throttle * 140 * env.powerFactor;

    const out = {
      elapsedS: this.elapsedS,
      mission: this.missionName,
      rpm: perturbed.rpm,
      cht: perturbed.cht,
      egt: perturbed.egt,
      oilPressure: perturbed.oilPressure,
      oilTemp: perturbed.oilTemp,
      fuelFlow: perturbed.fuelFlow,
      vibration: perturbed.vibration,
      manifoldPressure: perturbed.manifoldPressureKPa,
      batteryVoltage: perturbed.batteryVoltage,
      altitude: this.altitude,
      airspeed,
      ambientTempC: env.tempC,
      throttle: control.throttle,
      activeFaults: severities,
    };

    // Never hand a NaN/Infinity to downstream consumers (JSON would turn it
    // into null and stats/charts would break): substitute the last good value.
    for (const k of ['rpm', 'cht', 'egt', 'oilPressure', 'oilTemp', 'fuelFlow', 'vibration', 'manifoldPressure',
      'batteryVoltage', 'altitude', 'airspeed', 'ambientTempC', 'throttle']) {
      if (!Number.isFinite(out[k])) out[k] = this._last && Number.isFinite(this._last[k]) ? this._last[k] : 0;
    }
    this._last = out;
    return out;
  }
}

module.exports = { PhysicsEngine, MISSIONS, FAULT_TYPES, createRng };
