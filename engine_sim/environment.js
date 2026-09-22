/**
 * ISA (International Standard Atmosphere) model, extended with a
 * configurable ambient-temperature offset (hot-weather scenarios) and a
 * humidity term that slightly derates air density at altitude.
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
const MAX_HUMIDITY_PCT = 100;
const MAX_WIND_KTS = 120;

// Water-vapour partial pressure lowers dry-air density by a small amount
// (humid air is lighter). The coefficient is a fitted approximation; the
// effect stays < ~2% so hot+humid conditions read as slightly worse power.
const HUMIDITY_DERATE_PER_PCT = -0.00016;

function isaAtmosphere(altitudeM, ambientTempOffsetC = 0, humidityPct = 0, windKts = 0) {
  // Clamp to the model's validity range: NaN / negative / stratospheric inputs
  // would otherwise yield NaN (negative base raised to a fractional power).
  const alt = Number.isFinite(altitudeM) ? Math.min(MAX_ALTITUDE_M, Math.max(0, altitudeM)) : 0;
  ambientTempOffsetC = Number.isFinite(ambientTempOffsetC)
    ? Math.min(MAX_TEMP_OFFSET_C, Math.max(-MAX_TEMP_OFFSET_C, ambientTempOffsetC))
    : 0;
  const hum = Number.isFinite(humidityPct)
    ? Math.min(MAX_HUMIDITY_PCT, Math.max(0, humidityPct))
    : 0;
  const wind = Number.isFinite(windKts)
    ? Math.min(MAX_WIND_KTS, Math.max(0, windKts))
    : 0;
  const tempK = SEA_LEVEL_TEMP_K - LAPSE_RATE_K_PER_M * alt + ambientTempOffsetC;
  const pressureKPa = SEA_LEVEL_PRESSURE_KPA * Math.pow(tempK / (SEA_LEVEL_TEMP_K + ambientTempOffsetC), 5.2561);
  const dryDensityKgM3 = (pressureKPa * 1000) / (GAS_CONST_AIR * tempK);
  const humidityFactor = 1 + HUMIDITY_DERATE_PER_PCT * hum;
  const densityKgM3 = dryDensityKgM3 * humidityFactor;
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
    humidityPct: hum,
    windKts: wind,
  };
}

module.exports = { isaAtmosphere, SEA_LEVEL_PRESSURE_KPA, SEA_LEVEL_DENSITY_KGM3 };
