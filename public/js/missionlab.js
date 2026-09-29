/**
 * missionlab.js
 * ---------------------------------------------------------------------------
 * MISSION LAB — the operator console for the parts of this backend that the
 * main dashboard never surfaced.
 *
 * The audit that motivated this found 27 REST routes and 2 socket events of
 * which the dashboard consumed exactly 2 routes and 0 replay events:
 *
 *   consumed    GET /api/snapshot, POST /api/ai-analysis/:id/refresh
 *   orphaned    all 11 /api/mission-replay/* routes, the whole /api/engine-sim/*
 *               family, /api/maintenance (RUL, fatigue, forecast), /api/can/status,
 *               /api/alerts, /api/history/:id, /api/series/:id, /api/meta,
 *               /api/health, /api/ready, and the socket events
 *               `mission-replay-frame` (server.js) and `replay-frame`.
 *
 * Everything here is ADDITIVE. This file:
 *   - opens its OWN Socket.IO connection, because the dashboard's is module
 *     private inside app.js and there is no supported handle to reuse;
 *   - uses its own thin fetch wrapper, mirroring the dashboard's x-api-key and
 *     timeout behaviour;
 *   - writes only inside #missionLab, so no existing element, id, class or
 *     handler in the dashboard is touched or re-rendered;
 *   - is exposed as window.MissionLab for debugging, matching the existing
 *     window.twin3d / window.DTCharts / window.dtState convention.
 *
 * Deterministic verdict note: classifySignature() is reimplemented here as a
 * small client-side mirror so the lab can label a replay frame accident vs
 * degradation WITHOUT a round trip. It is only a display aid — the authoritative
 * verdict is the one the server computes in ai/analysisEngine.js, and the
 * MISSION LAB shows what the AI box concluded, not a second opinion.
 * ---------------------------------------------------------------------------
 */

(function initMissionLab(global) {
  'use strict';

  const LAB_ID = 'missionLab';
  const root = document.getElementById(LAB_ID);
  if (!root) return; // template not present; nothing to do, and no error

  const FAULT_TYPES = [
    'oil_pressure_degradation', 'oil_starvation', 'plug_fouling', 'detonation_risk',
    'overheating', 'fuel_starvation', 'vibration_anomaly', 'sensor_dropout',
  ];
  const SEVERITIES = ['low', 'moderate', 'severe', 'critical'];
  const PHASES = ['taxi', 'takeoff', 'climb', 'cruise', 'loiter', 'descent', 'landing'];
  const SPEEDS = [1, 5, 20, 100, 500];
  const REQUEST_TIMEOUT_MS = 20000;
  const REFRESH_TIMEOUT_MS = 45000;

  /** Two demo presets: the same channel family resolving to different verdicts.
   *  Faults use the FORM's field names (onset / duration), because these objects
   *  are written straight into the fault rows and read back by collectFaults(). */
  const PRESETS = {
    lookalike: {
      label: 'Look-alike degradation',
      hint: 'CHT + oil-temp + vibration drift together while power channels stay healthy → classifies DEGRADATION and must never reach accident.',
      duration: 3600,
      faults: [
        { type: 'overheating', onset: 600, duration: 1800, severity: 'moderate' },
        { type: 'vibration_anomaly', onset: 900, duration: 1500, severity: 'moderate' },
      ],
    },
    cascade: {
      label: 'Combined multi-fault cascade',
      hint: 'Critical overheating → severe vibration → critical fuel starvation. Stacks three faults on one mission. Accident-class detection is NOT reachable here: replay frames carry no manifold-pressure channel and no replay fault moves RPM, so watch the LIVE fleet verdict card for that.',
      duration: 3600,
      faults: [
        { type: 'overheating', onset: 600, duration: 1200, severity: 'critical' },
        { type: 'vibration_anomaly', onset: 1500, duration: 900, severity: 'severe' },
        { type: 'fuel_starvation', onset: 1800, duration: 900, severity: 'critical' },
      ],
    },
  };

  // ---- state -------------------------------------------------------------
  const state = {
    missions: [],
    missionId: null,
    range: null,          // { t0, t1, maxT }
    playing: false,
    speed: 20,
    faults: [],           // in-progress injection rows
    can: { nodes: [], stats: null },
    phases: [],
    busy: new Set(),
    lastFrame: null,
    currentT: null,
    socket: null,
  };

  // ---- dom helpers -------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const setText = (node, text) => { if (node) node.textContent = text; };
  const setHidden = (node, hidden) => { if (node) node.hidden = Boolean(hidden); };

  function msg(id, text, kind) {
    const node = el(id);
    if (!node) return;
    node.textContent = text || '';
    node.dataset.kind = kind || 'info';
    setHidden(node, !text);
  }

  function fmtTime(t) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return '--:--';
    const total = Math.max(0, Math.floor(t));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  const num = (v, digits = 1, suffix = '') =>
    (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '--') + suffix;

  // precision/recall are legitimately null when the denominator is zero, so a
  // null must render as "n/a", never as 0.000.
  const fmtScore = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : 'n/a');

  // ---- fetch wrapper (mirrors the dashboard's x-api-key + timeout) --------
  function readKey() {
    try { return global.localStorage.getItem('dtApiKey') || ''; } catch { return ''; }
  }

  async function apiFetch(path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const key = readKey();
    if (key && method !== 'GET') headers['x-api-key'] = key;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal, cache: 'no-store',
      });
      const ctype = res.headers.get('content-type') || '';
      const data = ctype.includes('json') ? await res.json().catch(() => null) : null;
      if (!res.ok) {
        const detail = (data && (data.message || data.error)) || `HTTP ${res.status}`;
        const err = new Error(detail);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Wrap an action so a button disables while in flight and errors surface once. */
  async function busyAction(btnId, msgId, work) {
    const btn = el(btnId);
    if (btn) btn.disabled = true;
    if (msgId) msg(msgId, 'Working…', 'busy');
    try {
      return await work();
    } catch (err) {
      const text = err && err.status === 429
        ? 'Server rate limit hit (10 heavy requests/minute). Wait a moment and retry.'
        : `Failed: ${(err && err.message) || 'unknown error'}`;
      if (msgId) msg(msgId, text, 'error');
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- deterministic verdict mirror (display aid only) --------------------
  // ai/retriever.js#classifySignature consumes an engine snapshot's `statuses`
  // map (nominal | warning | critical per channel). A mission-replay frame is a
  // DIFFERENT shape: grouped engineering values plus a ground-truth `fault_flags`
  // list, with no status strings. So the mirror rebuilds a status map from the
  // replay values and then applies the identical two-leg pattern logic and the
  // same severity rule (off-nominal = warning|critical, never truthiness).
  //
  // The bands below are NOT guesses. missionreplay/profiles.js publishes the
  // generator's own per-phase nominal targets (PHASE_PROFILES) and per-parameter
  // noise sigma (PARAM_DEFS). A phase's acceptable envelope spans the targets of
  // that phase AND its neighbours, because a channel legitimately sits anywhere
  // between two targets while the profile is ramping — during landing, for
  // example, rpm legitimately travels from the descent target down to the landing
  // target. Tolerance is a multiple of sigma, widened by half the envelope so a
  // wide-band channel is not penalised. The constants are reproducible with
  // `node scripts/calibrate-missionlab-bands.js`, which asserts a clean mission
  // produces zero off-nominal samples.
  //
  // REACHABILITY (deliberate, and stated in the UI): the accident leg of
  // classifySignature needs RPM + fuel flow + manifold pressure collapsing
  // together. A replay frame has no manifold-pressure channel at all, and no
  // mission-replay fault type perturbs RPM (fuel_starvation only scales
  // fuel_flow_lph and fuel_remaining_l). So the accident class is NOT reachable
  // from replay data and this mirror will never claim it. Accident-class
  // detection is demonstrated on the LIVE fleet instead, where the simulator does
  // drive RPM and manifold pressure — see the AI box verdict card.
  const OFF_NOMINAL = (v) => v === 'warning' || v === 'critical';

  const PHASE_ORDER = ['taxi', 'takeoff', 'climb', 'cruise', 'loiter', 'descent', 'landing'];

  // missionreplay/profiles.js PHASE_PROFILES, restricted to the channels read here.
  const PHASE_TARGETS = {
    taxi: { rpm: 1100, cht_c: 100, egt_c: 575, oil_temp_c: 50, oil_pressure_kpa: 365, fuel_flow_lph: 6, vibration_mm_s: 1 },
    takeoff: { rpm: 2780, cht_c: 230, egt_c: 825, oil_temp_c: 90, oil_pressure_kpa: 435, fuel_flow_lph: 34, vibration_mm_s: 2.8 },
    climb: { rpm: 2500, cht_c: 218, egt_c: 780, oil_temp_c: 93, oil_pressure_kpa: 415, fuel_flow_lph: 26, vibration_mm_s: 2.2 },
    cruise: { rpm: 2300, cht_c: 198, egt_c: 740, oil_temp_c: 92, oil_pressure_kpa: 405, fuel_flow_lph: 18, vibration_mm_s: 2 },
    loiter: { rpm: 2000, cht_c: 182, egt_c: 700, oil_temp_c: 89, oil_pressure_kpa: 385, fuel_flow_lph: 12.5, vibration_mm_s: 1.8 },
    descent: { rpm: 1650, cht_c: 160, egt_c: 625, oil_temp_c: 84, oil_pressure_kpa: 375, fuel_flow_lph: 9, vibration_mm_s: 1.5 },
    landing: { rpm: 1200, cht_c: 140, egt_c: 575, oil_temp_c: 80, oil_pressure_kpa: 365, fuel_flow_lph: 6.5, vibration_mm_s: 1.2 },
  };

  // missionreplay/profiles.js PARAM_DEFS sigma, and the calibrated tolerance as
  // a multiple of it (see scripts/calibrate-missionlab-bands.js).
  const CHANNELS = [
    { key: 'cht', param: 'cht_c', dir: 'high', sigma: 4, tolMult: 6, read: (s) => s.thermal.cht_c },
    { key: 'egt', param: 'egt_c', dir: 'high', sigma: 8, tolMult: 6, read: (s) => s.thermal.egt_c },
    { key: 'oilTemp', param: 'oil_temp_c', dir: 'high', sigma: 1.5, tolMult: 16, read: (s) => s.thermal.oil_temp_c },
    { key: 'vibration', param: 'vibration_mm_s', dir: 'high', sigma: 0.25, tolMult: 10, read: (s) => s.mechanical.vibration_mm_s },
    { key: 'oilPressure', param: 'oil_pressure_kpa', dir: 'low', sigma: 5, tolMult: 6, read: (s) => s.mechanical.oil_pressure_kpa },
    { key: 'fuelFlow', param: 'fuel_flow_lph', dir: 'low', sigma: 0.4, tolMult: 6, read: (s) => s.fuel.fuel_flow_lph },
    { key: 'rpm', param: 'rpm', dir: 'two', sigma: 15, tolMult: 20, read: (s) => s.mechanical.rpm },
  ];

  /** Nominal envelope for a channel in a phase: its own target ± its neighbours'. */
  function envelope(channel, phase) {
    const i = PHASE_ORDER.indexOf(phase);
    const near = [PHASE_ORDER[i - 1], phase, PHASE_ORDER[i + 1]]
      .filter(Boolean)
      .map((p) => PHASE_TARGETS[p][channel.param]);
    const lo = Math.min(...near);
    const hi = Math.max(...near);
    const tol = Math.max(channel.sigma * channel.tolMult, hi - lo, 1) * 0.5;
    return { lo, hi, tol };
  }

  function channelStatus(channel, phase, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const { lo, hi, tol } = envelope(channel, phase);
    if (channel.dir === 'high') {
      if (value > hi + 2 * tol) return 'critical';
      if (value > hi + tol) return 'warning';
      return 'nominal';
    }
    if (channel.dir === 'low') {
      if (value < lo - 2 * tol) return 'critical';
      if (value < lo - tol) return 'warning';
      return 'nominal';
    }
    if (value < lo - 2 * tol || value > hi + 2 * tol) return 'critical';
    if (value < lo - tol || value > hi + tol) return 'warning';
    return 'nominal';
  }

  function replayStatuses(frame) {
    const st = (frame && frame.state) || {};
    const statuses = {};
    for (const c of CHANNELS) {
      const group = { cht: st.thermal, egt: st.thermal, oilTemp: st.thermal, vibration: st.mechanical, oilPressure: st.mechanical, fuelFlow: st.fuel, rpm: st.mechanical }[c.key];
      if (!group) { statuses[c.key] = null; continue; }
      statuses[c.key] = channelStatus(c, st.phase, c.read(st));
    }
    // No manifold-pressure channel exists in a replay frame, so it is never
    // off-nominal here and the accident leg below is unreachable by design.
    statuses.manifoldPressure = null;
    return statuses;
  }

  function classifyFrame(frame) {
    const statuses = replayStatuses(frame);
    const off = (k) => OFF_NOMINAL(statuses[k]);
    const any = (...ks) => ks.some((k) => off(k));
    const all = (...ks) => ks.every((k) => off(k));
    const counts = { accident: 0, degradation: 0 };
    const patternIds = [];
    const evidence = [];
    const offKeys = Object.keys(statuses).filter(off);

    // Accident leg. classifySignature requires rpm+fuelFlow+manifoldPressure;
    // manifoldPressure is structurally absent from replay, so this collapses to
    // rpm+fuel flow. Kept for faithfulness — see the REACHABILITY note above.
    if (all('rpm', 'fuelFlow') || all('rpm', 'fuelFlow', 'vibration')) {
      counts.accident += 3;
      patternIds.push('pattern-power-loss');
      evidence.push('RPM + fuel flow collapsing together = accident-class power loss');
    } else if (any('rpm', 'fuelFlow')) {
      counts.degradation += 1;
      evidence.push('isolated power-channel drift without the full collapse = degradation');
    }
    // Look-alike leg: the KB's cooling/coking case. Must never become accident.
    if (all('cht', 'egt') && any('vibration')) {
      if (counts.accident === 0) counts.degradation += 3;
      patternIds.push('pattern-cooling-vibration');
      evidence.push('CHT + EGT rising with vibration = cooling/coking degradation, NOT an accident');
    } else if (all('cht', 'egt') || any('cht', 'egt', 'vibration', 'oilTemp', 'oilPressure')) {
      counts.degradation += 1;
    }
    if (!counts.accident && !counts.degradation) {
      evidence.push('no combined off-nominal signature — nominal health');
    }

    const className = counts.accident > 0 ? 'accident' : (counts.degradation > 0 ? 'degradation' : 'nominal');
    return { className, patternIds, evidence, statuses, offKeys, accidentScore: counts.accident, degradationScore: counts.degradation };
  }

  // ---- fault injection form ---------------------------------------------
  function faultRowHtml() {
    return '<input type="text" list="mlFaultTypes" placeholder="fault type" aria-label="fault type">'
      + '<input type="number" min="0" placeholder="onset s" aria-label="onset seconds">'
      + '<input type="number" min="1" placeholder="dur s" aria-label="duration seconds">'
      + `<select aria-label="severity">${SEVERITIES.map((s) => `<option>${s}</option>`).join('')}</select>`
      + '<button type="button" class="ml-fault-remove" title="Remove this fault" aria-label="Remove fault">×</button>';
  }

  function addFaultRow(preset) {
    state.faults.push({
      type: '', onset: '', duration: '',
      severity: 'severe',
      ...(preset || {}),
    });
    renderFaultRows();
  }

  function renderFaultRows() {
    const host = el('mlFaultRows');
    if (!host) return;
    host.textContent = '';
    if (state.faults.length === 0) {
      const p = document.createElement('p');
      p.className = 'ml-empty';
      p.textContent = 'No faults queued — the mission will be a clean nominal flight.';
      host.appendChild(p);
      return;
    }
    state.faults.forEach((fault, i) => {
      const row = document.createElement('div');
      row.className = 'ml-fault-row';
      row.dataset.index = String(i);
      row.innerHTML = faultRowHtml();
      const [type, onset, dur, sev] = row.querySelectorAll('input, select');
      type.value = fault.type || '';
      onset.value = fault.onset === '' || fault.onset === undefined ? '' : fault.onset;
      dur.value = fault.duration === '' || fault.duration === undefined ? '' : fault.duration;
      sev.value = fault.severity;

      type.addEventListener('change', () => { fault.type = type.value.trim(); });
      onset.addEventListener('input', () => { fault.onset = onset.value; });
      dur.addEventListener('input', () => { fault.duration = dur.value; });
      sev.addEventListener('change', () => { fault.severity = sev.value; });
      row.querySelector('.ml-fault-remove').addEventListener('click', () => {
        state.faults.splice(i, 1);
        renderFaultRows();
      });
      host.appendChild(row);
    });
  }

  function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    setText(el('mlDuration'), String(preset.duration));
    setText(el('mlFaultHint'), preset.hint);
    state.faults = preset.faults.map((f) => ({ ...f }));
    renderFaultRows();
    msg('mlInjectMsg', `Preset "${preset.label}" staged. Press Generate to build the mission.`, 'ok');
  }

  /**
   * Turn the fault rows into the generator's wire shape.
   * Takes the rows as arguments so it is testable without a DOM, and tolerates
   * the server's own `onset_s` / `duration_s` spelling as well as the form's
   * `onset` / `duration` — a mismatch here silently produced faultless missions.
   */
  function collectFaults(rows, duration) {
    const total = Number(duration) || 3600;
    return (rows || [])
      .map((f) => {
        const onsetRaw = f.onset === undefined ? f.onset_s : f.onset;
        const durRaw = f.duration === undefined ? f.duration_s : f.duration;
        const onset_s = Number(onsetRaw);
        if (!f.type || !Number.isFinite(onset_s)) return null;
        const out = { type: f.type, onset_s };
        const duration_s = Number(durRaw);
        if (Number.isFinite(duration_s)) out.duration_s = duration_s;
        if (f.severity) out.severity = f.severity;
        return out;
      })
      .filter(Boolean)
      // An onset outside the mission would never be sampled, so drop it loudly
      // rather than queueing a fault that can never fire.
      .filter((f) => f.onset_s >= 0 && f.onset_s < total);
  }

  async function generateMission() {
    const missionId = (el('mlMissionId') && el('mlMissionId').value || '').trim();
    if (!missionId) { msg('mlInjectMsg', 'Mission ID is required.', 'error'); return; }

    const duration = Number(el('mlDuration').value);
    if (!Number.isFinite(duration) || duration < 30 || duration > 86400) {
      msg('mlInjectMsg', 'Duration must be between 30 and 86400 seconds.', 'error');
      return;
    }

    const seedRaw = (el('mlSeed').value || '').trim();
    const body = {
      missionId,
      duration,
      sampleRateHz: Number(el('mlRate').value) || 1,
      recordCan: Boolean(el('mlRecordCan').checked),
      faults: collectFaults(state.faults, duration),
    };
    if (seedRaw !== '') {
      const seed = Number(seedRaw);
      if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
        msg('mlInjectMsg', 'Seed must be an integer between 0 and 4294967295.', 'error');
        return;
      }
      body.seed = seed;
    }

    const res = await busyAction('mlGenerateBtn', 'mlInjectMsg', () =>
      apiFetch('/api/mission-replay/generate', { method: 'POST', body, timeoutMs: REFRESH_TIMEOUT_MS }));
    if (!res) return;

    msg('mlInjectMsg',
      `Generated ${res.missionId}: ${res.sampleCount} samples over ${Math.round(res.durationS)}s, seed ${res.seed}, ${res.faultEvents} fault events.`,
      'ok');
    await loadMissions();
    await selectMission(res.missionId);
  }

  // ---- mission library ---------------------------------------------------
  async function loadMissions() {
    const res = await busyAction('mlRefreshMissions', 'mlLibraryMsg', () => apiFetch('/api/mission-replay'));
    if (!res) return;
    state.missions = Array.isArray(res.missions) ? res.missions : [];
    renderMissions();
    msg('mlLibraryMsg', state.missions.length
      ? `${state.missions.length} mission(s) on disk.`
      : 'No missions yet — generate one with a fault preset.', state.missions.length ? 'ok' : 'info');
  }

  function renderMissions() {
    const host = el('mlMissions');
    if (!host) return;
    host.textContent = '';
    if (state.missions.length === 0) {
      const p = document.createElement('p');
      p.className = 'ml-empty';
      p.textContent = 'Empty. Use a preset above to create the first mission.';
      host.appendChild(p);
      return;
    }
    for (const m of state.missions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ml-mission';
      const selected = m.missionId === state.missionId;
      btn.setAttribute('aria-current', String(selected));
      // Only the id belongs here. `dir` is this machine's absolute path, which
      // is noise in the list and must not be printed in a demo screenshot.
      // Duration / sample count / seed are shown by mlRangeInfo once selected.
      btn.innerHTML = '<span class="ml-mid"></span>';
      btn.querySelector('.ml-mid').textContent = m.missionId;
      btn.addEventListener('click', () => selectMission(m.missionId));
      host.appendChild(btn);
    }
  }

  async function selectMission(missionId) {
    if (!missionId) return;
    state.missionId = missionId;
    state.playing = false;
    setText(el('mlActiveMission'), missionId);
    renderMissions();

    const manifest = await busyAction('mlScrub', 'mlReplayMsg', () =>
      apiFetch(`/api/mission-replay/${encodeURIComponent(missionId)}/manifest`));
    if (!manifest) return;

    // The manifest is the generator's own record: duration_s / sample_count /
    // sample_rate_hz / seed, and the replay timeline starts at t=0 (t0 on the
    // loaded record), not at the manifest's start_time_utc.
    const duration = Number(manifest.duration_s) || 0;
    const rate = Number(manifest.sample_rate_hz) || 1;
    state.range = { t0: 0, t1: duration, maxT: duration, rate };

    const scrub = el('mlScrub');
    if (scrub) {
      scrub.min = '0';
      scrub.max = String(Math.max(1, duration));
      scrub.step = String(1 / rate);
      scrub.value = '0';
      scrub.disabled = false;
    }
    setText(el('mlRangeInfo'), `0:00 → ${fmtTime(duration)} · ${manifest.sample_count} samples @ ${manifest.sample_rate_hz} Hz · seed ${manifest.seed} · ${manifest.uav_type || 'UAV'}`);
    msg('mlReplayMsg', 'Mission loaded. Press Play to stream frames.', 'ok');

    await Promise.all([loadFaultsGroundTruth(missionId), loadEvaluation(missionId), loadPhases(missionId), refreshCan()]);
    await seekTo(0);
  }

  // /faults returns the generator's own event table: {fault_id, type, label,
  // severity, onset_s, detected_s, resolved_s, precursor_window_s,
  // affected_parameters, injected}. `injected:false` rows are emergent events
  // the fault library raised on its own — those are the interesting ones, so
  // they are tagged rather than hidden.
  async function loadFaultsGroundTruth(missionId) {
    const faults = await apiFetch(`/api/mission-replay/${encodeURIComponent(missionId)}/faults`).catch(() => null);
    const tbody = el('mlGroundTruth');
    if (!tbody) return;
    tbody.textContent = '';
    const list = Array.isArray(faults) ? faults : [];
    if (list.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" class="ml-empty">No injected faults — nominal flight.</td>';
      tbody.appendChild(tr);
      return;
    }
    for (const f of list) {
      const tr = document.createElement('tr');
      const cells = [
        f.fault_id || '-',
        `${f.type || '-'}${f.injected === false ? ' (emergent)' : ''}`,
        f.severity || '-',
        f.onset_s ?? '-',
        f.detected_s ?? '-',
        f.resolved_s ?? '-',
      ];
      cells.forEach((value, i) => {
        const td = document.createElement('td');
        td.textContent = String(value);
        if (i >= 3) td.className = 'num';
        if (f.injected === false) td.classList.add('ml-warnish');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  async function loadEvaluation(missionId) {
    const ev = await apiFetch(`/api/mission-replay/${encodeURIComponent(missionId)}/evaluation`).catch(() => null);
    const host = el('mlEvalStats');
    if (!host) return;
    host.textContent = '';
    if (!ev) { msg('mlEvalMsg', 'Evaluation unavailable for this mission.', 'error'); return; }

    // analytics/missionReplayMetrics.js shape: groundTruth{injectedEvents,
    // emergentEvents,emergent[]}, detectors{rule,analytics,combined,truthPositive},
    // calibration{mode,baselineHealth,baselineMargin,healthThreshold,knownGoodSamples}.
    const gt = ev.groundTruth || {};
    const rule = (ev.detectors && ev.detectors.rule) || {};
    const analytics = (ev.detectors && ev.detectors.analytics) || {};
    const combined = (ev.detectors && ev.detectors.combined) || {};
    const cal = ev.calibration || {};

    const f1Cell = (label, m) => {
      const box = document.createElement('div');
      box.className = 'ml-kv-item';
      box.innerHTML = '<div class="ml-kv-key"></div><div class="ml-kv-val"></div><div class="ml-kv-val"><small></small></div>';
      box.querySelector('.ml-kv-key').textContent = label;
      const val = box.querySelector('.ml-kv-val');
      val.textContent = typeof m.f1 === 'number' ? m.f1.toFixed(3) : 'n/a';
      val.classList.add(typeof m.f1 === 'number' ? (m.f1 >= 0.8 ? 'ml-good' : 'ml-warnish') : 'ml-warnish');
      const sub = box.querySelectorAll('.ml-kv-val')[1].querySelector('small');
      sub.textContent = `P ${fmtScore(m.precision)} · R ${fmtScore(m.recall)} · ${m.tp ?? 0}TP/${m.fp ?? 0}FP/${m.fn ?? 0}FN`;
      return box;
    };

    const simple = (label, text, cls) => {
      const box = document.createElement('div');
      box.className = 'ml-kv-item';
      box.innerHTML = '<div class="ml-kv-key"></div><div class="ml-kv-val"></div>';
      box.querySelector('.ml-kv-key').textContent = label;
      const val = box.querySelector('.ml-kv-val');
      val.textContent = String(text);
      if (cls) val.classList.add(cls);
      return box;
    };

    host.appendChild(f1Cell('Rule detector F1', rule));
    host.appendChild(f1Cell('Analytics (L3 health) F1', analytics));
    host.appendChild(f1Cell('Combined F1', combined));
    host.appendChild(simple('Injected events', gt.injectedEvents ?? 0));
    host.appendChild(simple('Emergent events', gt.emergentEvents ?? 0, (gt.emergentEvents ?? 0) > 0 ? 'ml-warnish' : null));
    host.appendChild(simple('Evaluated samples', `${ev.evaluatedSamples ?? 0} / ${ev.sampleCount ?? '?'}`));
    host.appendChild(simple('Baseline health', `${fmtScore(cal.baselineHealth)} (margin ${cal.baselineMargin ?? '-'})`));
    host.appendChild(simple('Calibration mode', cal.mode || 'unknown'));

    const emergent = Array.isArray(gt.emergent) && gt.emergent.length
      ? ` Emergent: ${gt.emergent.map((e) => `${e.type}@${e.onset_s}s`).join(', ')} — raised by the fault library, not injected.`
      : '';
    msg('mlEvalMsg',
      `Scored against injected ground truth: ${gt.injectedEvents ?? 0} injected, ${gt.emergentEvents ?? 0} emergent.${emergent}`, 'ok');
  }

  // ---- transport ---------------------------------------------------------
  async function control(action, value) {
    if (!state.missionId) { msg('mlReplayMsg', 'Load a mission first.', 'error'); return null; }
    const body = value === undefined ? { action } : { action, value };
    const res = await apiFetch(`/api/mission-replay/${encodeURIComponent(state.missionId)}/control`, { method: 'POST', body })
      .catch((err) => { msg('mlReplayMsg', `Control failed: ${err.message}`, 'error'); return null; });
    if (res) applySnapshot(res);
    return res;
  }

  async function play(speed) {
    if (speed) state.speed = speed;
    const res = await control('play', state.speed);
    if (res) { state.playing = true; setReplayFlag(true); msg('mlReplayMsg', `Streaming at ${state.speed}×.`, 'ok'); }
  }

  async function pause() {
    const res = await control('pause');
    if (res) { state.playing = false; setReplayFlag(false); msg('mlReplayMsg', 'Paused.', 'info'); }
  }

  async function seekTo(t) {
    if (!state.range) return;
    const clamped = Math.min(Math.max(t, state.range.t0), state.range.maxT);
    await control('seek', clamped);
    if (el('mlScrub')) el('mlScrub').value = String(clamped);
  }

  function currentTime() {
    if (typeof state.currentT === 'number') return state.currentT;
    return state.range ? state.range.t0 : 0;
  }

  /**
   * The server validates control values in [1, 10000], so a negative `step` is
   * rejected with HTTP 400. Stepping backwards is therefore a seek to one sample
   * earlier, not a control call.
   */
  function stepBack() {
    if (!state.range) return;
    const sampleSec = state.range.rate ? 1 / state.range.rate : 1;
    return seekTo(currentTime() - sampleSec);
  }

  function setReplayFlag(active) {
    const flag = el('mlReplayFlag');
    if (flag) flag.dataset.active = String(Boolean(active));
    const label = el('mlPlayBtn');
    setText(label, state.playing ? 'Pause' : 'Play');
  }

  // ---- frame rendering ---------------------------------------------------
  // Accepts both shapes the backend produces for the same instant:
  //   - the /control response and /snapshot: player.snapshot() =>
  //     {missionId, t_s, sampleIndex, phase, playing, anomaly, state}
  //   - the `mission-replay-frame` socket event: {missionId, state, anomaly}
  // which has no top-level t_s/playing and carries the instant only on state.
  function applySnapshot(snapshot) {
    if (!snapshot) return;
    const st = snapshot.state || {};
    if (typeof snapshot.playing === 'boolean') {
      state.playing = snapshot.playing;
      setReplayFlag(state.playing);
    }

    const tNow = typeof snapshot.t_s === 'number' ? snapshot.t_s : st.t_s;
    if (typeof tNow === 'number') state.currentT = tNow;
    if (typeof tNow === 'number' && state.range) {
      setText(el('mlClock'), `${fmtTime(tNow)} / ${fmtTime(state.range.maxT)}`);
      const scrub = el('mlScrub');
      // Do not fight the user while they are dragging the scrubber.
      if (scrub && document.activeElement !== scrub) scrub.value = String(tNow);
    }

    setText(el('mlPhase'), st.phase || '--');
    renderReadouts(st);
    renderVerdict(classifyFrame(snapshot), st);
    renderAnomaly(st.anomaly, snapshot);
  }

  function renderReadouts(st) {
    const flight = st.flight || {};
    const mech = st.mechanical || {};
    const thermal = st.thermal || {};
    const fuel = st.fuel || {};
    const values = [
      ['rpm', mech.rpm, 0, ''],
      ['Vibration', mech.vibration_mm_s, 2, ' mm/s'],
      ['Oil pressure', mech.oil_pressure_kpa, 0, ' kPa'],
      ['CHT', thermal.cht_c, 0, ' °C'],
      ['EGT', thermal.egt_c, 0, ' °C'],
      ['Oil temp', thermal.oil_temp_c, 0, ' °C'],
      ['Fuel flow', fuel.fuel_flow_lph, 1, ' L/h'],
      ['Fuel left', fuel.fuel_remaining_l, 0, ' L'],
      ['Altitude', flight.altitude_m, 0, ' m'],
      ['Airspeed', flight.airspeed_ms, 0, ' m/s'],
    ];
    const host = el('mlReadouts');
    if (!host) return;
    host.textContent = '';
    for (const [key, value, digits, suffix] of values) {
      const box = document.createElement('div');
      box.className = 'ml-kv-item';
      box.innerHTML = '<div class="ml-kv-key"></div><div class="ml-kv-val"></div>';
      box.querySelector('.ml-kv-key').textContent = key;
      box.querySelector('.ml-kv-val').textContent = num(value, digits, suffix);
      host.appendChild(box);
    }
  }

  function renderVerdict(verdict, st) {
    const banner = el('mlVerdict');
    if (!banner) return;
    banner.dataset.class = verdict.className;
    setText(el('mlVerdictBadge'), verdict.className);

    const summary = verdict.className === 'accident'
      ? 'Combined power-loss signature — accident-class.'
      : verdict.className === 'degradation'
        ? 'Drift without power collapse — degradation, not an accident.'
        : 'No combined off-nominal signature — nominal health.';
    setText(el('mlVerdictText'), `${summary} Off-nominal channels: ${verdict.offKeys.length ? verdict.offKeys.join(', ') : 'none'}.`);

    // Ground truth for this instant comes from the generator overlay, so the
    // operator can see the mirror's verdict against what was actually injected.
    const active = Array.isArray(st.fault_flags) ? st.fault_flags : [];
    setText(el('mlVerdictPatterns'),
      `${verdict.patternIds.length ? verdict.patternIds.join(', ') : 'no pattern matched'}`
      + ` · injected now: ${active.length ? active.join(', ') : 'none'}`);
    markPhasePosition(st.t_s);
  }

  function renderAnomaly(anomaly) {
    const a = anomaly || {};
    const tier = a.tier || 'nominal';
    const node = el('mlAnomaly');
    if (!node) return;
    node.textContent = tier;
    node.className = 'ml-kv-val ' + (tier === 'active' ? 'ml-bad' : tier === 'precursor' ? 'ml-warnish' : 'ml-good');
    const active = Array.isArray(a.active) ? a.active : [];
    const precursor = Array.isArray(a.precursor) ? a.precursor : [];
    setText(el('mlAnomalyDetail'),
      `active: ${active.length ? active.join(', ') : 'none'} · precursor: ${precursor.length ? precursor.join(', ') : 'none'}`);
  }

  // ---- phase schedule ----------------------------------------------------
  // /phases returns [{phase, start_s, end_s}]. Rendered as a bar so the operator
  // can see where a fault sits relative to the flight profile, and clicking a
  // phase seeks the player to its start.
  async function loadPhases(missionId) {
    const phases = await apiFetch(`/api/mission-replay/${encodeURIComponent(missionId)}/phases`).catch(() => null);
    state.phases = Array.isArray(phases) ? phases : [];
    const host = el('mlPhases');
    if (!host) return;
    host.textContent = '';
    if (state.phases.length === 0) {
      const p = document.createElement('p');
      p.className = 'ml-empty';
      p.textContent = 'No phase schedule available.';
      host.appendChild(p);
      return;
    }
    const total = state.phases.reduce((m, p) => Math.max(m, Number(p.end_s) || 0), 0) || 1;
    for (const p of state.phases) {
      const start = Number(p.start_s) || 0;
      const end = Number(p.end_s) || 0;
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'ml-phase';
      seg.style.flexGrow = String(Math.max(0.05, (end - start) / total));
      seg.textContent = p.phase;
      seg.title = `${p.phase}: ${fmtTime(start)} → ${fmtTime(end)}`;
      seg.addEventListener('click', () => seekTo(start));
      host.appendChild(seg);
    }
  }

  function markPhasePosition(t) {
    const marker = el('mlPhaseMarker');
    if (!marker || !state.phases.length || typeof t !== 'number') return;
    const total = state.phases.reduce((m, p) => Math.max(m, Number(p.end_s) || 0), 0) || 1;
    marker.hidden = false;
    marker.style.left = `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
  }

  // ---- AI box verdict (the authoritative one, from the server) -----------
  // ai/analysisEngine.js attaches `verdict` (className/patternIds/evidence)
  // to both the live and the degraded result, and server.js embeds aiAnalysis on
  // every /api/snapshot engine and on the `snapshot` socket event. This card
  // shows THAT verdict — unlike the replay mirror above, it is the real
  // knowledge-base classification, and it covers the live fleet, not the replay.
  async function refreshAiVerdict() {
    const analyses = await apiFetch('/api/ai-analysis').catch(() => null);
    const host = el('mlAiVerdict');
    if (!host) return;
    host.textContent = '';
    // /api/ai-analysis returns an OBJECT keyed by engine id (aiAnalysis.allLatest()),
    // and each value carries no id of its own — the key is the id. An array is
    // tolerated so a future shape change degrades instead of blanking the card.
    const entries = analyses == null ? []
      : Array.isArray(analyses)
        ? analyses.map((a, i) => [a && (a.id || a.engineId) || `engine-${i + 1}`, a])
        : Object.entries(analyses);

    if (entries.length === 0) {
      host.innerHTML = '<p class="ml-empty">No AI analysis cached yet. Use &ldquo;Explain now&rdquo; on the dashboard, then refresh.</p>';
      return;
    }
    for (const [id, a] of entries) {
      if (!a) continue;
      const v = a.verdict;
      const card = document.createElement('div');
      card.className = 'ml-kv-item';
      card.innerHTML = '<div class="ml-kv-key"></div><div class="ml-kv-val"></div><div class="ml-ai-text"></div>';
      card.querySelector('.ml-kv-key').textContent = id;
      const badge = card.querySelector('.ml-kv-val');
      badge.textContent = v && v.className ? v.className : 'verdict unavailable';
      badge.classList.add(v && v.className === 'accident' ? 'ml-bad' : v && v.className === 'degradation' ? 'ml-warnish' : 'ml-good');
      const text = card.querySelector('.ml-ai-text');
      text.textContent = [
        a.degraded ? 'degraded (rule-based)' : (a.provider || 'ai'),
        v && v.patternIds && v.patternIds.length ? v.patternIds.join(', ') : null,
        typeof a.generatedAt === 'number' ? new Date(a.generatedAt).toLocaleTimeString() : null,
      ].filter(Boolean).join(' · ');
      host.appendChild(card);
    }
  }

  // ---- CAN ---------------------------------------------------------------
  async function refreshCan() {
    const status = await apiFetch('/api/can/status').catch(() => null);
    const host = el('mlCanNodes');
    if (!host) return;
    host.textContent = '';
    if (!status) { setText(el('mlCanStats'), 'CAN bus status unavailable.'); return; }

    // Shape comes from missionreplay/can.js#status(): nodes[] carry {id,name,label,sends}
    // and stats is {sent,dropped,byPgn,firstTsMs,lastTsMs}.
    const nodes = Array.isArray(status.nodes) ? status.nodes : [];
    for (const n of nodes) {
      const chip = document.createElement('span');
      chip.className = 'ml-can-node';
      chip.textContent = `${n.id}:${n.name}`;
      chip.title = `${n.label || ''} — sends ${(n.sends || []).join(', ')}`;
      host.appendChild(chip);
    }
    const stats = status.stats || {};
    state.can.stats = stats;
    setText(el('mlCanStats'),
      `${status.protocol || 'unknown'} · ${status.pgnCount ?? '-'} PGNs · capacity ${status.capacity ?? '-'} · ` +
      `sent ${stats.sent ?? 0} · dropped ${stats.dropped ?? 0} · seq ${status.sequence ?? '-'}`);
    if (status.last) renderCanFrames([status.last]);
  }

  /** frames are {tsMs,id,hex,prio,src,dst,pgn,pgnHex,name,spn,signal,unit,data[]} */
  const CAN_FRAME_HISTORY = 24;

  function renderCanFrames(frames) {
    const host = el('mlCanFrames');
    if (!host || !Array.isArray(frames) || frames.length === 0) return;
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 24;
    for (const f of frames) {
      const line = document.createElement('div');
      line.className = 'ml-can-frame';
      const bytes = Array.isArray(f.data) ? f.data.join(' ') : '';
      line.textContent = `${f.hex || ''} p${f.prio ?? '-'} src${f.src ?? '-'}→${f.dst ?? '-'} `
        + `${f.name || f.signal || ''} [${bytes}]`;
      host.appendChild(line);
    }
    // The bus emits ~12 frames per replayed second, so an unbounded list buries
    // the rest of the panel within seconds of pressing play. Keep the tail.
    while (host.childElementCount > CAN_FRAME_HISTORY) host.removeChild(host.firstChild);
    if (atBottom) host.scrollTop = host.scrollHeight;
  }

  // ---- status strip ------------------------------------------------------
  async function refreshStatus() {
    const [health, meta] = await Promise.all([
      apiFetch('/api/health').catch(() => null),
      apiFetch('/api/meta').catch(() => null),
    ]);
    const set = (id, text, stateName) => {
      const wrap = el(id);
      if (!wrap) return;
      setText(wrap.querySelector('.ml-status-text'), text);
      const dot = wrap.querySelector('.ml-dot');
      if (dot) dot.dataset.state = stateName;
    };
    const healthText = health ? (health.status || (health.ok ? 'ok' : 'degraded')) : 'unreachable';
    set('mlStatusHealth', `server ${healthText}`, health ? 'ok' : 'err');
    // /api/meta returns {sensors: {<key>: {...}}, faultTypes: {...}} — a keyed
    // map, not an array, so the count comes from Object.keys.
    const sensorCount = meta && meta.sensors ? Object.keys(meta.sensors).length : 0;
    set('mlStatusSensors', sensorCount ? `${sensorCount} sensors tracked` : 'sensors unknown', sensorCount ? 'ok' : 'warn');
    const canSent = state.can.stats && typeof state.can.stats.sent === 'number' ? state.can.stats.sent : null;
    set('mlStatusCan', canSent === null ? 'CAN idle' : `CAN ${canSent} frames`, canSent ? 'ok' : 'warn');
  }

  // ---- socket wiring (own connection; the dashboard's is private) --------
  // The dashboard opened its socket inside app.js's IIFE and never exposed it,
  // so MISSION LAB opens a second connection. Socket.IO multiplexes it over the
  // same long-poll/websocket transport, so the cost is one extra handshake, not
  // a second engine subscription.
  function connectSocket() {
    if (typeof global.io !== 'function') return null;
    let socket;
    try {
      socket = global.io({ reconnectionDelay: 1000, reconnectionDelayMax: 5000, timeout: 5000 });
    } catch {
      return null;
    }

    // This is the event server.js:557 emits during mission-replay playback and
    // that NO existing client consumed. The same playback also publishes to the
    // artificial CAN bus, which is why frames arrive here too.
    socket.on('mission-replay-frame', (payload) => {
      if (!payload || payload.missionId !== state.missionId) return;
      state.lastFrame = payload;
      if (state.playing) applySnapshot({ ...payload, playing: true });
      renderCanFrames(payload.state && payload.state.can);
    });

    // The second orphan: recorded physics-mission replay (server.js:344).
    socket.on('replay-frame', (payload) => {
      if (!payload || !state.missionId) return;
      const flag = el('mlEngineSimFrame');
      if (!flag) return;
      setText(flag, payload.missionId
        ? `engine-sim replay · ${payload.engineId} · mission ${payload.missionId} · sample ${payload.index + 1}/${payload.total}`
        : '');
    });

    return socket;
  }

  // ---- wiring ------------------------------------------------------------
  function on(id, event, handler) {
    const node = el(id);
    if (node) node.addEventListener(event, handler);
  }

  function init() {
    // datalist for fault types so the field is free-text but discoverable
    const list = el('mlFaultTypes');
    if (list) {
      list.textContent = '';
      for (const t of FAULT_TYPES) {
        const opt = document.createElement('option');
        opt.value = t;
        list.appendChild(opt);
      }
    }

    // presets
    on('mlPresetLookalike', 'click', () => applyPreset('lookalike'));
    on('mlPresetCascade', 'click', () => applyPreset('cascade'));

    // injection
    on('mlAddFault', 'click', () => addFaultRow());
    on('mlGenerateBtn', 'click', generateMission);
    on('mlRefreshMissions', 'click', loadMissions);

    // transport
    on('mlPlayBtn', 'click', () => (state.playing ? pause() : play()));
    on('mlStopBtn', 'click', async () => { await control('stop'); state.playing = false; setReplayFlag(false); });
    on('mlStepBack', 'click', () => stepBack());
    on('mlStepFwd', 'click', () => control('step', 1));
    on('mlToStart', 'click', () => (state.range ? seekTo(state.range.t0) : null));
    on('mlScrub', 'change', (e) => seekTo(Number(e.target.value)));
    for (const s of SPEEDS) {
      on(`mlSpeed${s}`, 'click', () => { state.speed = s; renderSpeeds(); if (state.playing) play(s); });
    }

    // can + status
    on('mlRefreshCan', 'click', refreshCan);
    on('mlRefreshStatus', 'click', refreshStatus);
    on('mlRefreshAi', 'click', refreshAiVerdict);

    renderFaultRows();
    renderSpeeds();
    setText(el('mlFaultHint'), PRESETS.lookalike.hint);
    // Capture live health/CAN/telemetry frames too: the same socket carries the
    // dashboard's `snapshot` and `ai-analysis` events, so the lab's status
    // strip and CAN pane reflect the running engine, not just the last poll.
    state.socket = connectSocket();
    if (state.socket) {
      state.socket.on('snapshot', (snap) => {
        if (state.playing) return; // replay is authoritative while it streams
        const health = snap && snap.health;
        if (health) {
          const wrap = el('mlStatusHealth');
          setText(wrap && wrap.querySelector('.ml-status-text'), `server ${health.status || (health.ok ? 'ok' : 'degraded')}`);
          const dot = wrap && wrap.querySelector('.ml-dot');
          if (dot) dot.dataset.state = health.ok ? 'ok' : 'warn';
        }
      });
    }
    loadMissions();
    refreshCan().then(refreshStatus);
    refreshStatus();
    refreshAiVerdict();
  }

  function renderSpeeds() {
    for (const s of SPEEDS) {
      const btn = el(`mlSpeed${s}`);
      if (btn) btn.setAttribute('aria-pressed', String(state.speed === s));
    }
  }

  global.MissionLab = {
    state, apiFetch, control, play, pause, seekTo, loadMissions, generateMission,
    selectMission, refreshCan, refreshStatus, refreshAiVerdict, classifyFrame,
    replayStatuses, collectFaults, stepBack, currentTime, PRESETS, FAULT_TYPES,
    SEVERITIES, PHASES,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}(window));
