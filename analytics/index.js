'use strict';

const { computeHealthIndex, classify, SENSOR_DEFS, TREND_CATEGORY_MAP } = require('./healthIndex');
const { MultivariateAnomalyDetector, DEFAULT_FEATURE_ORDER } = require('./anomalyDetection');
const { estimateRUL, deriveRulFeatures, MAX_RUL_HOURS } = require('./rulModel');
const { explain, labelFor, categoryLabel } = require('./explain');
const { recommend, CATEGORY_ACTION } = require('./maintenanceRecommendation');

module.exports = {
  computeHealthIndex, classify, SENSOR_DEFS, TREND_CATEGORY_MAP,
  MultivariateAnomalyDetector, DEFAULT_FEATURE_ORDER,
  estimateRUL, deriveRulFeatures, MAX_RUL_HOURS,
  explain, labelFor, categoryLabel,
  recommend, CATEGORY_ACTION,
};
