/**
 * materialDB.js
 * -----------------------------------------------------------------------
 * Deterministic part & material database for the fatigue-based RUL layer.
 * Implements the "Part & material DB (Geometry, Kt, S-N curves)" stage of
 * the fatigue pipeline with zero runtime randomness — the same input stress
 * always yields the same life estimate.
 *
 * S-N behaviour uses a Basquin power law anchored to the material ultimate
 * tensile strength (S = 0.9*Sut at 1e3 cycles) and to each part's effective
 * local endurance limit `seMpa` (already folded through the stress
 * concentration factor, so `seMpa` is the endurance seen AT the critical
 * location, not the polished-coupon figure):
 *
 *   S(N)  = a * N^b          (Basquin, b < 0, valid above the endurance floor)
 *   a     = 0.9*Sut / 1000^b
 *   Nf(S) = (S / a)^(1 / b)
 *
 * Local (notch-adjusted) stress: Kf = 1 + q*(Kt - 1), applied to the nominal
 * stress before it is compared against `seMpa`.
 *
 * Every field below is a fixed constant; PARTS/MATERIALS are frozen so no
 * caller can silently mutate the life model.
 * -----------------------------------------------------------------------
 */

'use strict';

const { clamp } = require('./mathUtils');

const MATERIALS = Object.freeze({
  steel4340: Object.freeze({ name: 'AISI 4340 (quenched & tempered)', utsMpa: 1240 }),
  steel8620: Object.freeze({ name: 'AISI 8620 (case-hardened)', utsMpa: 980 }),
  alu7075t6: Object.freeze({ name: '7075-T6 aluminium', utsMpa: 510 }),
});

// Per-part surrogate stress model. For each telemetry sample the alternating
// stress amplitude at the critical location is approximated (duty-cycle mode)
// as:
//   Sa = Kf * stressFactor * max(0, reading[stressKey] - stressBias)
// and the mean (static) stress as:
//   Sm = groundMean + meanFactor * max(0, reading[meanKey] - meanBias)
//       (when meanKey is set), used by the Goodman correction.
// `cyclesPerSecond` fixes the high-cycle rate of the load (combustion parts
// tick at ~engine rotation frequency; bracket-type parts at a fixed broad-band
// order). Thermal endurance knockdown couples the sim's CHT/EGT faults to the
// part: `knockdown = tempSlope * max(0, reading[temperatureKey] - tempStep)`,
// capped at tempMaxKnock, reduces seMpa accordingly.
const PARTS = Object.freeze([
  Object.freeze({
    id: 'crankshaft',
    name: 'Crankshaft',
    materialId: 'steel4340',
    tboHours: 2000,
    stressKey: 'manifoldPressure', stressFactor: 2.8, stressBias: 82,
    meanKey: 'manifoldPressure', meanFactor: 3.0, meanBias: 82, groundMean: 40,
    kt: 1.6, notchSensitivity: 0.9,
    seMpa: 180, snB: -0.12, cyclesPerSecond: 40,
    temperatureKey: 'cht', tempStep: 120, tempSlope: 0.005, tempMaxKnock: 0.5,
  }),
  Object.freeze({
    id: 'connecting-rod',
    name: 'Connecting rod',
    materialId: 'steel4340',
    tboHours: 2000,
    stressKey: 'manifoldPressure', stressFactor: 4.2, stressBias: 82,
    meanKey: 'manifoldPressure', meanFactor: 3.5, meanBias: 82, groundMean: 25,
    kt: 1.8, notchSensitivity: 0.85,
    seMpa: 160, snB: -0.12, cyclesPerSecond: 38,
    temperatureKey: 'cht', tempStep: 120, tempSlope: 0.005, tempMaxKnock: 0.5,
  }),
  Object.freeze({
    id: 'piston-pin',
    name: 'Piston pin',
    materialId: 'steel8620',
    tboHours: 1500,
    stressKey: 'manifoldPressure', stressFactor: 3.6, stressBias: 82,
    meanKey: 'manifoldPressure', meanFactor: 3.0, meanBias: 82, groundMean: 20,
    kt: 2.0, notchSensitivity: 0.8,
    seMpa: 140, snB: -0.11, cyclesPerSecond: 38,
    temperatureKey: 'cht', tempStep: 120, tempSlope: 0.005, tempMaxKnock: 0.5,
  }),
  Object.freeze({
    id: 'exhaust-valve',
    name: 'Exhaust valve',
    materialId: 'steel8620',
    tboHours: 1500,
    stressKey: 'manifoldPressure', stressFactor: 3.9, stressBias: 82,
    meanKey: 'manifoldPressure', meanFactor: 3.0, meanBias: 82, groundMean: 15,
    kt: 1.7, notchSensitivity: 0.85,
    seMpa: 150, snB: -0.1, cyclesPerSecond: 19,
    temperatureKey: 'egt', tempStep: 700, tempSlope: 0.008, tempMaxKnock: 0.6,
  }),
  Object.freeze({
    id: 'alternator-bracket',
    name: 'Alternator bracket',
    materialId: 'alu7075t6',
    tboHours: 1000,
    stressKey: 'vibration', stressFactor: 40, stressBias: 1.0,
    meanKey: null, meanFactor: 0, meanBias: 0, groundMean: 0,
    kt: 2.2, notchSensitivity: 0.8,
    seMpa: 70, snB: -0.15, cyclesPerSecond: 60,
  }),
  Object.freeze({
    id: 'engine-mount',
    name: 'Engine mount',
    materialId: 'alu7075t6',
    tboHours: 1000,
    stressKey: 'vibration', stressFactor: 34, stressBias: 1.0,
    meanKey: null, meanFactor: 0, meanBias: 0, groundMean: 0,
    kt: 2.0, notchSensitivity: 0.8,
    seMpa: 70, snB: -0.15, cyclesPerSecond: 70,
  }),
]);

function materialFor(part) {
  return MATERIALS[part.materialId] || null;
}

// Notch factor: Kf = 1 + q*(Kt - 1).
function kfOf(part) {
  const q = Math.min(1, Math.max(0, part.notchSensitivity));
  return 1 + q * (Math.max(1, part.kt) - 1);
}

/**
 * Basquin curve parameters for a part.
 * @returns {{ a: number, b: number, se: number, uts: number, s1000: number }}
 */
function snParams(part) {
  const uts = materialFor(part) ? materialFor(part).utsMpa : 900;
  const b = part.snB || -0.12;
  const s1000 = 0.9 * uts;
  const a = s1000 / Math.pow(1000, b);
  return { a, b, se: Math.max(0, part.seMpa), uts, s1000 };
}

// Goodman-corrected fully-reversed equivalent amplitude. A compressive mean
// does not penalise life (Sm clamped at 0); tension approaching UTS is
// total loss.
function goodmanEquivalent(part, sa, meanStress) {
  const uts = snParams(part).uts;
  const sm = Math.max(0, Number.isFinite(meanStress) ? meanStress : 0);
  if (sm >= uts * 0.999) return Infinity;
  if (uts <= 0) return sa;
  return sa * (uts / (uts - sm));
}

// Thermal endurance knockdown (lower lives at elevated CHT/EGT).
function thermalKnockdown(part, reading = {}) {
  if (!part.temperatureKey) return 0;
  const t = reading[part.temperatureKey];
  if (typeof t !== 'number' || !Number.isFinite(t)) return 0;
  return clamp((t - part.tempStep) * part.tempSlope, 0, part.tempMaxKnock);
}

/**
 * Full cycles to failure at an alternating stress amplitude.
 * @returns {number} cycles (Infinity when below endurance)
 */
function cyclesToFailure(part, sa, meanStress = 0, reading = {}) {
  if (!(sa > 0)) return Infinity;
  const p = snParams(part);
  const se = p.se * (1 - thermalKnockdown(part, reading));
  const saEff = goodmanEquivalent(part, sa, meanStress);
  if (saEff === Infinity) return 0;
  if (saEff <= se) return Infinity;
  if (saEff <= 0) return Infinity;
  const nf = Math.pow(saEff / p.a, 1 / p.b);
  return Number.isFinite(nf) && nf > 0 ? nf : Infinity;
}

/**
 * Miner damage for a single reversed cycle at amplitude `sa` (with mean).
 * @returns {number} fraction of life consumed (0 below endurance, 1.0 instant)
 */
function damagePerCycle(part, sa, meanStress = 0, reading = {}) {
  if (!(sa > 0)) return 0;
  const nf = cyclesToFailure(part, sa, meanStress, reading);
  if (nf === Infinity) return 0;
  if (nf === 0) return 1;
  return 1 / nf;
}

function getPart(partId) {
  return PARTS.find((p) => p.id === partId) || null;
}

module.exports = {
  MATERIALS,
  PARTS,
  materialFor,
  kfOf,
  snParams,
  goodmanEquivalent,
  thermalKnockdown,
  cyclesToFailure,
  damagePerCycle,
  getPart,
};