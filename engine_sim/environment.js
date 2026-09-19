/**
 * ISA (International Standard Atmosphere) model, extended with a
 * configurable ambient-temperature offset for hot-weather scenarios.
 * Troposphere-only (valid to ~11000 m, well past any MALE UAV operating band).
 */

'use strict';

const SEA_LEVEL_TEMP_K = 288.15;
const SEA_LEVEL_PRESSURE_KPA = 101.325;
const SEA_LEVEL_DENSITY_KGM3 = 1.225;
const LAPSE_RATE_K_PER_M = 0.0065;
const GAS_CONST_AIR = 287.05;

const MAX_ALTITUDE_M = 11000; // top of the troposphere; the lapse-rate model is invalid above it
const MAX_TEMP_OFFSET_C = 60;

function isaAtmosphere(altitudeM, ambientTempOffsetC = 0) {
  // Clamp to the model's validity range: NaN / negative / stratospheric inputs
  // would otherwise yield NaN (negative base raised to a fractional power).
  const alt = Number.isFinite(altitudeM) ? Math.min(MAX_ALTITUDE_M, Math.max(0, altitudeM)) : 0;
  ambientTempOffsetC = Number.isFinite(ambientTempOffsetC)
    ? Math.min(MAX_TEMP_OFFSET_C, Math.max(-MAX_TEMP_OFFSET_C, ambientTempOffsetC))
    : 0;
  const tempK = SEA_LEVEL_TEMP_K - LAPSE_RATE_K_PER_M * alt + ambientTempOffsetC;
  const pressureKPa = SEA_LEVEL_PRESSURE_KPA * Math.pow(tempK / (SEA_LEVEL_TEMP_K + ambientTempOffsetC), 5.2561);
  const densityKgM3 = (pressureKPa * 1000) / (GAS_CONST_AIR * tempK);
  const densityRatio = densityKgM3 / SEA_LEVEL_DENSITY_KGM3;

  // Naturally-aspirated piston engines lose power roughly in proportion to
  // air density (Gagg-Farrar approximation), slightly gentler than linear.
  const powerFactor = Math.pow(densityRatio, 0.92);

  return {
    altitudeM: alt,
    tempC: tempK - 273.15,
    tempK,
    pressureKPa,
    densityKgM3,
    densityRatio,
    powerFactor,
  };
}

module.exports = { isaAtmosphere, SEA_LEVEL_PRESSURE_KPA, SEA_LEVEL_DENSITY_KGM3 };
