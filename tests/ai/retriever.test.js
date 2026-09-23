/**
 * tests/ai/retriever.test.js
 * -----------------------------------------------------------------------
 * The combined-signature CLASS, tested in BOTH directions so the AI box's
 * most dangerous call — "is the current multi-channel drift an accident,
 * or just a degradation that LOOKS like one?" — is deterministic and
 * CI-gateable, not a property of whatever LLM happens to be hot right now.
 *
 * Two legs, mirroring docs/ACCIDENT_TAXONOMY.md and the two combined KB
 * docs (pattern-cooling-vibration, pattern-power-loss):
 *
 *   accident leg    — CHT/EGT/vibration all off-nominal TOGETHER with an
 *                     abrupt RPM+fuelFlow+manifoldPressure collapse. This
 *                     is the combined power-loss accident signature.
 *   look-alike leg  — CHT/EGT climbing slowly with a gradual vibration
 *                     rise (cooling/coking degradation). Multiple channels
 *                     ARE off-nominal at once, but they moved together
 *                     SLOWLY, so this must resolve to `degradation` and
 *                     must NEVER flip to `accident`. This is the exact
 *                     false-accident the class exists to kill.
 *
 * `classifySignature` is LLM-free (pure tag scoring over the same KB docs
 * the retriever surfaces), so these assertions hold on every run — no API
 * quota, no nondeterminism, no flake.
 * -----------------------------------------------------------------------
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySignature } = require('../../ai/retriever');

const CRIT = 'critical';
const WARN = 'warning';

test('look-alike leg: CHT+EGT climbing slowly WITH a gradual vibration rise = degradation, NOT an accident', () => {
  const v = classifySignature({ statuses: { cht: WARN, egt: WARN, vibration: WARN } });
  assert.equal(v.className, 'degradation');
  assert.equal(v.accidentScore, 0, 'a combined cooling/coking look-alike must never carry accident score');
  assert.ok(v.degradationScore > 0, 'look-alike must register degradation');
  assert.ok(v.patternIds.includes('pattern-cooling-vibration'), 'retriever must ground the KB cooling-coking pattern doc');
  assert.ok(!v.patternIds.includes('pattern-power-loss'), 'cooling look-alike must NOT pull the power-loss accident doc');
});

test('accident leg: CHT/EGT/vibration WITH a simultaneous RPM+fuelFlow+manifoldPressure collapse = accident', () => {
  const v = classifySignature({
    statuses: { rpm: CRIT, fuelFlow: CRIT, manifoldPressure: CRIT, vibration: CRIT, cht: WARN, egt: WARN },
  });
  assert.equal(v.className, 'accident');
  assert.ok(v.accidentScore > 0, 'combined power collapse must carry accident score');
  assert.ok(v.patternIds.includes('pattern-power-loss'), 'retriever must ground the power-loss accident doc');
});

test('isolated single-channel drift never escalates to accident', () => {
  const v = classifySignature({ statuses: { cht: WARN } });
  assert.equal(v.className, 'degradation');
  assert.equal(v.accidentScore, 0);

  const idle = classifySignature({ statuses: {} });
  assert.equal(idle.className, 'nominal');
  assert.equal(idle.accidentScore, 0);
});
