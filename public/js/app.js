/**
 * app.js — dashboard client logic.
 * Connects to the Socket.IO stream for live (spoofed) telemetry and
 * renders fleet stats, drives the 3D engine twin (twin3d.js), trend charts and the
 * fault-prediction alert feed. Falls back to REST polling whenever the
 * websocket connection is unavailable, and refuses to let a stalled feed
 * look like a healthy engine: after ~3 missed ticks the whole dashboard is
 * dimmed and a TELEMETRY STALE banner is shown.
 *
 * Nothing here uses inline event handlers, inline styles-in-markup or external
 * scripts, so it runs under a same-origin CSP.
 */
(function () {
  'use strict';

  // ---------------- Config ----------------
  const TICK_MS = 2000; // server telemetry tick (server.js TICK_MS)
  const STALE_MS = 3 * TICK_MS + 500; // no fresh snapshot for this long => stale
  const FETCH_TIMEOUT_MS = 8000;
  const REFRESH_TIMEOUT_MS = 45000; // "Explain now" waits behind the server's LLM queue
  const CHART_POINTS = 40;
  const AI_STALE_MS = 10 * 60 * 1000; // analyses are refreshed every ~5 min; twice that is suspicious
  const AI_MISMATCH_GRACE_MS = 45 * 1000; // a new analysis takes a while after a condition change
  const KEY_STORE = 'dt.apiKey';

  const state = {
    selectedEngineId: null,
    latest: null,
    history: {}, // engineId -> bounded chart series
    aiOverride: {}, // engineId -> newest analysis pushed over the socket
    // freshness bookkeeping
    startedAt: performance.now(),
    lastFreshAt: 0, // performance.now() of the last snapshot that advanced serverTime
    lastServerTime: null,
    skewSamples: [], // recent (serverTime - clientReceiveTime); max = best-case skew
    lagMs: 0, // how far behind the best-case the latest snapshot arrived
    skew: 0, // server clock minus client clock (ms), for ages of server timestamps
    graceUntil: 0, // ignore staleness briefly after the tab is shown again
    stale: null, // null | 'none' | 'link' | 'stalled' | 'lag'
    // connection
    socketConnected: false,
    everConnected: false,
    disconnectedAt: 0,
    conn: 'connecting',
    // ai button
    aiBusy: false,
    aiBlockedUntil: 0, // client Date.now() until which "Explain now" is disabled (rate limit)
    charts: {},
  };
  // twin3d.js (an ES module that loads after this script) reads this to draw
  // its first frame from whatever telemetry has already arrived.
  window.dtState = state;

  const el = (id) => document.getElementById(id);

  // ---------------- Safe value helpers ----------------
  // Every value from the server goes through these so the UI never shows
  // "undefined" / "NaN" when a field is missing or malformed.
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v, digits, fallback) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return isNum(n) ? (digits === undefined ? String(n) : n.toFixed(digits)) : (fallback === undefined ? '--' : fallback);
  };
  const str = (v, fallback) => (typeof v === 'string' && v.trim() !== '' ? v : (isNum(v) ? String(v) : (fallback === undefined ? '—' : fallback)));
  const clampPct = (v) => (isNum(v) ? Math.max(0, Math.min(100, v)) : 0);
  const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const setHidden = (node, hidden) => { if (node && node.hidden !== hidden) node.hidden = hidden; };
  function fmtTime(t) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-IN', { hour12: false });
  }
  function fmtAge(ms) {
    if (!isNum(ms)) return 'time unknown';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const hh = Math.floor(m / 60);
    if (hh < 48) return `${hh}h ${m % 60}m ago`;
    return `${Math.floor(hh / 24)}d ago`;
  }
  /** Current time on the server's clock (falls back to the client clock until a serverTime has been seen). */
  const serverNow = () => Date.now() + state.skew;

  // ---------------- Toasts (non-blocking errors / info) ----------------
  const toastActive = new Map(); // key -> { node, timer }
  const toastLastShown = new Map();
  const TOAST_GLYPH = { error: '✖', warn: '▲', info: '●' };

  function toast(message, { kind = 'info', key = message, timeoutMs = 7000, cooldownMs = 0 } = {}) {
    const host = el('toasts');
    if (!host) return;
    const now = Date.now();
    if (cooldownMs && now - (toastLastShown.get(key) || 0) < cooldownMs && !toastActive.has(key)) return;
    toastLastShown.set(key, now);

    let entry = toastActive.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      entry.text.textContent = message;
    } else {
      const node = document.createElement('div');
      node.className = `toast toast-${kind}`;
      const glyph = document.createElement('span');
      glyph.className = 'toast-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = TOAST_GLYPH[kind] || TOAST_GLYPH.info;
      const text = document.createElement('span');
      text.className = 'toast-text';
      text.textContent = message;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.setAttribute('aria-label', 'Dismiss notification');
      close.textContent = '×';
      close.addEventListener('click', () => dismiss(key));
      node.append(glyph, text, close);
      host.appendChild(node);
      entry = { node, text, timer: 0 };
      toastActive.set(key, entry);
      while (host.children.length > 4) { // bounded
        const oldest = [...toastActive.keys()][0];
        dismiss(oldest);
      }
    }
    entry.timer = setTimeout(() => dismiss(key), timeoutMs);
  }
  function dismiss(key) {
    const entry = toastActive.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    toastActive.delete(key);
  }

  // ---------------- API helper: timeout, res.ok, JSON errors, API key ----------------
  class ApiError extends Error {
    constructor(message, { status = 0, retryAfter = null, detail = null } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.retryAfter = retryAfter;
      this.detail = detail;
    }
  }

  function readKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (_) { return memKey; }
  }
  let memKey = '';
  function storeKey(k) {
    memKey = k;
    try { if (k) sessionStorage.setItem(KEY_STORE, k); else sessionStorage.removeItem(KEY_STORE); } catch (_) { /* storage blocked: memory only */ }
  }

  let keyPrompt = null;
  /** Small modal (not window.prompt). Resolves to the entered key, or null if cancelled. */
  function askForKey(rejected) {
    if (keyPrompt) return keyPrompt;
    const dlg = el('keyDialog');
    const input = el('keyInput');
    if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(null);
    dlg.querySelector('p').textContent = rejected
      ? 'The saved API key was rejected by the server. Enter the current admin API key. It is kept for this browser tab only.'
      : 'This action needs the server\'s admin API key. It is kept for this browser tab only.';
    input.value = '';
    keyPrompt = new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        dlg.removeEventListener('close', onClose);
        el('keyForm').removeEventListener('submit', onSubmit);
        el('keyCancel').removeEventListener('click', onCancel);
        input.value = '';
        if (dlg.open) dlg.close();
        keyPrompt = null;
        resolve(value);
      };
      const onSubmit = (e) => { e.preventDefault(); finish(input.value.trim() || null); };
      const onCancel = () => finish(null);
      const onClose = () => finish(null); // Esc
      dlg.addEventListener('close', onClose);
      el('keyForm').addEventListener('submit', onSubmit);
      el('keyCancel').addEventListener('click', onCancel);
      dlg.showModal();
      input.focus();
    });
    return keyPrompt;
  }

  async function apiFetch(path, { method = 'GET', body, timeoutMs = FETCH_TIMEOUT_MS, retryAuth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const key = readKey();
    if (key && method !== 'GET') headers['x-api-key'] = key;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs); // covers headers + body
    let res;
    let data = null;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, cache: 'no-store' });
      if ((res.headers.get('content-type') || '').includes('json')) {
        try { data = await res.json(); } catch (_) { data = null; }
      }
    } catch (err) {
      throw new ApiError(ctrl.signal.aborted ? 'The server took too long to respond' : 'Server unreachable', { status: 0 });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      if (res.status === 401 && method !== 'GET' && retryAuth) {
        if (key) storeKey(''); // the saved one was rejected
        const entered = await askForKey(!!key);
        if (entered) {
          storeKey(entered);
          return apiFetch(path, { method, body, timeoutMs, retryAuth: false });
        }
        throw new ApiError('An API key is required for this action', { status: 401 });
      }
      const ra = Number(res.headers.get('retry-after'));
      const retryAfter = res.status === 429 && Number.isFinite(ra) && ra > 0 ? ra : null;
      let msg = data && typeof data.error === 'string' ? data.error : `Request failed (HTTP ${res.status})`;
      if (res.status === 429) msg = retryAfter ? `Rate limited, please wait ${Math.ceil(retryAfter)}s and try again` : 'Rate limited, please wait a moment and try again';
      if (res.status === 401) msg = 'The API key was not accepted';
      throw new ApiError(msg, { status: res.status, retryAfter, detail: data && data.detail ? String(data.detail) : null });
    }
    if (data === null) throw new ApiError('Unexpected (non-JSON) response from server', { status: res.status });
    return data;
  }

  // ---------------- Fleet summary ----------------
  function renderFleetSummary(payload) {
    const fleet = payload.fleet || {};
    setText(el('statReliability'), isNum(fleet.missionReliability) ? `${num(fleet.missionReliability)}%` : '--%');
    el('statReliabilityBar').style.width = `${clampPct(fleet.missionReliability)}%`;
    setText(el('statHealth'), isNum(fleet.avgHealth) ? `${num(fleet.avgHealth)}%` : '--%');
    el('statHealthBar').style.width = `${clampPct(fleet.avgHealth)}%`;
    setText(el('statCritical'), num(fleet.criticalCount, 0));
    setText(el('statEngines'), num(fleet.engineCount !== undefined ? fleet.engineCount : payload.engines.length, 0));
  }

  const STATUS_LABEL = {
    nominal: 'NOMINAL',
    warning: '▲ WARNING',
    critical: '✖ CRITICAL',
    unknown: 'NO DATA',
  };
  function overallStatus(engine) {
    const statuses = engine && engine.statuses && typeof engine.statuses === 'object' ? Object.values(engine.statuses) : null;
    if (!statuses || statuses.length === 0) return 'unknown';
    if (statuses.includes('critical')) return 'critical';
    if (statuses.includes('warning')) return 'warning';
    return 'nominal';
  }

  function ringColor(status) {
    return status === 'critical' ? 'var(--critical)' : status === 'warning' ? 'var(--warning)' : status === 'unknown' ? 'var(--text-dim)' : 'var(--nominal)';
  }

  // ---------------- Engine cards (keyed: nodes persist so keyboard focus survives updates) ----------------
  const cardRefs = new Map(); // engineId -> { btn, ring, ringNum, tail, sub, badge }

  function selectEngine(id) {
    if (state.selectedEngineId === id) return;
    state.selectedEngineId = id;
    if (window.twin3d && window.twin3d.resetHistory) window.twin3d.resetHistory();
    state.aiBlockedUntil = 0;
    render({ fresh: false });
  }

  function makeCard(engineId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'engine-card';
    btn.addEventListener('click', () => selectEngine(engineId));
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.setAttribute('aria-hidden', 'true');
    const ringNum = document.createElement('span');
    ring.appendChild(ringNum);
    const body = document.createElement('div');
    body.className = 'engine-card-body';
    const tail = document.createElement('h3');
    const sub = document.createElement('p');
    const badge = document.createElement('span');
    body.append(tail, sub, badge);
    btn.append(ring, body);
    return { btn, ring, ringNum, tail, sub, badge };
  }

  function renderEngineCards(payload) {
    const container = el('engineCards');
    const ids = payload.engines.map((e) => e.id);
    // rebuild only if the engine set changed
    if (cardRefs.size !== ids.length || ids.some((id) => !cardRefs.has(id))) {
      cardRefs.clear();
      container.replaceChildren();
      ids.forEach((id) => {
        const refs = makeCard(id);
        cardRefs.set(id, refs);
        container.appendChild(refs.btn);
      });
    }
    payload.engines.forEach((engine) => {
      const refs = cardRefs.get(engine.id);
      const status = overallStatus(engine);
      const selected = engine.id === state.selectedEngineId;
      refs.btn.classList.toggle('selected', selected);
      refs.btn.setAttribute('aria-pressed', String(selected));
      refs.btn.setAttribute('aria-label', `${str(engine.tail, 'Engine')}, ${STATUS_LABEL[status].replace(/^\S+ /, '').toLowerCase()}, health ${num(engine.health, 0)} percent`);
      refs.ring.style.setProperty('--pct', String(clampPct(engine.health)));
      refs.ring.style.setProperty('--ring-color', ringColor(status));
      setText(refs.ringNum, num(engine.health, 0));
      setText(refs.tail, str(engine.tail, engine.id || 'Engine'));
      setText(refs.sub, `${str(engine.engine, 'Engine')} · ${num(engine.hoursFlown, 1)} hrs`);
      refs.badge.className = `engine-status-badge status-${status}`;
      setText(refs.badge, STATUS_LABEL[status]);
    });
  }

  function renderPredictedFault(engine) {
    const box = el('predictedFaultBox');
    const active = engine.activeFault && engine.activeFault.label;
    const predicted = engine.predictedFault && engine.predictedFault.label;
    if (!active && !predicted) {
      setHidden(box, true);
      return;
    }
    setHidden(box, false);
    if (active) {
      setText(el('pfTitle'), `Active condition: ${engine.activeFault.label}`);
      setText(el('pfSub'), 'Simulated fault scenario currently in progress on this engine.');
      setText(el('pfConfidence'), '');
    } else {
      setText(el('pfTitle'), `Model prediction: ${engine.predictedFault.label}`);
      setText(el('pfSub'), 'Statistical anomaly + threshold model flags elevated risk before failure. Advisory only.');
      setText(el('pfConfidence'), isNum(engine.predictedFault.confidence) ? `${num(engine.predictedFault.confidence, 0)}%` : '');
    }
  }

  // ---------------- AI engine situation report ----------------
  // `engine.aiAnalysis` rides along on every snapshot (cached server-side
  // from the last Gemini/Groq/RAG pass for that engine); the `ai-analysis`
  // socket event additionally pushes a fresh one in as soon as it's
  // generated, without waiting for the next telemetry tick.
  //
  // Three visually distinct outcomes so the panel never overstates what it is:
  //   gemini    - live analysis from Gemini
  //   groq      - analysis from the Groq fallback model (badge says so)
  //   degraded  - no AI answered; the text is an automatic rule-based summary
  const AI_SUFFIX_RE = /\s*\(AI narrative unavailable:[\s\S]*\)\s*$/;

  function classifyAnalysis(a) {
    if (!a || typeof a !== 'object' || typeof a.text !== 'string' || !a.text.trim()) return null;
    const hasError = typeof a.error === 'string' && a.error.trim() !== '';
    // Newer servers send an explicit `degraded` flag; older payloads only have model:null / error.
    const degraded = typeof a.degraded === 'boolean' ? a.degraded : (a.model == null || hasError);
    let text = a.text.trim();
    let reason = hasError ? a.error.trim() : '';
    if (degraded) {
      const m = text.match(AI_SUFFIX_RE);
      if (m) {
        if (!reason) reason = m[0].replace(/^\s*\(AI narrative unavailable:\s*/, '').replace(/\)\s*$/, '').trim();
        text = text.replace(AI_SUFFIX_RE, '').trim();
      }
      return { kind: 'degraded', text, reason, model: null };
    }
    const provider = a.provider || (a.fallbackUsed ? 'groq' : (a.model && /gemini/i.test(a.model) ? 'gemini' : null));
    const kind = provider === 'groq' || a.fallbackUsed ? 'groq' : provider === 'gemini' ? 'gemini' : 'ai';
    return { kind, text, reason: kind === 'groq' && hasError ? a.error.trim() : '', model: str(a.model, '') };
  }

  function currentSeverityKey(engine) {
    const statuses = Object.values(engine.statuses || {});
    const worst = statuses.includes('critical') ? 'critical' : statuses.includes('warning') ? 'warning' : 'nominal';
    return `${worst}|${(engine.activeFault && engine.activeFault.type) || ''}|${(engine.predictedFault && engine.predictedFault.type) || ''}`;
  }

  function pickAnalysis(engine) {
    const a = engine && engine.aiAnalysis;
    const b = engine && state.aiOverride[engine.id];
    if (a && b) return (Number(b.generatedAt) || 0) >= (Number(a.generatedAt) || 0) ? b : a;
    return a || b || null;
  }

  const AI_UI = {
    pending: { tag: 'AI', title: 'Engine Situation Report' },
    gemini: { tag: 'AI', title: 'Engine Situation Report', source: 'GEMINI · LIVE' },
    groq: { tag: 'AI', title: 'Engine Situation Report', source: 'GROQ FALLBACK' },
    ai: { tag: 'AI', title: 'Engine Situation Report', source: 'AI · LIVE' },
    degraded: { tag: 'NO AI', title: 'AI unavailable — rule-based summary', source: 'RULE-BASED · NOT AI' },
  };
  let aiRendered = ''; // signature of what is currently in the DOM (keeps the aria-live text from re-announcing)
  let aiMetaNodes = null;

  function ensureAiMeta() {
    if (aiMetaNodes) return aiMetaNodes;
    const meta = el('aiMeta');
    meta.replaceChildren();
    const mk = (cls) => { const s = document.createElement('span'); if (cls) s.className = cls; meta.appendChild(s); return s; };
    aiMetaNodes = { model: mk('ai-model-tag'), age: mk('ai-age'), sources: mk('') };
    return aiMetaNodes;
  }

  function renderAiAnalysis(engine) {
    const box = el('aiAnalysisBox');
    const textEl = el('aiText');
    const raw = pickAnalysis(engine);
    const view = classifyAnalysis(raw);
    const kind = view ? view.kind : 'pending';
    const ui = AI_UI[kind];
    const nodes = ensureAiMeta();

    const sig = view ? [engine.id, kind, view.text, view.reason, view.model, raw.generatedAt].join('\u0001') : `${engine.id}|pending`;
    if (sig !== aiRendered) {
      aiRendered = sig;
      box.dataset.state = kind;
      setText(el('aiTag'), ui.tag);
      setText(el('aiTitle'), ui.title);

      const source = el('aiSource');
      setHidden(source, !ui.source);
      setText(source, ui.source || '');
      source.className = `ai-source ai-source-${kind}`;
      source.title = kind === 'degraded' ? (view.reason || 'No AI provider produced this text') : kind === 'groq' ? 'Gemini was unavailable; this text came from the fallback provider' : '';

      const banner = el('aiBanner');
      if (kind === 'degraded') {
        banner.textContent = 'No AI provider answered. The text below is an automatic rule-based summary of sensor status, not an AI analysis.';
        banner.title = view.reason;
      } else if (kind === 'groq') {
        banner.textContent = 'Gemini was unavailable. This analysis came from the Groq fallback model.';
        banner.title = view.reason;
      }
      setHidden(banner, kind !== 'degraded' && kind !== 'groq');

      const details = el('aiDetails');
      const showReason = kind === 'degraded' && !!view.reason;
      setHidden(details, !showReason);
      setText(el('aiReason'), showReason ? view.reason : '');
      if (!showReason) details.open = false;

      if (view) {
        textEl.textContent = view.text;
        textEl.className = 'ai-text' + (kind === 'degraded' ? ' ai-fallback-text' : '');
        setText(nodes.model, kind === 'degraded' ? 'rule-based' : (view.model || 'model n/a'));
        const src = raw && Array.isArray(raw.sources) ? raw.sources.filter((s) => typeof s === 'string' && s) : [];
        setText(nodes.sources, src.length ? `${src.length} knowledge source${src.length === 1 ? '' : 's'}` : '');
        nodes.sources.title = src.join('\n');
        setHidden(nodes.sources, src.length === 0);
      } else {
        textEl.textContent = 'Waiting for the first AI analysis…';
        textEl.className = 'ai-text ai-loading';
        setText(nodes.model, '');
        setText(nodes.sources, '');
        setHidden(nodes.sources, true);
      }
      setHidden(nodes.model, !view);
    }
    updateAiAge(engine, raw, view);
  }

  /** Age + stale warning; cheap enough to run every second. */
  function updateAiAge(engine, raw, view) {
    const nodes = ensureAiMeta();
    const staleEl = el('aiStale');
    if (!view) {
      setText(nodes.age, '');
      setHidden(staleEl, true);
      return;
    }
    const gen = Number(raw.generatedAt);
    const age = isNum(gen) && gen > 0 ? Math.max(0, serverNow() - gen) : null;
    setText(nodes.age, age === null ? 'generated: time unknown' : `generated ${fmtAge(age)}`);
    nodes.age.title = age === null ? '' : `as of ${fmtTime(gen)}`;

    let warn = '';
    if (age !== null && age > AI_STALE_MS) {
      warn = `This analysis is ${fmtAge(age).replace(' ago', '')} old and may not reflect the current engine condition.`;
    } else if (raw.severityKey && raw.severityKey !== currentSeverityKey(engine) && (age === null || age > AI_MISMATCH_GRACE_MS)) {
      warn = 'The engine condition has changed since this analysis was generated. A new one is pending.';
    }
    setText(staleEl, warn ? `▲ ${warn}` : '');
    setHidden(staleEl, !warn);
  }

  // "Explain now" button: busy / rate-limit cooldown states
  function updateRefreshButton() {
    const btn = el('aiRefreshBtn');
    const engine = selectedEngine();
    const raw = engine && pickAnalysis(engine);
    let blockedUntil = state.aiBlockedUntil;
    if (raw && isNum(Number(raw.cooldownUntil)) && Number(raw.cooldownUntil) > 0) {
      blockedUntil = Math.max(blockedUntil, Number(raw.cooldownUntil) - state.skew);
    }
    const wait = Math.ceil((blockedUntil - Date.now()) / 1000);
    let label = 'Explain now';
    let disabled = false;
    if (state.aiBusy) { label = 'Analyzing…'; disabled = true; }
    else if (wait > 0) { label = `Retry in ${wait}s`; disabled = true; }
    else if (!engine) disabled = true;
    btn.disabled = disabled;
    setText(btn, label);
    btn.setAttribute('aria-busy', String(state.aiBusy));
  }

  function bindRefreshButton() {
    el('aiRefreshBtn').addEventListener('click', async () => {
      const id = state.selectedEngineId;
      if (!id || state.aiBusy) return;
      state.aiBusy = true;
      updateRefreshButton();
      try {
        const analysis = await apiFetch(`/api/ai-analysis/${encodeURIComponent(id)}/refresh`, { method: 'POST', timeoutMs: REFRESH_TIMEOUT_MS });
        if (analysis && typeof analysis === 'object') {
          state.aiOverride[id] = analysis;
          const view = classifyAnalysis(analysis);
          if (view && view.kind === 'degraded') toast('AI is unavailable right now. Showing the rule-based summary instead.', { kind: 'warn', key: 'ai-degraded' });
          else if (view && view.kind === 'groq') toast('Gemini was unavailable; analysis provided by the Groq fallback.', { kind: 'info', key: 'ai-groq' });
          const engine = selectedEngine();
          if (engine) renderAiAnalysis(engine);
          if (analysis.cooldownUntil && isNum(Number(analysis.cooldownUntil))) state.aiBlockedUntil = Number(analysis.cooldownUntil) - state.skew;
        }
      } catch (err) {
        if (err.retryAfter) state.aiBlockedUntil = Date.now() + err.retryAfter * 1000;
        toast(`Could not refresh the AI analysis: ${err.message}.`, { kind: 'error', key: 'ai-refresh' });
      } finally {
        state.aiBusy = false;
        updateRefreshButton();
      }
    });
  }

  function selectedEngine() {
    const p = state.latest;
    if (!p) return null;
    return p.engines.find((e) => e.id === state.selectedEngineId) || p.engines[0] || null;
  }

  function renderDetail(engine) {
    setText(el('detailTitle'), `${str(engine.tail, 'Engine')} — ${str(engine.engine, 'Engine')}`);
    const status = overallStatus(engine);
    const statusBadge = el('detailStatus');
    statusBadge.className = 'badge ' + (status === 'nominal' ? '' : status);
    setText(statusBadge, STATUS_LABEL[status]);

    renderAiAnalysis(engine);
    renderPredictedFault(engine);
    if (window.twin3d && window.twin3d.update) {
      try { window.twin3d.update(engine); } catch (err) { console.error('[twin3d] update failed', err); }
    }
  }

  // ---------------- Alerts (keyed diff: no flicker, scroll + focus preserved) ----------------
  const SEV = {
    critical: { glyph: '✖', label: 'CRITICAL' },
    warning: { glyph: '▲', label: 'WARNING' },
    info: { glyph: '●', label: 'INFO' },
  };
  const alertNodes = new Map(); // key -> node
  let alertKeys = [];
  let alertsPrimed = false;
  const alertKey = (a) => `${a.id === undefined ? '' : a.id}|${a.tail}|${a.time}|${a.message}`;

  function makeAlertNode(a, isNew) {
    const sev = SEV[a.severity] ? a.severity : 'info';
    const item = document.createElement('div');
    item.className = `alert-item ${sev}${isNew ? ' is-new' : ''}`;
    item.setAttribute('role', 'listitem');
    const top = document.createElement('div');
    top.className = 'a-top';
    const tail = document.createElement('span');
    tail.className = 'a-tail';
    tail.textContent = str(a.tail, 'Engine');
    const sevEl = document.createElement('span');
    sevEl.className = 'a-sev';
    sevEl.textContent = `${SEV[sev].glyph} ${SEV[sev].label}`;
    const time = document.createElement('span');
    time.textContent = fmtTime(a.time);
    top.append(tail, sevEl, time);
    const msg = document.createElement('div');
    msg.className = 'a-msg';
    msg.textContent = str(a.message, 'No details');
    item.append(top, msg);
    return item;
  }

  function renderAlerts(payload) {
    const list = el('alertsList');
    const all = payload.engines.flatMap((e) => (Array.isArray(e.alerts) ? e.alerts : []).filter((a) => a && typeof a === 'object'));
    const alerts = all.sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)).slice(0, 25);

    if (alerts.length === 0) {
      alertNodes.clear();
      alertKeys = [];
      alertsPrimed = true;
      list.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'alerts-empty';
      empty.textContent = 'No alerts yet — all systems nominal.';
      list.appendChild(empty);
      return;
    }

    const keys = alerts.map(alertKey);
    if (keys.length === alertKeys.length && keys.every((k, i) => k === alertKeys[i])) return;

    const nextNodes = new Map();
    const announceCritical = [];
    const announceWarn = [];
    alerts.forEach((a, i) => {
      const k = keys[i];
      let node = alertNodes.get(k);
      if (!node) {
        node = makeAlertNode(a, alertsPrimed);
        if (alertsPrimed) {
          if (a.severity === 'critical') announceCritical.push(a);
          else if (a.severity === 'warning') announceWarn.push(a);
        }
      }
      nextNodes.set(k, node);
    });
    alertNodes.clear();
    nextNodes.forEach((n, k) => alertNodes.set(k, n));
    list.replaceChildren(...alertNodes.values());
    alertKeys = keys;
    alertsPrimed = true;

    if (!state.stale) {
      if (announceCritical.length) announce('srCritical', announceCritical.slice(0, 3).map((a) => `Critical alert, ${str(a.tail, 'engine')}: ${str(a.message, '')}`).join('. '));
      else if (announceWarn.length) announce('srStatus', announceWarn.slice(0, 3).map((a) => `Warning, ${str(a.tail, 'engine')}: ${str(a.message, '')}`).join('. '));
    }
  }

  /** Screen-reader announcement; clearing first makes repeated identical text announce again. */
  function announce(regionId, message) {
    const region = el(regionId);
    if (!region) return;
    region.textContent = '';
    setTimeout(() => { region.textContent = message; }, 60);
  }

  // ---------------- Charts ----------------
  function ensureCharts() {
    if (state.charts.temp || !window.DTCharts) return;
    state.charts.temp = window.DTCharts.create(el('chartTemp'), {
      title: 'Cylinder head and exhaust gas temperature',
      series: [
        { label: 'CHT °C', axis: 'left', color: '#ffb700', fill: 'rgba(255,183,0,0.08)' },
        { label: 'EGT °C', axis: 'right', color: '#ff5a48', fill: 'rgba(255,68,51,0.06)', dash: [6, 4] },
      ],
    });
    state.charts.oilVib = window.DTCharts.create(el('chartOilVib'), {
      title: 'Oil pressure and vibration',
      series: [
        { label: 'Oil Pressure (psi)', short: 'Oil psi', axis: 'left', color: '#38bdf8', fill: 'rgba(56,189,248,0.08)' },
        { label: 'Vibration (mm/s)', short: 'Vib mm/s', axis: 'right', color: '#34d399', fill: 'rgba(52,211,153,0.08)', dash: [6, 4] },
      ],
    });
  }

  /** Every engine gets its own bounded history so switching engines shows real trends. */
  function recordHistory(payload) {
    payload.engines.forEach((engine) => {
      const h = state.history[engine.id] || (state.history[engine.id] = { labels: [], v: [[], [], [], []] });
      const r = engine.readings || {};
      h.labels.push(fmtTime(engine.time !== undefined ? engine.time : (isNum(payload.serverTime) ? payload.serverTime : Date.now())));
      [r.cht, r.egt, r.oilPressure, r.vibration].forEach((val, i) => h.v[i].push(isNum(val) ? val : NaN));
      if (h.labels.length > CHART_POINTS) {
        h.labels.shift();
        h.v.forEach((arr) => arr.shift());
      }
    });
    const live = new Set(payload.engines.map((e) => e.id));
    Object.keys(state.history).forEach((id) => { if (!live.has(id)) delete state.history[id]; });
  }

  function renderCharts(engine) {
    ensureCharts();
    const h = state.history[engine.id] || { labels: [], v: [[], [], [], []] };
    if (state.charts.temp) state.charts.temp.setData(h.labels, [h.v[0], h.v[1]]);
    if (state.charts.oilVib) state.charts.oilVib.setData(h.labels, [h.v[2], h.v[3]]);
  }

  // ---------------- Main render ----------------
  function render({ fresh = true } = {}) {
    const payload = state.latest;
    if (!payload) return;
    if (!payload.engines.some((e) => e.id === state.selectedEngineId)) state.selectedEngineId = payload.engines[0].id;
    const engine = selectedEngine();

    setHidden(el('enginesEmpty'), true);
    renderFleetSummary(payload);
    renderEngineCards(payload);
    renderDetail(engine);
    renderAlerts(payload);
    if (fresh) recordHistory(payload);
    renderCharts(engine);
    updateRefreshButton();
  }

  // ---------------- Snapshot ingestion + freshness ----------------
  function validSnapshot(p) {
    return p && typeof p === 'object' && Array.isArray(p.engines) && p.engines.length > 0
      && p.engines.every((e) => e && typeof e === 'object' && typeof e.id === 'string');
  }

  function ingest(payload) {
    if (!validSnapshot(payload)) throw new ApiError('Received a malformed telemetry snapshot');
    const recv = Date.now();
    if (isNum(payload.serverTime)) {
      // Ignore replays / out-of-order deliveries (e.g. a cached REST response while the tick loop is stalled).
      if (state.lastServerTime !== null && payload.serverTime <= state.lastServerTime) return false;
      state.lastServerTime = payload.serverTime;
      const sample = payload.serverTime - recv;
      state.skewSamples.push(sample);
      if (state.skewSamples.length > 10) state.skewSamples.shift();
      const best = Math.max(...state.skewSamples); // lowest-latency sample ~ true clock offset
      state.skew = best;
      state.lagMs = Math.max(0, best - sample);
    } else {
      state.lagMs = 0;
    }
    state.lastFreshAt = performance.now();
    state.latest = payload;
    evaluateHealth();
    render({ fresh: true });
    return true;
  }

  let snapshotInflight = null;
  /** REST resync (initial load, reconnect, tab re-shown, manual retry, polling fallback). */
  function fetchSnapshot({ quiet = false } = {}) {
    if (snapshotInflight) return snapshotInflight;
    snapshotInflight = apiFetch('/api/snapshot')
      .then((payload) => ingest(payload))
      .catch((err) => {
        if (!quiet) toast(`Telemetry request failed: ${err.message}.`, { kind: 'error', key: 'snapshot-fail', cooldownMs: 30000 });
        throw err;
      })
      .finally(() => { snapshotInflight = null; });
    snapshotInflight.catch(() => {}); // callers that ignore the result must not raise unhandled rejections
    return snapshotInflight;
  }

  // ---------------- Connection status + REST fallback polling ----------------
  const CONN_TEXT = {
    connecting: 'Connecting…',
    connected: 'Live telemetry connected',
    reconnecting: 'Reconnecting…',
    offline: 'Offline',
  };
  function refreshConn() {
    let next;
    if (state.socketConnected) next = 'connected';
    else if (typeof navigator !== 'undefined' && navigator.onLine === false) next = 'offline';
    else if (!state.everConnected && performance.now() - state.startedAt < 8000) next = 'connecting';
    else if (state.disconnectedAt && performance.now() - state.disconnectedAt > 20000) next = 'offline';
    else next = 'reconnecting';
    if (next === state.conn && el('connStatus').dataset.state === next) return;
    const prev = state.conn;
    state.conn = next;
    const box = el('connStatus');
    box.dataset.state = next;
    box.classList.remove('online', 'offline');
    if (next === 'connected') box.classList.add('online');
    else if (next === 'offline') box.classList.add('offline');
    setText(box.querySelector('.conn-text'), CONN_TEXT[next]);
    if (prev !== next && next !== 'connecting') announce('srStatus', `Connection status: ${CONN_TEXT[next]}`);
  }

  let pollTimer = 0;
  let pollDelay = TICK_MS;
  function startPolling() {
    if (pollTimer) return;
    const step = () => {
      pollTimer = 0;
      if (state.socketConnected) return; // socket is back; stop
      fetchSnapshot({ quiet: true }).then(() => { pollDelay = TICK_MS; }, () => { pollDelay = Math.min(pollDelay * 1.5, 10000); })
        .finally(() => { if (!state.socketConnected && !pollTimer) pollTimer = setTimeout(step, pollDelay); });
    };
    pollTimer = setTimeout(step, 1000);
  }
  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = 0;
    pollDelay = TICK_MS;
  }

  // ---------------- Staleness banner ----------------
  const STALE_TEXT = {
    none: 'NO TELEMETRY — waiting for the first data from the server',
    link: 'TELEMETRY STALE — connection lost. Values may be out of date',
    stalled: 'TELEMETRY STALE — the server has stopped sending updates. Values may be out of date',
    lag: 'TELEMETRY DELAYED — data is arriving late. Values may be out of date',
  };
  const BASE_TITLE = document.title;

  function evaluateHealth() {
    const now = performance.now();
    refreshConn();
    // Background tabs get throttled timers/delivery, which would raise false alarms; re-evaluated on return.
    if (document.hidden || now < state.graceUntil) return;
    let reason = null;
    if (!state.latest) {
      if (now - state.startedAt > STALE_MS) reason = 'none';
    } else if (now - state.lastFreshAt > STALE_MS) {
      reason = state.socketConnected ? 'stalled' : 'link';
    } else if (state.lagMs > STALE_MS) {
      reason = 'lag';
    }

    const banner = el('staleBanner');
    if (reason) {
      const ageMs = state.latest ? now - state.lastFreshAt : now - state.startedAt;
      setText(el('staleAge'), state.latest ? `last data ${fmtAge(ageMs + 1000)}` : '');
      if (reason !== state.stale) {
        setText(el('staleText'), STALE_TEXT[reason]);
        setHidden(banner, false);
      }
    } else if (state.stale) {
      setHidden(banner, true);
      announce('srStatus', 'Telemetry restored');
    }
    if (reason !== state.stale) {
      state.stale = reason;
      const dim = !!reason && reason !== 'none';
      document.body.classList.toggle('is-stale', dim);
      document.title = dim ? `▲ STALE · ${BASE_TITLE}` : BASE_TITLE;
      if (window.twin3d && window.twin3d.setStale) window.twin3d.setStale(dim);
    }

    // live badge in the alert log header
    const dot = el('liveDot');
    const liveState = reason && reason !== 'none' ? 'stale' : (state.socketConnected || !state.latest ? 'live' : 'poll');
    dot.dataset.state = liveState;
    setText(dot, liveState === 'stale' ? '▲ STALE' : liveState === 'poll' ? '● POLLING' : '● LIVE');
    setText(el('statLinkSub'), !state.latest ? 'awaiting telemetry link' : liveState === 'stale' ? 'telemetry stale' : liveState === 'poll' ? 'polling (no websocket)' : 'live telemetry link');
  }

  // ---------------- Housekeeping (1 Hz): clock, freshness, AI age, cooldowns ----------------
  function housekeeping() {
    el('clock').textContent = fmtTime(Date.now());
    evaluateHealth();
    const engine = selectedEngine();
    if (engine) {
      const raw = pickAnalysis(engine);
      updateAiAge(engine, raw, classifyAnalysis(raw));
    }
    updateRefreshButton();
  }
  const housekeepingTimer = setInterval(housekeeping, 1000);
  housekeeping();

  // ---------------- Socket.IO wiring ----------------
  const socket = typeof io === 'function' ? io({ reconnectionDelay: 1000, reconnectionDelayMax: 5000, timeout: 5000 }) : null;

  if (socket) {
    socket.on('connect', () => {
      state.socketConnected = true;
      state.everConnected = true;
      state.disconnectedAt = 0;
      stopPolling();
      refreshConn();
      fetchSnapshot({ quiet: true }).catch(() => {}); // resync after (re)connect; the server also pushes one
    });
    const onDown = () => {
      if (state.socketConnected || !state.disconnectedAt) state.disconnectedAt = performance.now();
      state.socketConnected = false;
      refreshConn();
      startPolling();
    };
    socket.on('disconnect', onDown);
    socket.on('connect_error', onDown);
    socket.io.on('reconnect_attempt', () => { refreshConn(); });

    socket.on('snapshot', (payload) => {
      try { ingest(payload); } catch (err) { console.error('[dashboard] bad snapshot', err); toast('Ignored a malformed telemetry update.', { kind: 'warn', key: 'bad-snapshot', cooldownMs: 30000 }); }
    });

    // Pushed as soon as a fresh analysis finishes for an engine, usually between
    // telemetry ticks, so patch it in and re-render immediately.
    socket.on('ai-analysis', (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.engineId !== 'string') return;
      const { engineId, ...analysis } = msg;
      state.aiOverride[engineId] = analysis;
      const engine = selectedEngine();
      if (engine && engine.id === engineId) renderAiAnalysis(engine);
    });
  } else {
    state.disconnectedAt = performance.now();
    toast('Live streaming is unavailable (Socket.IO client failed to load). Falling back to polling.', { kind: 'warn', key: 'no-socket' });
    startPolling();
  }

  // Initial load over REST too, so the page fills quickly and works if websockets are blocked.
  fetchSnapshot({ quiet: true }).catch(() => {});

  el('staleRetry').addEventListener('click', () => {
    if (socket && !socket.connected) socket.connect();
    fetchSnapshot().catch(() => {});
  });

  bindRefreshButton();

  // Browsers throttle hidden tabs; resync as soon as the tab is visible again.
  const onVisibility = () => {
    if (document.hidden) return;
    state.graceUntil = performance.now() + TICK_MS * 1.5;
    if (!state.latest || performance.now() - state.lastFreshAt > TICK_MS * 2) fetchSnapshot({ quiet: true }).catch(() => {});
    housekeeping();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', () => { if (socket && !socket.connected) socket.connect(); fetchSnapshot({ quiet: true }).catch(() => {}); refreshConn(); });
  window.addEventListener('offline', refreshConn);

  // If the 3D module never starts (vendor files missing, module error), say so instead of "Loading…" forever.
  setTimeout(() => {
    const loading = el('twinLoading');
    if (loading && !window.twin3d) loading.textContent = '3D twin failed to load. Sensor readouts and charts are unaffected.';
  }, 12000);

  // ---------------- Teardown ----------------
  function teardown() {
    clearInterval(housekeepingTimer);
    stopPolling();
    document.removeEventListener('visibilitychange', onVisibility);
    if (socket) socket.close();
    Object.values(state.charts).forEach((c) => c.destroy());
    state.charts = {};
    toastActive.forEach((t) => clearTimeout(t.timer));
  }
  window.addEventListener('pagehide', (e) => { if (!e.persisted) teardown(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); }); // bfcache restore: sockets/timers are gone
})();
