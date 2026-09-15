/**
 * app.js — dashboard client logic.
 * Connects to the Socket.IO stream for live (spoofed) telemetry and
 * renders fleet stats, the live engine diagram, trend charts and the
 * fault-prediction alert feed. Falls back to REST polling if the
 * websocket connection is ever unavailable.
 */
(function () {
  'use strict';

  // Mirrors simulator.js SENSORS — label/unit text for the engine diagram's
  // hover tooltips (the nominal/warning/critical *status* itself always
  // comes from the backend payload, never recomputed client-side).
  const SENSOR_META = {
    rpm: { label: 'Engine Speed', unit: 'RPM' },
    cht: { label: 'Cylinder Head Temp', unit: '°C' },
    egt: { label: 'Exhaust Gas Temp', unit: '°C' },
    oilPressure: { label: 'Oil Pressure', unit: 'psi' },
    oilTemp: { label: 'Oil Temperature', unit: '°C' },
    fuelFlow: { label: 'Fuel Flow', unit: 'L/h' },
    vibration: { label: 'Vibration', unit: 'mm/s' },
    manifoldPressure: { label: 'Manifold Pressure', unit: 'kPa' },
    batteryVoltage: { label: 'Battery Voltage', unit: 'V' },
  };

  const state = {
    selectedEngineId: null,
    latest: null,
    charts: {},
  };

  const el = (id) => document.getElementById(id);

  // ---------------- Clock ----------------
  function tickClock() {
    el('clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ---------------- Connection status ----------------
  function setConnStatus(online) {
    const box = el('connStatus');
    box.classList.remove('online', 'offline');
    box.classList.add(online ? 'online' : 'offline');
    box.querySelector('.conn-text').textContent = online ? 'Live telemetry connected' : 'Reconnecting…';
  }

  // ---------------- Rendering ----------------
  function renderFleetSummary(payload) {
    const { fleet } = payload;
    el('statReliability').textContent = fleet.missionReliability + '%';
    el('statReliabilityBar').style.width = fleet.missionReliability + '%';
    el('statHealth').textContent = fleet.avgHealth + '%';
    el('statHealthBar').style.width = fleet.avgHealth + '%';
    el('statCritical').textContent = fleet.criticalCount;
    el('statEngines').textContent = fleet.engineCount;
  }

  function overallStatus(engine) {
    const statuses = Object.values(engine.statuses);
    if (statuses.includes('critical')) return 'critical';
    if (statuses.includes('warning')) return 'warning';
    return 'nominal';
  }

  function ringColor(status) {
    return status === 'critical' ? 'var(--critical)' : status === 'warning' ? 'var(--warning)' : 'var(--nominal)';
  }

  function renderEngineCards(payload) {
    const container = el('engineCards');
    container.innerHTML = '';
    payload.engines.forEach((engine) => {
      const status = overallStatus(engine);
      const card = document.createElement('div');
      card.className = 'engine-card' + (engine.id === state.selectedEngineId ? ' selected' : '');
      card.onclick = () => { state.selectedEngineId = engine.id; render(); };
      card.innerHTML = `
        <div class="ring" style="--pct:${engine.health}; --ring-color:${ringColor(status)}"><span>${engine.health}</span></div>
        <div class="engine-card-body">
          <h3>${engine.tail}</h3>
          <p>${engine.engine} · ${engine.hoursFlown.toFixed(1)} hrs</p>
          <span class="engine-status-badge status-${status}">${status.toUpperCase()}</span>
        </div>`;
      container.appendChild(card);
    });
  }

  function renderEngineDiagram(engine) {
    Object.entries(SENSOR_META).forEach(([key, meta]) => {
      const nodes = document.querySelectorAll('[data-part="' + key + '"]');
      const status = engine.statuses[key];
      nodes.forEach((g) => {
        g.classList.remove('status-nominal', 'status-warning', 'status-critical');
        g.classList.add('status-' + status);
        const titleEl = g.querySelector('title');
        if (titleEl) {
          titleEl.textContent = `${meta.label}: ${engine.readings[key]} ${meta.unit} — ${status.toUpperCase()}`;
        }
      });
    });
  }

  function renderPredictedFault(engine) {
    const box = el('predictedFaultBox');
    if (!engine.predictedFault && !engine.activeFault) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (engine.activeFault) {
      el('pfTitle').textContent = `Active condition: ${engine.activeFault.label}`;
      el('pfSub').textContent = 'Simulated fault scenario currently in progress on this engine.';
      el('pfConfidence').textContent = '';
    } else {
      el('pfTitle').textContent = `AI Prediction: ${engine.predictedFault.label}`;
      el('pfSub').textContent = 'Statistical anomaly + threshold model flags elevated risk before failure.';
      el('pfConfidence').textContent = engine.predictedFault.confidence + '%';
    }
  }

  // ---------------- AI engine situation report ----------------
  // `engine.aiAnalysis` rides along on every snapshot (cached server-side
  // from the last Gemini/RAG pass for that engine); the `ai-analysis`
  // socket event (below) additionally pushes a fresh one in as soon as
  // it's generated, without waiting for the next 2s telemetry tick.
  function renderAiAnalysis(engine) {
    const textEl = el('aiText');
    const metaEl = el('aiMeta');
    const analysis = engine.aiAnalysis;

    if (!analysis) {
      textEl.textContent = 'Waiting for the first AI analysis…';
      textEl.className = 'ai-text ai-loading';
      metaEl.textContent = '';
      return;
    }

    textEl.textContent = analysis.text;
    textEl.className = 'ai-text' + (analysis.error ? ' ai-error' : '');

    const when = new Date(analysis.generatedAt).toLocaleTimeString('en-IN', { hour12: false });
    const modelTag = analysis.model ? `<span class="ai-model-tag">${analysis.model}</span>` : '<span class="ai-model-tag">fallback</span>';
    metaEl.innerHTML = `${modelTag}<span>as of ${when}</span>`;
  }

  function setAiButtonBusy(busy) {
    const btn = el('aiRefreshBtn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Analyzing…' : 'Explain now';
  }

  el('aiRefreshBtn').addEventListener('click', () => {
    if (!state.selectedEngineId) return;
    setAiButtonBusy(true);
    fetch(`/api/ai-analysis/${state.selectedEngineId}/refresh`, { method: 'POST' })
      .then((r) => r.json())
      .then((analysis) => {
        if (state.latest) {
          const engine = state.latest.engines.find((e) => e.id === state.selectedEngineId);
          if (engine) engine.aiAnalysis = analysis;
        }
        if (state.selectedEngineId) renderAiAnalysis({ aiAnalysis: analysis });
      })
      .catch(() => {})
      .finally(() => setAiButtonBusy(false));
  });

  function renderDetail(engine) {
    el('detailTitle').textContent = `${engine.tail} — ${engine.engine}`;
    const status = overallStatus(engine);
    const statusBadge = el('detailStatus');
    statusBadge.textContent = status.toUpperCase();
    statusBadge.className = 'badge ' + (status === 'nominal' ? '' : status);

    renderAiAnalysis(engine);
    renderPredictedFault(engine);
    renderEngineDiagram(engine);
  }

  function renderAlerts(payload) {
    const list = el('alertsList');
    const alerts = payload.engines.flatMap((e) => e.alerts).sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 25);
    if (alerts.length === 0) {
      list.innerHTML = '<div class="alerts-empty">No alerts yet — all systems nominal.</div>';
      return;
    }
    list.innerHTML = alerts.map((a) => `
      <div class="alert-item ${a.severity}">
        <div class="a-top"><span class="a-tail">${a.tail}</span><span>${new Date(a.time).toLocaleTimeString('en-IN', { hour12: false })}</span></div>
        <div class="a-msg">${a.message}</div>
      </div>`).join('');
  }

  // ---------------- Charts ----------------
  // Each chart pairs two sensors with very different magnitudes (e.g. CHT
  // ~100-170°C vs EGT ~650-820°C), so each dataset gets its own y-axis
  // (left = y, right = y1) rather than sharing one scale — otherwise the
  // smaller-magnitude line flattens out near the bottom of the chart.
  function makeChart(ctx, datasets) {
    return new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets },
      options: {
        animation: false,
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { display: false },
          y: {
            position: 'left',
            grid: { color: 'rgba(255, 255, 255, 0.06)' },
            ticks: { color: datasets[0].borderColor, font: { size: 10, family: "'JetBrains Mono', monospace" } },
          },
          y1: {
            position: 'right',
            grid: { display: false },
            ticks: { color: datasets[1].borderColor, font: { size: 10, family: "'JetBrains Mono', monospace" } },
          },
        },
        plugins: {
          legend: {
            labels: { color: '#93949c', boxWidth: 10, font: { size: 11, family: "'JetBrains Mono', monospace" } },
          },
        },
        elements: { point: { radius: 0 }, line: { tension: 0.35, borderWidth: 2 } },
      },
    });
  }

  function ensureCharts() {
    if (state.charts.temp) return;
    state.charts.temp = makeChart(el('chartTemp').getContext('2d'), [
      { label: 'CHT °C', data: [], borderColor: '#ffb700', backgroundColor: 'rgba(255,183,0,0.08)', fill: true, yAxisID: 'y' },
      { label: 'EGT °C', data: [], borderColor: '#ff4433', backgroundColor: 'rgba(255,68,51,0.06)', fill: true, yAxisID: 'y1' },
    ]);
    state.charts.oilVib = makeChart(el('chartOilVib').getContext('2d'), [
      { label: 'Oil Pressure (psi)', data: [], borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', fill: true, yAxisID: 'y' },
      { label: 'Vibration (mm/s)', data: [], borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.08)', fill: true, yAxisID: 'y1' },
    ]);
  }

  function pushChartPoint(engine) {
    ensureCharts();
    const label = new Date(engine.time).toLocaleTimeString('en-IN', { hour12: false });
    [state.charts.temp, state.charts.oilVib].forEach((c) => {
      c.data.labels.push(label);
      if (c.data.labels.length > 40) c.data.labels.shift();
    });
    const t = state.charts.temp;
    t.data.datasets[0].data.push(engine.readings.cht);
    t.data.datasets[1].data.push(engine.readings.egt);
    if (t.data.datasets[0].data.length > 40) { t.data.datasets[0].data.shift(); t.data.datasets[1].data.shift(); }
    t.update('none');

    const o = state.charts.oilVib;
    o.data.datasets[0].data.push(engine.readings.oilPressure);
    o.data.datasets[1].data.push(engine.readings.vibration);
    if (o.data.datasets[0].data.length > 40) { o.data.datasets[0].data.shift(); o.data.datasets[1].data.shift(); }
    o.update('none');
  }

  // ---------------- Main render ----------------
  function render() {
    const payload = state.latest;
    if (!payload) return;
    if (!state.selectedEngineId) state.selectedEngineId = payload.engines[0].id;
    const engine = payload.engines.find((e) => e.id === state.selectedEngineId) || payload.engines[0];

    renderFleetSummary(payload);
    renderEngineCards(payload);
    renderDetail(engine);
    renderAlerts(payload);
    pushChartPoint(engine);
  }

  // ---------------- Socket.IO wiring ----------------
  const socket = io({ reconnectionDelay: 1000, timeout: 5000 });

  socket.on('connect', () => setConnStatus(true));
  socket.on('disconnect', () => setConnStatus(false));
  socket.on('connect_error', () => setConnStatus(false));

  socket.on('snapshot', (payload) => {
    state.latest = payload;
    render();
  });

  // Pushed as soon as a fresh Gemini/RAG analysis finishes for an engine —
  // usually lands between telemetry ticks, so patch it in and re-render
  // immediately rather than waiting for the next `snapshot` event.
  socket.on('ai-analysis', ({ engineId, ...analysis }) => {
    if (!state.latest) return;
    const engine = state.latest.engines.find((e) => e.id === engineId);
    if (!engine) return;
    engine.aiAnalysis = analysis;
    if (engineId === state.selectedEngineId) renderAiAnalysis(engine);
  });

  // REST fallback in case sockets never connect (proxies/firewalls, etc.)
  let usedFallback = false;
  setTimeout(() => {
    if (!state.latest) {
      usedFallback = true;
      pollRest();
    }
  }, 4000);

  function pollRest() {
    fetch('/api/snapshot').then((r) => r.json()).then((payload) => {
      state.latest = payload;
      render();
    }).catch(() => {});
    if (usedFallback) setTimeout(pollRest, 2000);
  }
})();
