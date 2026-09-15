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

const CLIMB_DESCENT_RATE_M_S = 6;
const FAULT_TYPES = ['overheat', 'oilLoss', 'vibration', 'fuelStarvation'];

class PhysicsEngine {
  constructor({ missionName, faultTypes, rng, seedAltitude } = {}) {
    this.missionName = missionName && MISSIONS[missionName] ? missionName : 'climbCruiseDescent';
    this.mission = MISSIONS[this.missionName];
    this.rng = rng || Math.random;
    this.elapsedS = 0;
    this.altitude = seedAltitude ?? 300;
    const env0 = isaAtmosphere(this.altitude, this.mission.ambientTempOffsetC);
    this.state = physics.initialState(env0);
    this.faultSchedule = faults.createFaultSchedule(
      faultTypes || this._randomFaultSelection(),
      this.rng,
    );
  }

  _randomFaultSelection() {
    // 0-2 concurrent faults per mission run, matching the plan's guidance to
    // blend simultaneous faults so ML training data isn't unrealistically clean.
    const count = this.rng() < 0.55 ? 1 : this.rng() < 0.85 ? 0 : 2;
    const shuffled = [...FAULT_TYPES].sort(() => this.rng() - 0.5);
    return shuffled.slice(0, count);
  }

  step(dt = 2) {
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

    return {
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
  }
}

module.exports = { PhysicsEngine, MISSIONS, FAULT_TYPES };
