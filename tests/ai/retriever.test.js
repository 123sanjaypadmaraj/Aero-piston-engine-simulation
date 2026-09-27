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

// --- regression: a HEALTHY engine must never read as a multi-channel fault ---
// The classifier previously used raw truthiness, so a fully populated but
// all-'nominal' status map satisfied `all('rpm','fuelFlow','manifoldPressure')`
// and produced a false `accident` on a perfectly healthy engine. Only
// 'warning' and 'critical' may count as off-nominal.

test('regression: all-nominal populated status map = nominal, never accident', () => {
  const v = classifySignature({
    statuses: {
      rpm: 'nominal', fuelFlow: 'nominal', manifoldPressure: 'nominal',
      vibration: 'nominal', cht: 'nominal', egt: 'nominal', oilPressure: 'nominal',
    },
  });
  assert.equal(v.className, 'nominal', 'a healthy engine must not be classified by status presence alone');
  assert.equal(v.accidentScore, 0, 'all-nominal must never carry accident score');
  assert.equal(v.degradationScore, 0, 'all-nominal must not carry degradation score either');
  assert.deepEqual(v.patternIds, [], 'no combined pattern may match an all-nominal snapshot');
});

test('regression: the cooling look-alike stays degradation when channels are only partially off-nominal', () => {
  // rpm/fuel/MP are nominal here; only the thermal pair plus vibration drift.
  const v = classifySignature({
    statuses: { rpm: 'nominal', fuelFlow: 'nominal', manifoldPressure: 'nominal', cht: WARN, egt: WARN, vibration: WARN },
  });
  assert.equal(v.className, 'degradation');
  assert.equal(v.accidentScore, 0);
  assert.ok(v.patternIds.includes('pattern-cooling-vibration'));
});

test('regression: unknown/garbage status values are ignored, not treated as off-nominal', () => {
  const v = classifySignature({
    statuses: { rpm: '', fuelFlow: null, manifoldPressure: undefined, cht: 'unknown', egt: 'N/A' },
  });
  assert.equal(v.className, 'nominal', 'non-severity strings must not be read as faults');
  assert.equal(v.accidentScore, 0);
});

test('classifySignature is robust to null, non-object and missing-status snapshots', () => {
  for (const bad of [null, undefined, {}, 'nonsense', 42, []]) {
    const v = classifySignature(bad);
    assert.equal(v.className, 'nominal');
    assert.equal(v.accidentScore, 0);
    assert.equal(v.degradationScore, 0);
    assert.ok(Array.isArray(v.evidence) && v.evidence.length > 0, 'must still return evidence');
  }
  // status map present but not an object
  const odd = classifySignature({ statuses: 'not-an-object' });
  assert.equal(odd.className, 'nominal');
});

test('classifySignature takes no options argument (dead param removed)', () => {
  // If a second parameter is ever reintroduced it must be used, not ignored.
  assert.equal(classifySignature.length, 1, 'signature must be single-argument');
});
