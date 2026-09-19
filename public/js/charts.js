/**
 * charts.js — tiny self-hosted dual-axis line chart (canvas 2D).
 *
 * Replaces the Chart.js CDN dependency so the dashboard works offline and
 * under a strict same-origin CSP. Each series is bound to the left or right
 * y-axis (CHT ~100-170 °C vs EGT ~650-820 °C need separate scales), the
 * second series is dashed so the lines are distinguishable without colour,
 * and hovering shows the values at that sample. Data is capped by the caller.
 */
(function () {
  'use strict';

  const MUTED = '#93949c';
  const GRID = 'rgba(255, 255, 255, 0.06)';
  const PAD = { l: 44, r: 44, t: 26, b: 8 };

  function fmt(v) {
    if (!Number.isFinite(v)) return '--';
    const a = Math.abs(v);
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  function create(canvas, config) {
    const ctx = canvas.getContext('2d');
    const series = config.series;
    let labels = [];
    let values = series.map(() => []);
    let hover = -1;
    let w = 0;
    let h = 0;
    let raf = 0;

    const font = (px, weight) => `${weight || 400} ${px}px ${getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace'}`;

    function axisRange(side) {
      let lo = Infinity;
      let hi = -Infinity;
      series.forEach((s, i) => {
        if (s.axis !== side) return;
        values[i].forEach((v) => { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
      });
      if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
      const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
      return { lo: lo - pad, hi: hi + pad };
    }

    function draw() {
      raf = 0;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      const pw = w - PAD.l - PAD.r;
      const ph = h - PAD.t - PAD.b;
      if (pw <= 0 || ph <= 0) return;
      const n = labels.length;
      const ranges = { left: axisRange('left'), right: axisRange('right') };
      const X = (i) => PAD.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
      const Y = (v, side) => PAD.t + ph - ((v - ranges[side].lo) / (ranges[side].hi - ranges[side].lo)) * ph;

      // grid + axis ticks (left tick values drive the grid, right ticks align to it)
      ctx.font = font(10);
      ctx.textBaseline = 'middle';
      for (let t = 0; t <= 3; t++) {
        const y = PAD.t + (ph * t) / 3;
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD.l, y + 0.5);
        ctx.lineTo(w - PAD.r, y + 0.5);
        ctx.stroke();
        for (const side of ['left', 'right']) {
          const r = ranges[side];
          const s = series.find((x) => x.axis === side);
          ctx.fillStyle = s ? s.color : MUTED;
          ctx.textAlign = side === 'left' ? 'right' : 'left';
          ctx.fillText(fmt(r.hi - ((r.hi - r.lo) * t) / 3), side === 'left' ? PAD.l - 6 : w - PAD.r + 6, y);
        }
      }

      if (n === 0) {
        ctx.fillStyle = MUTED;
        ctx.textAlign = 'center';
        ctx.font = font(11);
        ctx.fillText('Waiting for telemetry…', w / 2, PAD.t + ph / 2);
      }

      // lines
      series.forEach((s, si) => {
        const pts = values[si];
        ctx.save();
        ctx.beginPath();
        ctx.rect(PAD.l, PAD.t - 4, pw, ph + 8);
        ctx.clip();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(s.dash || []);
        ctx.lineJoin = 'round';
        let started = false;
        let lastX = 0;
        let firstX = 0;
        ctx.beginPath();
        pts.forEach((v, i) => {
          if (!Number.isFinite(v)) { started = false; return; }
          const x = X(i);
          const y = Y(v, s.axis);
          if (!started) { ctx.moveTo(x, y); started = true; firstX = x; } else ctx.lineTo(x, y);
          lastX = x;
        });
        ctx.stroke();
        if (s.fill && started) {
          ctx.setLineDash([]);
          ctx.lineTo(lastX, PAD.t + ph);
          ctx.lineTo(firstX, PAD.t + ph);
          ctx.closePath();
          ctx.fillStyle = s.fill;
          ctx.fill();
        }
        ctx.restore();
      });

      // hover crosshair
      if (hover >= 0 && hover < n) {
        const x = X(hover);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, PAD.t);
        ctx.lineTo(x + 0.5, PAD.t + ph);
        ctx.stroke();
        series.forEach((s, si) => {
          const v = values[si][hover];
          if (!Number.isFinite(v)) return;
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(x, Y(v, s.axis), 3.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // legend (doubles as the value read-out: latest, or hovered sample)
      const idx = hover >= 0 && hover < n ? hover : n - 1;
      ctx.font = font(11);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let lx = PAD.l;
      series.forEach((s) => {
        const si = series.indexOf(s);
        const v = idx >= 0 ? values[si][idx] : NaN;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(s.dash || []);
        ctx.beginPath();
        ctx.moveTo(lx, 11);
        ctx.lineTo(lx + 16, 11);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = MUTED;
        const text = `${w < 440 && s.short ? s.short : s.label} ${fmt(v)}`;
        ctx.fillText(text, lx + 21, 11);
        lx += 21 + ctx.measureText(text).width + 16;
      });
    }

    function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      w = Math.round(rect.width);
      h = Math.round(rect.height);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    }

    function onMove(e) {
      const n = labels.length;
      if (!n) return;
      const rect = canvas.getBoundingClientRect();
      const frac = (e.clientX - rect.left - PAD.l) / Math.max(1, w - PAD.l - PAD.r);
      const i = Math.round(frac * (n - 1));
      hover = i >= 0 && i < n ? i : -1;
      schedule();
    }
    function onLeave() { hover = -1; schedule(); }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas); else window.addEventListener('resize', resize);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    resize();

    return {
      /** labels: string[]; data: number[][] (one array per series, aligned to labels). */
      setData(nextLabels, nextValues) {
        labels = nextLabels;
        values = nextValues;
        if (hover >= labels.length) hover = -1;
        canvas.setAttribute('aria-label', `${config.title}: ` + (labels.length
          ? series.map((s, i) => `${s.label} ${fmt(nextValues[i][labels.length - 1])}`).join(', ') + `, last ${labels.length} samples`
          : 'no data yet'));
        schedule();
      },
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerleave', onLeave);
      },
    };
  }

  window.DTCharts = { create };
})();
