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

function isaAtmosphere(altitudeM, ambientTempOffsetC = 0) {
  const alt = Math.max(0, altitudeM);
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
