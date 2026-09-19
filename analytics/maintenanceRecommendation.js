/**
 * maintenanceRecommendation.js
 * -----------------------------------------------------------------------
 * Rule-driven maintenance advisory text generated from healthIndex.js flags
 * plus an RUL estimate (rulModel.js) — e.g. "vibration RMS trending +12%/10h
 * on cylinder 2 — inspect mounting/bearing within next 15 flight hours."
 * -----------------------------------------------------------------------
 */

'use strict';

const { clamp } = require('./mathUtils');
const { labelFor, categoryLabel } = require('./explain');

const SEVERITY_RANK = { critical: 3, warning: 2, watch: 1 };

const CATEGORY_ACTION = {
  misfire: 'Investigate ignition/injection timing for a possible misfire',
  injector_abnormality: 'Inspect fuel injector for abnormal flow/spray pattern',
  cooling_coking_degradation: 'Inspect cooling fins/ducting and check for exhaust/intake coking',
  lubrication_issues: 'Inspect oil system (pump, filter, lines) for a developing lubrication fault',
  sensor_drift_failure: 'Inspect/recalibrate the sensor — reading looks like drift or a stuck transducer, not a physical fault',
  combustion_instability: 'Inspect fuel/air mixture control and ignition timing for combustion instability',
  overheating_trend: 'Inspect cooling system and reduce power margin — sustained overheating trend',
  abnormal_vibration_pattern: 'Inspect engine mounting/bearings for a developing vibration/imbalance fault',
};

/**
 * @param {Object} input
 * @param {Array<{category: string, sensor: string, severity: string, evidence: string}>} input.flags
 * @param {{ rul: number }} [input.rul]
 * @returns {string|null}
 */
function recommend({ flags = [], rul } = {}) {
  if (!Array.isArray(flags) || !flags.length) return null;
  const top = flags.filter(Boolean).sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0))[0];

  const action = CATEGORY_ACTION[top.category] || `Investigate ${categoryLabel(top.category)}`;
  // Tighter inspection window for a more severe flag or a shorter RUL runway.
  const severityWindow = top.severity === 'critical' ? 3 : top.severity === 'warning' ? 10 : 25;
  // rul.rul === 0 must give the *tightest* window (previously a falsy 0 fell
  // through to the looser severity window).
  const rulWindow = rul && Number.isFinite(rul.rul) ? Math.round(Math.max(0, rul.rul) * 0.15) : 15;
  const windowHours = clamp(Math.min(rulWindow, severityWindow), 1, 60);

  return `${action} (${labelFor(top.sensor)}: ${top.evidence}) — inspect within the next ${windowHours} flight hours.`;
}

module.exports = { recommend, CATEGORY_ACTION };
