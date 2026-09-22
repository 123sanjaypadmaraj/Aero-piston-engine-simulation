'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MATERIALS, PARTS, getPart, kfOf, snParams, cyclesToFailure,
  damagePerCycle, goodmanEquivalent, thermalKnockdown,
} = require('../../analytics/materialDB');
const { rainflowCount, turningPoints, cycleHistogram } = require('../../analytics/rainflow');
const {
  createFatigueState, advanceFatigue, fatigueReport, missionFatigue,
  missionReport, monteCarloFatigue, DEFAULT_SCATTER,
} = require('../../analytics/fatigueRul');
const { DigitalTwinFleet } = require('../../simulator');

const bracket = getPart('alternator-bracket');
const rod = getPart('connecting-rod');
const crank = getPart('crankshaft');

// ---- materialDB -----------------------------------------------------------

test('PARTS/MATERIALS are deterministic, frozen catalogs', () => {
  assert.ok(Array.isArray(PARTS) && PARTS.length >= 5);
  assert.ok(MATERIALS.steel4340 && MATERIALS.steel8620 && MATERIALS.alu7075t6);
  assert.throws(() => { PARTS.push({}); }, TypeError, 'frozen catalog');
  assert.throws(() => { MATERIALS.steel4340.utsMpa = 1; }, TypeError, 'frozen material');
  for (const p of PARTS) {
    assert.ok(p.id && p.tboHours > 0 && p.seMpa > 0 && p.snB < 0);
  }
});

test('kfOf applies the notch-sensitivity rule 1 + q*(Kt-1)', () => {
  assert.ok(Math.abs(kfOf(rod) - (1 + 0.85 * (1.8 - 1))) < 1e-9);
  assert.ok(kfOf(bracket) > 1 && kfOf(bracket) < bracket.kt);
});

test('snParams anchor the Basquin curve at 0.9*Sut for 1e3 cycles', () => {
  const p = snParams(rod);
  assert.equal(p.s1000, 0.9 * p.uts);
  assert.ok(Math.abs(p.a * Math.pow(1000, p.b) - p.s1000) < 1e-6);
  assert.ok(p.b < 0);
});

test('cyclesToFailure is infinite below endurance, finite and decreasing above', () => {
  const part = rod; // se 160 MPa effectively (no thermal reading)
  const low = cyclesToFailure(part, 50);
  assert.equal(low, Infinity);
  const a = cyclesToFailure(part, 200);
  assert.ok(a > 0 && Number.isFinite(a));
  const b = cyclesToFailure(part, 400);
  assert.ok(b < a, `Nf(400)=${b} should be < Nf(200)=${a}`);
});

test('damagePerCycle is 0 below endurance and climbs monotonically above it', () => {
  assert.equal(damagePerCycle(bracket, 20), 0);
  const d1 = damagePerCycle(bracket, 120);
  const d2 = damagePerCycle(bracket, 240);
  assert.ok(d1 > 0 && d2 > d1);
  assert.ok(d1 < 1 && d2 < 1);
});

test('Goodman correction shortens life under a tensile mean stress', () => {
  const sa = 200;
  const d0 = damagePerCycle(rod, sa, 0);
  const dT = damagePerCycle(rod, sa, 300);
  assert.ok(dT > d0, 'tensile mean must consume more damage per cycle');
  const eq = goodmanEquivalent(rod, sa, 300);
  assert.ok(eq > sa);
});

test('thermal knockdown lowers endurance at elevated CHT/EGT', () => {
  assert.equal(thermalKnockdown(rod, { cht: 90 }), 0);
  const k = thermalKnockdown(rod, { cht: 200 });
  assert.ok(k > 0 && k <= rod.tempMaxKnock);
  const dCold = damagePerCycle(rod, 260, 0, { cht: 90 });
  const dHot = damagePerCycle(rod, 260, 0, { cht: 200 });
  assert.ok(dHot >= dCold, 'hot part must fatigue faster at the same stress');
});

// ---- rainflow -------------------------------------------------------------

test('turningPoints compresses flat and monotonic runs to extrema', () => {
  assert.deepEqual(turningPoints([5, 5, 5]), [5]);
  assert.deepEqual(turningPoints([0, 1, 2, 3]), [0, 3]);
  assert.deepEqual(turningPoints([0, 2, 1, 3, 2]), [0, 2, 1, 3, 2]);
});

test('rainflow counts a repeated square wave as full cycles plus residual', () => {
  const r = rainflowCount([0, 2, 0, 2, 0, 2, 0]);
  assert.ok(r.cycles.length >= 2);
  for (const c of r.cycles) {
    assert.equal(c.amp, 1);
    assert.equal(c.range, 2);
    assert.equal(c.count, 1);
    assert.equal(c.mean, 1);
  }
});

test('rainflow of a monotonic ramp yields only a closing half cycle', () => {
  const r = rainflowCount([0, 1, 2, 3]);
  assert.equal(r.cycles.length, 0);
  assert.ok(r.halfCycles.length >= 1);
  assert.equal(r.halfCycles[0].amp, 1.5);
});

test('rainflow is deterministic and produces amplitude histograms', () => {
  const series = [0, 3, 1, 4, 1, 5, 0];
  const a = rainflowCount(series);
  const b = rainflowCount(series);
  assert.deepEqual(a, b);
  const hist = cycleHistogram(a.cycles, { bins: 8 });
  assert.ok(hist.every((h) => h.count >= 0 && h.center > 0));
  assert.equal(hist.reduce((s, h) => s + h.count, 0), a.cycles.length);
});

// ---- duty-cycle accumulation + report -------------------------------------

test('advanceFatigue is deterministic and damage increases with vibration', () => {
  const s1 = createFatigueState();
  const s2 = createFatigueState();
  const nominal = { vibration: 1.4, manifoldPressure: 98, cht: 100, egt: 720 };
  const harsh = { vibration: 4.0, manifoldPressure: 98, cht: 100, egt: 720 };
  advanceFatigue(s1, nominal, { dtSeconds: 2, hoursFlown: 300 });
  advanceFatigue(s2, nominal, { dtSeconds: 2, hoursFlown: 300 });
  assert.deepEqual(s1, s2, 'identical input must produce identical state');
  const stNominal = createFatigueState();
  const stHarsh = createFatigueState();
  for (let i = 0; i < 50; i++) {
    advanceFatigue(stNominal, nominal, { dtSeconds: 2, hoursFlown: 300 + i * 2 / 3600 });
    advanceFatigue(stHarsh, harsh, { dtSeconds: 2, hoursFlown: 300 + i * 2 / 3600 });
  }
  const dNom = stNominal.parts[bracket.id].damage;
  const dHar = stHarsh.parts[bracket.id].damage;
  assert.ok(dHar > dNom, 'bracket must accrue more damage under heavy vibration');
  assert.ok(stHarsh.parts[crank.id].damage >= stNominal.parts[crank.id].damage);
});

test('fatigueReport: design-limited life when no damage has accrued', () => {
  const state = createFatigueState();
  state.consumedHours = 500;
  const r = fatigueReport(state, {});
  assert.equal(r.dominantPart, 'alternator-bracket'); // lowest TBO -> first to hit limit
  for (const p of r.parts) {
    assert.ok(p.hoursToD1 > 0);
    assert.equal(p.governedBy, 'design');
    assert.equal(p.status, 'ok');
  }
  const minDesign = Math.min(...PARTS.map((p) => p.tboHours)) - 500;
  assert.equal(r.rulHours, minDesign);
  assert.ok(r.confidence.low <= r.confidence.high);
});

test('fatigueReport: fatigue damage pulls hours-to-D1 below the TBO budget', () => {
  const state = createFatigueState();
  state.consumedHours = 500;
  const harsh = { vibration: 4.0, manifoldPressure: 100, cht: 100, egt: 720 };
  for (let i = 0; i < 4000; i++) advanceFatigue(state, harsh, { dtSeconds: 2, hoursFlown: 500 });
  const r = fatigueReport(state, {});
  const row = r.parts.find((p) => p.id === bracket.id);
  assert.ok(row.damage > 0);
  assert.equal(row.governedBy, 'fatigue');
  assert.ok(row.hoursToD1 < (bracket.tboHours - 500));
  assert.ok(['watch', 'critical-fatigue'].includes(r.status));
});

test('missionFatigue runs rainflow + Miner and is deterministic', () => {
  const readings = [];
  for (let i = 0; i < 1200; i++) {
    readings.push({ vibration: i % 40 === 0 ? 6.0 : 0.6, manifoldPressure: 100, cht: 100, egt: 720 });
  }
  const a = missionFatigue(readings, bracket, { dtSeconds: 60 });
  const b = missionFatigue(readings, bracket, { dtSeconds: 60 });
  assert.deepEqual(a, b);
  assert.ok(a.cyclesCount >= 1);
  assert.ok(a.histogram.length >= 1);
  assert.ok(a.damage > 0, 'mission with vibration excursions must consume damage');
  assert.ok(a.hoursToD1 <= a.tboHours);
  assert.ok(['ok', 'watch', 'critical-fatigue', 'over-tbo'].includes(a.status));
});

test('missionReport aggregates parts and is deterministic', () => {
  const readings = [];
  for (let i = 0; i < 120; i++) {
    readings.push({ vibration: i % 20 === 0 ? 6.0 : 0.6, manifoldPressure: 100, cht: 100, egt: 720 });
  }
  const a = missionReport(readings, [bracket, rod], { dtSeconds: 60 });
  const b = missionReport(readings, [bracket, rod], { dtSeconds: 60 });
  assert.deepEqual(a, b);
  assert.equal(a.parts.length, 2);
  assert.equal(a.dominantPart, 'alternator-bracket'); // lowest TBO / most stressed
  assert.ok(a.parts.every((p) => Number.isFinite(p.hoursToD1)));
  assert.equal(a.rulHours, Math.min(...a.parts.map((p) => p.hoursToD1)));
  assert.ok(['ok', 'watch', 'critical-fatigue', 'over-tbo'].includes(a.status));
});

// ---- Monte Carlo (seeded, deterministic) ----------------------------------

test('monteCarloFatigue: same seed and state reproduce the same band', () => {
  const state = createFatigueState();
  state.consumedHours = 400;
  const a = monteCarloFatigue(state, { seed: 'mc-test', draws: 2000, scatter: 0.1 });
  const b = monteCarloFatigue(state, { seed: 'mc-test', draws: 2000, scatter: 0.1 });
  assert.deepEqual(a, b);
  assert.ok(a.p05 <= a.p50 && a.p50 <= a.p95);
  assert.ok(a.draws === 2000);
});

test('monteCarloFatigue: wider scatter widens the band, median stays stable', () => {
  const state = createFatigueState();
  state.consumedHours = 400;
  const narrow = monteCarloFatigue(state, { seed: 'm', draws: 3000, scatter: 0.05 });
  const wide = monteCarloFatigue(state, { seed: 'm', draws: 3000, scatter: 0.4 });
  assert.ok((wide.p95 - wide.p05) > (narrow.p95 - narrow.p05));
  assert.ok(Math.abs(wide.p50 - narrow.p50) / Math.max(1, narrow.p50) < 0.1);
});

test('default scatter constant is a sane, finite log-normal sigma', () => {
  assert.ok(DEFAULT_SCATTER > 0 && DEFAULT_SCATTER < 1);
});

// ---- integration with the live simulator fleet ----------------------------

test('EngineTwin exposes a deterministic fatigue report in analytics', () => {
  const fleetA = new DigitalTwinFleet({ seed: 777 });
  const fleetB = new DigitalTwinFleet({ seed: 777 });
  let snapA, snapB;
  for (let i = 0; i < 30; i++) {
    snapA = fleetA.step();
    snapB = fleetB.step();
  }
  const a = snapA.engines[0].analytics.fatigue;
  const b = snapB.engines[0].analytics.fatigue;
  assert.ok(a && typeof a.rulHours === 'number' && Number.isFinite(a.rulHours));
  assert.ok(Array.isArray(a.parts) && a.parts.length === PARTS.length);
  assert.deepEqual(a, b, 'same seed must reproduce the same fatigue report');
});

test('EngineTwin: sustained vibration fault consumes bracket fatigue life', () => {
  const clean = new DigitalTwinFleet({ seed: 2024 });
  const faulted = new DigitalTwinFleet({ seed: 2024 });
  faulted.engines[0].forceFault('vibration', 220);
  let snapC, snapF;
  for (let i = 0; i < 220; i++) { snapC = clean.step(); snapF = faulted.step(); }
  const c = snapC.engines[0].analytics.fatigue;
  const f = snapF.engines[0].analytics.fatigue;
  const bracketClean = c.parts.find((p) => p.id === 'alternator-bracket');
  const bracketFault = f.parts.find((p) => p.id === 'alternator-bracket');
  assert.ok(bracketFault.damage > bracketClean.damage, 'faulted engine must accrue more bracket damage');
  assert.ok(bracketFault.hoursToD1 < bracketClean.hoursToD1, 'fault shortens fatigue life');
});