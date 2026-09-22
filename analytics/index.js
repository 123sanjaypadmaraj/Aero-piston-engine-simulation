'use strict';

const { computeHealthIndex, classify, SENSOR_DEFS, TREND_CATEGORY_MAP } = require('./healthIndex');
const { MultivariateAnomalyDetector, DEFAULT_FEATURE_ORDER } = require('./anomalyDetection');
const { IsolationForest, avgPathLength } = require('./isolationForest');
const { estimateRUL, deriveRulFeatures, MAX_RUL_HOURS } = require('./rulModel');
const { trainRulModel, predictRul, saveRulModel, emitRulModelModule, loadRulModel, RUL_MODEL_PATH, RUL_HARDCODED_PATH, HARDCODED_MODEL } = require('./rulRegressor');
const { forecastSensor, forecastEngine, hoursToHealthFloor } = require('./trendForecast');
const { shapAttribution } = require('./shap');
const { explain, labelFor, categoryLabel } = require('./explain');
const { recommend, CATEGORY_ACTION } = require('./maintenanceRecommendation');
const {
  MATERIALS, PARTS, kfOf, snParams, goodmanEquivalent,
  thermalKnockdown, cyclesToFailure, damagePerCycle, getPart, materialFor,
} = require('./materialDB');
const { rainflowCount, turningPoints, cycleHistogram } = require('./rainflow');
const {
  createFatigueState, partDutyStress, advanceFatigue, fatigueReport,
  missionFatigue, missionReport, monteCarloFatigue, partHoursToD1,
  partStatus, statusLabel, MAX_FATIGUE_HOURS, DEFAULT_SCATTER,
} = require('./fatigueRul');

module.exports = {
  computeHealthIndex, classify, SENSOR_DEFS, TREND_CATEGORY_MAP,
  MultivariateAnomalyDetector, DEFAULT_FEATURE_ORDER,
  IsolationForest, avgPathLength,
  estimateRUL, deriveRulFeatures, MAX_RUL_HOURS,
  trainRulModel, predictRul, saveRulModel, emitRulModelModule, loadRulModel,
  RUL_MODEL_PATH, RUL_HARDCODED_PATH, HARDCODED_MODEL,
  forecastSensor, forecastEngine, hoursToHealthFloor,
  shapAttribution,
  explain, labelFor, categoryLabel,
  recommend, CATEGORY_ACTION,
  MATERIALS, PARTS, kfOf, snParams, goodmanEquivalent, thermalKnockdown,
  cyclesToFailure, damagePerCycle, getPart, materialFor,
  rainflowCount, turningPoints, cycleHistogram,
  createFatigueState, partDutyStress, advanceFatigue, fatigueReport,
  missionFatigue, missionReport, monteCarloFatigue, partHoursToD1,
  partStatus, statusLabel, MAX_FATIGUE_HOURS, DEFAULT_SCATTER,
};
