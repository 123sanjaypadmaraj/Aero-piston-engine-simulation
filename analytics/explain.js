/**
 * explain.js
 * -----------------------------------------------------------------------
 * Offline, free explainability layer: turns anomalyDetection.js's exact
 * per-feature Mahalanobis contributions and healthIndex.js's rule flags
 * into a short structured "why" object with a plain-language narrative.
 * This is a complement/fallback to the Gemini-based narrative in
 * ai/analysisEngine.js — it works with zero network calls and zero cost,
 * so it can run every tick rather than being throttled.
 * -----------------------------------------------------------------------
 */

'use strict';

const SEVERITY_RANK = { critical: 3, warning: 2, watch: 1 };

const SENSOR_LABELS = {
  rpm: 'Engine speed', cht: 'Cylinder head temperature', egt: 'Exhaust gas temperature',
  oilPressure: 'Oil pressure', oilTemp: 'Oil temperature', fuelFlow: 'Fuel flow',
  vibration: 'Vibration', manifoldPressure: 'Manifold pressure', batteryVoltage: 'Battery voltage',
  'rpm+egt': 'Engine speed and exhaust gas temperature',
};

function labelFor(sensor) { return SENSOR_LABELS[sensor] || sensor; }

function categoryLabel(category) { return String(category).replace(/_/g, ' '); }

/**
 * @param {Object} input
 * @param {Array<{feature: string, contribution: number}>} [input.contributions]
 * @param {Array<{category: string, sensor: string, severity: string, evidence: string}>} [input.flags]
 * @returns {{ topContributors: Array<{sensor: string, contributionPct: number}>, narrative: string }}
 */
function explain({ contributions = [], flags = [] } = {}) {
  // drop malformed / non-finite contributions (NaN would poison the total and every percentage)
  contributions = (Array.isArray(contributions) ? contributions : [])
    .filter((c) => c && Number.isFinite(c.contribution));
  flags = Array.isArray(flags) ? flags.filter(Boolean) : [];
  const total = contributions.reduce((a, c) => a + Math.max(c.contribution, 0), 0) || 1;
  const topContributors = contributions
    .slice()
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .filter((c) => c.contribution > 0)
    .map((c) => ({ sensor: c.feature, contributionPct: Math.round((Math.max(c.contribution, 0) / total) * 100) }));

  const topFlag = flags.slice().sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0))[0];

  let narrative;
  if (topFlag && topContributors.length) {
    narrative = `${labelFor(topContributors[0].sensor)} is the leading driver of the current deviation `
      + `(${topContributors[0].contributionPct}% of the joint anomaly), consistent with ${categoryLabel(topFlag.category)}: ${topFlag.evidence}.`;
  } else if (topFlag) {
    narrative = `${categoryLabel(topFlag.category)} indicated by ${labelFor(topFlag.sensor)}: ${topFlag.evidence}.`;
  } else if (topContributors.length) {
    narrative = `${labelFor(topContributors[0].sensor)} accounts for ${topContributors[0].contributionPct}% of the current multivariate `
      + 'deviation; no individual sensor threshold has been crossed yet.';
  } else {
    narrative = 'Telemetry is within expected joint behavior; no significant anomaly detected.';
  }

  return { topContributors, narrative };
}

module.exports = { explain, labelFor, categoryLabel };
