/**
 * tests/frontend/missionlab.test.js
 * ---------------------------------------------------------------------------
 * Tests for the MISSION LAB front end (public/js/missionlab.js).
 *
 * There is no browser and no jsdom in this project's devDependencies, so the
 * module is loaded inside a `node:vm` context behind a minimal DOM stub. The
 * stub deliberately reports `readyState === 'loading'` and records but never
 * fires DOMContentLoaded, so `init()` never runs: these tests exercise the pure
 * logic (the replay signature mirror) and the static contract with
 * public/index.html without any network or timer involvement.
 *
 * The static-contract test is the important one. MISSION LAB is additive and
 * depends on ~55 element ids existing in index.html; a typo in any of them fails
 * silently in a browser (the panel just renders empty), so it is asserted here
 * instead. The id-prefix test enforces the isolation rule that no id belonging
 * to the existing dashboard is ever touched from this module.
 * ---------------------------------------------------------------------------
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const LAB_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'missionlab.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** Minimal element stub: only what the module touches at load time. */
function stubElement() {
  const node = {
    id: '', value: '', textContent: '', hidden: false, disabled: false,
    dataset: {}, style: {}, className: '', min: '', max: '', step: '',
    children: [], childElementCount: 0, firstChild: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    checked: false, files: [],
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return node;
}

/** Load missionlab.js in a sandbox and return its exported MissionLab object. */
function loadMissionLab() {
  const listeners = [];
  const sandbox = {
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    fetch: () => Promise.reject(new Error('fetch must not run in these tests')),
    document: {
      readyState: 'loading',
      getElementById: (id) => (id === 'missionLab' ? stubElement() : null),
      createElement: () => stubElement(),
      addEventListener: (evt, fn) => listeners.push([evt, fn]),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LAB_SRC, sandbox, { filename: 'missionlab.js' });

  assert.ok(sandbox.MissionLab, 'module must export window.MissionLab');
  assert.equal(listeners.length, 1, 'module must register exactly one DOMContentLoaded listener');
  assert.equal(listeners[0][0], 'DOMContentLoaded');
  return { lab: sandbox.MissionLab, sandbox };
}

/** Values produced inside the vm context belong to another realm, so a plain
 *  deepEqual against a host-realm literal fails on prototype identity.
 *  Re-materialise them as host values before comparing. */
function host(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Build a replay frame in the exact shape missionreplay/replay.js emits. */
function frame({ phase = 'cruise', cht, egt, oilTemp, vibration, oilPressure, rpm, fuelFlow, flags = [] }) {
  return {
    state: {
      t_s: 1000,
      phase,
      thermal: { cht_c: cht, egt_c: egt, oil_temp_c: oilTemp },
      mechanical: { rpm, vibration_mm_s: vibration, oil_pressure_kpa: oilPressure },
      fuel: { fuel_flow_lph: fuelFlow, mixture_ratio: 13.9, fuel_remaining_l: 250 },
      flight: { altitude_m: 3000, airspeed_ms: 95, throttle_pct: 70 },
      fault_flags: flags,
      anomaly: { tier: flags.length ? 'active' : 'nominal', active: flags, precursor: [] },
    },
  };
}

const NOMINAL_CRUISE = frame({ cht: 120, egt: 780, oilTemp: 95, vibration: 1.5, oilPressure: 380, rpm: 2400, fuelFlow: 18 });

test('MISSION LAB exposes its API and is inert until the DOM is ready', () => {
  const { lab } = loadMissionLab();
  for (const fn of ['classifyFrame', 'replayStatuses', 'control', 'play', 'pause', 'seekTo',
    'loadMissions', 'generateMission', 'selectMission', 'refreshCan', 'refreshStatus', 'refreshAiVerdict']) {
    assert.equal(typeof lab[fn], 'function', `${fn} must be exported`);
  }
  assert.equal(lab.FAULT_TYPES.length, 20, 'all twenty fault types must be offered');
  assert.deepEqual(host(lab.SEVERITIES), ['low', 'moderate', 'severe', 'critical']);
  assert.equal(Object.keys(lab.PRESETS).length, 2);
});

test('a healthy cruise frame is nominal', () => {
  const { lab } = loadMissionLab();
  const v = lab.classifyFrame(NOMINAL_CRUISE);
  assert.equal(v.className, 'nominal');
  assert.deepEqual(host(v.offKeys), [], 'a healthy frame must report no off-nominal channels');
  assert.equal(v.accidentScore, 0);
  assert.equal(v.degradationScore, 0);
});

test('the look-alike case (thermal drift with healthy power) is degradation, never accident', () => {
  const { lab } = loadMissionLab();
  // CHT critical + EGT warning + vibration warning, but RPM and fuel flow fine:
  // this is the exact false-accident the KB doc says must not happen.
  const v = lab.classifyFrame(frame({ cht: 250, egt: 890, oilTemp: 120, vibration: 6, oilPressure: 360, rpm: 2400, fuelFlow: 18 }));
  assert.equal(v.className, 'degradation');
  assert.ok(v.patternIds.includes('pattern-cooling-vibration'));
  assert.equal(v.accidentScore, 0, 'a slow thermal drift must never score an accident');
});

test('the accident case (rpm + fuel flow collapsing) is accident', () => {
  const { lab } = loadMissionLab();
  const v = lab.classifyFrame(frame({ cht: 250, egt: 890, oilTemp: 120, vibration: 6, oilPressure: 360, rpm: 700, fuelFlow: 0, flags: ['FLT-0001'] }));
  assert.equal(v.className, 'accident');
  assert.ok(v.patternIds.includes('pattern-power-loss'));
  assert.ok(v.accidentScore > 0);
});

test('a single drifting channel is degradation, not accident', () => {
  const { lab } = loadMissionLab();
  const v = lab.classifyFrame(frame({ cht: 120, egt: 780, oilTemp: 95, vibration: 6, oilPressure: 380, rpm: 2400, fuelFlow: 18 }));
  assert.equal(v.className, 'degradation');
  assert.equal(v.accidentScore, 0);
});

test('rpm is judged against the phase band, so a healthy taxi frame is not a stall', () => {
  const { lab } = loadMissionLab();
  // Verbatim generator output at t=10s of a real mission (missionreplay/generator.js):
  // rpm 1111, oil pressure 361.3, vibration 0.99, cht 94.1, egt 594.1, oil temp 46.5.
  const taxi = frame({ phase: 'taxi', cht: 94.1, egt: 594.1, oilTemp: 46.5, vibration: 0.99, oilPressure: 361.3, rpm: 1111, fuelFlow: 6.86 });
  const statuses = lab.replayStatuses(taxi);
  assert.equal(statuses.rpm, 'nominal', 'taxi idle RPM must not read as critical');
  assert.equal(lab.classifyFrame(taxi).className, 'nominal', 'a healthy taxi frame must be nominal');

  // The same reading judged against the cruise band would be a stall, which is
  // exactly why the band has to be phase-relative rather than absolute.
  const mislabelled = frame({ phase: 'cruise', cht: 94.1, egt: 594.1, oilTemp: 46.5, vibration: 0.99, oilPressure: 361.3, rpm: 1111, fuelFlow: 6.86 });
  assert.equal(lab.replayStatuses(mislabelled).rpm, 'critical', '1111 rpm in cruise IS a stall');
});

test('a replay frame has no manifold-pressure channel, so the accident leg needs rpm+fuel flow', () => {
  const { lab } = loadMissionLab();
  const statuses = lab.replayStatuses(NOMINAL_CRUISE);
  assert.equal(statuses.manifoldPressure, null, 'replay frames carry no manifold pressure');
  assert.ok(!('manifold_pressure_kpa' in NOMINAL_CRUISE.state.flight));
});

test('missing, null and garbage frames degrade to nominal instead of throwing or false-alarming', () => {
  const { lab } = loadMissionLab();
  for (const bad of [null, undefined, {}, { state: null }, { state: { thermal: null, mechanical: null, fuel: null } },
    { state: { thermal: { cht_c: 'hot' }, mechanical: { rpm: null }, fuel: { fuel_flow_lph: undefined } } }]) {
    const v = lab.classifyFrame(bad);
    assert.equal(v.className, 'nominal', `garbage frame must be nominal: ${JSON.stringify(bad)}`);
  }
});

test('every preset actually reaches the generator — a preset cannot silently inject nothing', () => {
  // Regression: the presets were written with the server's `onset_s`/`duration_s`
  // keys while the fault rows read `onset`/`duration`, so every preset generated a
  // completely CLEAN mission while the form showed three fault rows.
  const { lab } = loadMissionLab();
  for (const [name, preset] of Object.entries(host(lab.PRESETS))) {
    const wire = lab.collectFaults(preset.faults, preset.duration);
    assert.equal(wire.length, preset.faults.length,
      `preset "${name}" dropped faults: ${JSON.stringify(wire)}`);
    for (const f of wire) {
      assert.equal(typeof f.onset_s, 'number', `preset "${name}" must send a numeric onset_s`);
      assert.ok(Number.isFinite(f.onset_s) && f.onset_s >= 0 && f.onset_s < preset.duration,
        `preset "${name}" onset ${f.onset_s} is outside the mission and could never fire`);
      assert.ok(f.severity, `preset "${name}" fault ${f.type} must carry a severity`);
    }
  }
});

test('collectFaults normalises both field spellings and drops unsamplable onsets', () => {
  const { lab } = loadMissionLab();
  // form spelling and server spelling both work
  assert.deepEqual(host(lab.collectFaults([{ type: 'overheating', onset: 10, duration: 20, severity: 'low' }], 3600)),
    [{ type: 'overheating', onset_s: 10, duration_s: 20, severity: 'low' }]);
  assert.deepEqual(host(lab.collectFaults([{ type: 'misfire', onset_s: 30, duration_s: 40, severity: 'low' }], 3600)),
    [{ type: 'misfire', onset_s: 30, duration_s: 40, severity: 'low' }]);
  // omitted duration is omitted on the wire rather than sent as null
  assert.deepEqual(host(lab.collectFaults([{ type: 'misfire', onset: 5 }], 3600)), [{ type: 'misfire', onset_s: 5 }]);
  // onsets outside the mission, unnamed and unparsable rows are dropped
  assert.deepEqual(host(lab.collectFaults([
    { type: 'misfire', onset: 5000 }, { onset: 10 }, { type: 'misfire', onset: 'soon' },
  ], 3600)), []);
});

test('the two presets are asymmetric and their labels match what replay can show', () => {
  const { lab } = loadMissionLab();
  const lookalike = lab.PRESETS.lookalike.faults.map((f) => f.type);
  const cascade = lab.PRESETS.cascade.faults.map((f) => f.type);
  assert.ok(!lookalike.includes('fuel_starvation'), 'the look-alike preset must not collapse power');
  assert.ok(cascade.includes('fuel_starvation'), 'the cascade preset must collapse fuel flow');
  assert.match(lab.PRESETS.lookalike.hint, /DEGRADATION/);
  // The cascade preset must NOT claim an accident it cannot produce on replay.
  assert.match(lab.PRESETS.cascade.hint, /NOT reachable/i);
  assert.doesNotMatch(lab.PRESETS.cascade.hint, /must classify ACCIDENT/);
});

test('accident class is structurally unreachable from replay data, and the module says so', () => {
  const { lab } = loadMissionLab();
  // No manifold-pressure channel in a replay frame ...
  assert.equal(lab.replayStatuses(NOMINAL_CRUISE).manifoldPressure, null);
  // ... and the accident leg needs rpm AND fuel flow, so it needs an rpm collapse.
  const rpmCollapsed = lab.classifyFrame(frame({ cht: 120, egt: 780, oilTemp: 95, vibration: 1.5, oilPressure: 380, rpm: 200, fuelFlow: 0 }));
  assert.equal(rpmCollapsed.className, 'accident', 'rpm + fuel flow collapse must still classify as accident');
  // Fuel starvation alone (the only replay fault that moves the power side) is
  // NOT enough, because rpm stays on its phase band.
  const fuelOnly = lab.classifyFrame(frame({ cht: 120, egt: 780, oilTemp: 95, vibration: 1.5, oilPressure: 380, rpm: 2400, fuelFlow: 0 }));
  assert.equal(fuelOnly.className, 'degradation');
  assert.equal(fuelOnly.accidentScore, 0);
});

// ---------------------------------------------------------------------------
// End-to-end against real generated mission data
// ---------------------------------------------------------------------------
// The two claims MISSION LAB makes in front of a judge are (a) a look-alike
// thermal/vibration drift must NEVER be labelled an accident and (b) a genuine
// power collapse must be. Both are asserted here against missions produced by
// the real generator and the real fault library, not against hand-written
// frames, so a change to either the generator's physics or the UI's bands that
// breaks the claim fails the build.
// ---------------------------------------------------------------------------

const mr = require('../../missionreplay');

const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ml-lab-'));

// Condensed schedule (all 7 phases) so generation stays fast.
const SCHEDULE = [
  { phase: 'taxi', start_s: 0, end_s: 60 },
  { phase: 'takeoff', start_s: 60, end_s: 100 },
  { phase: 'climb', start_s: 100, end_s: 400 },
  { phase: 'cruise', start_s: 400, end_s: 1200 },
  { phase: 'loiter', start_s: 1200, end_s: 1500 },
  { phase: 'descent', start_s: 1500, end_s: 1600 },
  { phase: 'landing', start_s: 1600, end_s: 1700 },
];

/** Generate a mission, load it back, and hand every 1 Hz frame to `visit`. */
function walkMission(missionId, faults, visit) {
  mr.generator.generateMission({ missionId, outDir: TMP, duration: 1700, sampleRateHz: 1, seed: 11, phases: SCHEDULE, faults });
  const record = mr.loader.loadMission(path.join(TMP, missionId));
  const player = new mr.replay.MissionReplay(record);
  for (let t = 0; t <= 1700; t += 1) visit({ state: player.stateAt(t) }, t, record);
  return record;
}

test('a real look-alike mission is never labelled an accident', () => {
  const { lab } = loadMissionLab();
  const counts = { nominal: 0, degradation: 0, accident: 0 };
  let sawInjectedFault = false;

  walkMission('lookalike', [
    { type: 'overheating', onset_s: 420, duration_s: 300, severity: 'moderate' },
    { type: 'vibration_anomaly', onset_s: 480, duration_s: 260, severity: 'moderate' },
  ], (frame, t) => {
    const v = lab.classifyFrame(frame);
    counts[v.className] += 1;
    if (v.className === 'accident') {
      assert.fail(`accident at t=${t}s: off-nominal ${v.offKeys.join(',')} (a slow thermal drift must not reach accident)`);
    }
    if ((frame.state.fault_flags || []).length > 0) sawInjectedFault = true;
  });

  assert.ok(sawInjectedFault, 'the look-alike mission must actually inject faults');
  assert.ok(counts.degradation > 0, 'the look-alike drift must be detected as degradation at least once');
  assert.ok(counts.accident === 0, 'zero accidents allowed for the look-alike mission');
});

test('a real combined cascade is detected as degradation and never as an accident', () => {
  const { lab } = loadMissionLab();
  const counts = { nominal: 0, degradation: 0, accident: 0 };

  walkMission('cascade', [
    { type: 'overheating', onset_s: 420, duration_s: 240, severity: 'critical' },
    { type: 'vibration_anomaly', onset_s: 620, duration_s: 200, severity: 'severe' },
    { type: 'fuel_starvation', onset_s: 700, duration_s: 200, severity: 'critical' },
  ], (frame, t) => {
    const v = lab.classifyFrame(frame);
    counts[v.className] += 1;
    if (v.className === 'accident') {
      assert.fail(`accident at t=${t}s: off-nominal ${v.offKeys.join(',')} — no replay fault type moves RPM, so this is unreachable`);
    }
  });

  assert.ok(counts.degradation > 0, `the cascade must be detected, got ${JSON.stringify(counts)}`);
  assert.equal(counts.accident, 0, 'the cascade may not claim an accident it cannot produce');
});

test('the live fleet CAN reach accident-class, which is why that demo lives there', () => {
  // The live simulator's fuel-starvation fault drives fuelFlow + rpm +
  // manifold pressure together, so classifySignature raises the accident leg on
  // real engine telemetry. This is the path the AI box card reports.
  const { classifySignature } = require('../../ai/retriever');
  const verdict = classifySignature({
    statuses: {
      rpm: 'critical', fuelFlow: 'critical', manifoldPressure: 'critical',
      vibration: 'critical', cht: 'warning', egt: 'warning',
    },
  });
  assert.equal(verdict.className, 'accident');
  assert.ok(verdict.patternIds.includes('pattern-power-loss'));
  assert.ok(verdict.evidence.length > 0, 'the verdict must carry its rationale for the LLM');
});

test('a real clean mission stays nominal for its whole flight', () => {
  const { lab } = loadMissionLab();
  const wrong = [];
  walkMission('clean', [], (frame, t) => {
    const v = lab.classifyFrame(frame);
    if (v.className !== 'nominal') wrong.push(`t=${t}s ${v.className} (${v.offKeys.join(',')})`);
  });
  assert.deepEqual(wrong, [], 'an unfaulted mission must never leave nominal');
});

// ---------------------------------------------------------------------------
// Regressions for real server-contract bugs found during live testing
// ---------------------------------------------------------------------------
test('step-back never sends a negative step control, which the server rejects', () => {
  // server.js validates control values in [1, 10000]; `step: -1` returns HTTP 400.
  // Stepping back must therefore be a seek to one sample earlier.
  assert.doesNotMatch(LAB_SRC, /control\('step',\s*-/, 'MISSION LAB must not send a negative step control');
  assert.match(LAB_SRC, /function stepBack\(\)/);
  assert.match(LAB_SRC, /on\('mlStepBack',\s*'click',\s*\(\)\s*=>\s*stepBack\(\)\)/);
});

test('the clock and scrubber read the resolved instant, not a top-level t_s', () => {
  // `mission-replay-frame` socket payloads have no top-level t_s — only
  // state.t_s. Reading snapshot.t_s directly rendered "undefined".
  assert.match(LAB_SRC, /setText\(el\('mlClock'\), `\$\{fmtTime\(tNow\)\}/);
  assert.doesNotMatch(LAB_SRC, /fmtTime\(snapshot\.t_s\)/);
  assert.doesNotMatch(LAB_SRC, /scrub\.value = String\(snapshot\.t_s\)/);
});

// ---------------------------------------------------------------------------
// Static contract with index.html
// ---------------------------------------------------------------------------
/** Every id the module looks up, including the templated speed buttons. */
function referencedIds() {
  const ids = new Set();
  for (const re of [
    /\bel\('([A-Za-z0-9_-]+)'\)/g,
    // `on(` but not `socket.on(` — the latter names socket events, not elements.
    /(?<![.\w])on\('([A-Za-z0-9_-]+)',/g,
    /getElementById\('([A-Za-z0-9_-]+)'\)/g,
  ]) {
    let m;
    while ((m = re.exec(LAB_SRC)) !== null) ids.add(m[1]);
  }
  for (const s of [1, 5, 20, 100, 500]) ids.add(`mlSpeed${s}`);
  return [...ids];
}

test('every element id MISSION LAB looks up exists in index.html', () => {
  const present = new Set([...INDEX_SRC.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const missing = referencedIds().filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `index.html is missing MISSION LAB ids: ${missing.join(', ')}`);
});

test('MISSION LAB only ever touches its own ml*-prefixed ids', () => {
  // Isolation rule: the module must not read or write any dashboard element.
  // missionLab is the single root exception.
  const foreign = referencedIds().filter((id) => id !== 'missionLab' && !/^ml/.test(id));
  assert.deepEqual(foreign, [], `MISSION LAB must not touch non-ml ids: ${foreign.join(', ')}`);
});

test('index.html loads the Mission Lab stylesheet and script, and keeps it collapsed', () => {
  assert.match(INDEX_SRC, /<link rel="stylesheet" href="css\/missionlab\.css"/);
  assert.match(INDEX_SRC, /<script src="js\/missionlab\.js"><\/script>/);
  // <details> without the `open` attribute is the collapsed default.
  const details = INDEX_SRC.match(/<details class="mission-lab" id="missionLab"[^>]*>/);
  assert.ok(details, 'MISSION LAB must be a <details> element');
  assert.ok(!/\bopen\b/.test(details[0]), 'MISSION LAB must ship collapsed so the dashboard is unchanged');
});

test('the panel is inserted additively and does not disturb the existing dashboard', () => {  // Everything the module needs arrives via one <details> block plus two tags;
  // no existing element id in the dashboard is redefined by it.
  const before = INDEX_SRC.slice(0, INDEX_SRC.indexOf('<details class="mission-lab"'));
  const dashboardIds = new Set([...before.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const labBlock = INDEX_SRC.slice(INDEX_SRC.indexOf('<details class="mission-lab"'), INDEX_SRC.indexOf('</details>') + 10);
  const labIds = new Set([...labBlock.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const collisions = [...labIds].filter((id) => dashboardIds.has(id));
  assert.deepEqual(collisions, [], `MISSION LAB must not redeclare dashboard ids: ${collisions.join(', ')}`);
  // The footer that followed the old insertion point must still be present.
  assert.match(INDEX_SRC, /<footer class="footer">/);
});
