/**
 * twin3d.js — 3D digital twin of the aero piston engine.
 *
 * A procedural, horizontally-opposed six-cylinder engine (modelled on
 * public/img/engine-photo.png) whose moving parts and surface state are
 * driven by the same live telemetry the rest of the dashboard uses:
 *
 *   rpm              -> crankshaft / propeller angular speed (slow-motion scaled)
 *   cht              -> cylinder barrel + head thermal glow
 *   egt              -> exhaust header glow
 *   vibration        -> whole-engine shake amplitude
 *   fuelFlow / MAP   -> fuel + intake flow particle density and speed
 *   oilPressure      -> oil circuit flow speed
 *   every sensor     -> nominal / warning / critical status glow on its component
 *
 * Status (nominal/warning/critical) always comes from the backend payload;
 * the SENSORS bands fetched from /api/meta are used only to scale visuals.
 *
 * Kinematics are real: piston pin position follows the slider-crank
 * equation s = r*cos(phi) + sqrt(l^2 - r^2*sin^2(phi)), connecting rods are
 * solved between the crank pin and piston pin every frame, and the crank
 * throws are phased so opposed pistons mirror each other (boxer layout).
 *
 * Coordinates: crank axis = X (propeller at +X), up = Y, banks along +/-Z.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- config
const STATION_X = [-1.05, 0, 1.05]; // cylinder stations along the crank
const BOXER_OFFSET = 0.12; // opposed cylinders are staggered by one rod width
const THROW_ANGLE = [0, (4 * Math.PI) / 3, (2 * Math.PI) / 3]; // 120 deg throws
const THROW_R = 0.22;
const ROD_L = 0.85;
const CRANK_PLANE_PIN_HALF = 0.075;

const PARTS = {
  cht: { num: 1, name: 'Cylinder Heads', blurb: 'Finned barrels and heads. Colour follows cylinder head temperature — the classic early-warning for detonation, lean running or cooling-airflow loss.' },
  egt: { num: 2, name: 'Exhaust Headers', blurb: 'Header pipes and collectors. Glow follows exhaust gas temperature, a direct view of mixture strength and combustion quality.' },
  oilPressure: { num: 3, name: 'Oil Sump / Pump', blurb: 'Wet sump, pump and filter. Low pressure means bearings are at risk — the fastest way to lose an engine.' },
  oilTemp: { num: 4, name: 'Oil Cooler', blurb: 'Finned radiator on the oil circuit. Rising oil temperature with steady pressure points at cooling, not lubrication.' },
  fuelFlow: { num: 5, name: 'Fuel Servo / Fuel Line', blurb: 'Fuel servo, inlet duct and supply line. Flow that falls while power is demanded indicates starvation or a restricted line.' },
  manifoldPressure: { num: 6, name: 'Intake Manifold', blurb: 'Plenum and runners feeding each cylinder. Manifold pressure is the engine’s load signal; leaks pull it down.' },
  vibration: { num: 7, name: 'Crankcase', blurb: 'Split aluminium crankcase and accessory case. Vibration here is the earliest sign of imbalance, a loose mount or a failing bearing.' },
  rpm: { num: 8, name: 'Propeller / Crankshaft', blurb: 'Crankshaft, pistons, flange and propeller. Shown in slow motion — real shaft speed would alias on screen.' },
  batteryVoltage: { num: 9, name: 'Alternator / Electrical', blurb: 'Belt-driven alternator feeding the bus. Sagging voltage under load means charging-system failure.' },
};
const PART_ORDER = Object.keys(PARTS);

const STATUS_RGB = {
  nominal: new THREE.Color(0x34d399),
  warning: new THREE.Color(0xffb700),
  critical: new THREE.Color(0xff3b30),
};

// ---------------------------------------------------------------- state
const S = {
  sensors: null, // SENSORS bands from /api/meta
  target: {}, // latest readings
  disp: {}, // smoothed readings used for rendering
  status: {}, // latest statuses
  history: {}, // per-sensor recent values for the sparkline
  selected: null,
  hover: null,
  xray: false,
  explode: 0, // eased 0..1 explode amount
  explodeOn: false,
  flow: true,
  labels: true,
  autoRotate: false,
  slow: 60, // 1:N slow motion
  theta: 0, // crank angle (rad, unbounded)
  lastUpdate: 0,
  engineTail: '',
  stale: false, // telemetry feed stalled: freeze the mechanism so it doesn't look like a running engine
};

const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const HISTORY_LEN = 60;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Fold one engine snapshot into the twin state; tolerant of missing/garbled fields. */
function ingestEngine(eng) {
  if (!eng || typeof eng !== 'object') return;
  S.engineTail = typeof eng.tail === 'string' ? eng.tail : '';
  S.status = eng.statuses && typeof eng.statuses === 'object' ? eng.statuses : {};
  S.lastUpdate = performance.now();
  for (const [key, val] of Object.entries(eng.readings || {})) {
    if (!finite(val)) continue;
    S.target[key] = val;
    const h = (S.history[key] = S.history[key] || []);
    h.push(val);
    if (h.length > HISTORY_LEN) h.shift();
  }
}

function fmt(key, v) {
  if (!finite(v)) return '--';
  const digits = key === 'rpm' ? 0 : key === 'vibration' || key === 'batteryVoltage' ? 2 : 1;
  return v.toFixed(digits);
}

const STATUS_FLAG = { warning: '▲', critical: '✖' }; // non-colour status cue

/** Paint one sensor row of the readout rail (shared by the 3D UI and the no-WebGL fallback). */
function paintRow(row, key) {
  const st = S.status[key] || 'nominal';
  const meta = S.sensors && S.sensors[key];
  const unit = meta ? meta.unit : '';
  const label = meta ? meta.label : key;
  const val = fmt(key, S.target[key]);
  row.classList.remove('status-nominal', 'status-warning', 'status-critical');
  row.classList.add('status-' + st);
  row.querySelector('.tr-name').textContent = label;
  row.querySelector('.tr-val').textContent = `${STATUS_FLAG[st] ? STATUS_FLAG[st] + ' ' : ''}${val} ${unit}`.trim();
  row.setAttribute('aria-label', `${label}: ${val} ${unit}, ${st}`.replace(/\s+,/, ','));
}

function makeRailRow(key, tag) {
  const row = document.createElement(tag);
  if (tag === 'button') row.type = 'button';
  row.className = 'twin-row';
  const num = document.createElement('span');
  num.className = 'tr-num';
  num.textContent = String(PARTS[key].num);
  const name = document.createElement('span');
  name.className = 'tr-name';
  const val = document.createElement('span');
  val.className = 'tr-val';
  const dot = document.createElement('i');
  dot.className = 'tr-dot';
  row.append(num, name, val, dot);
  return row;
}

// ---------------------------------------------------------------- init
function init() {
  const stage = document.getElementById('twinStage');
  if (!stage) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    installFallback(stage, 'WebGL is unavailable in this browser, so the 3D twin cannot render. Live sensor readouts are still shown below.');
    return;
  }
  const host = document.getElementById('twinCanvasHost');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget = null;
  // Environment map lives in a render target, whose contents are lost with the GL
  // context, so it is (re)built by a function that context-restore can call again.
  function buildEnvironment() {
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    if (room.dispose) room.dispose();
    if (envTarget) envTarget.dispose();
    envTarget = target;
    scene.environment = target.texture;
  }
  buildEnvironment();
  scene.environmentIntensity = 0.75;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  const VIEWS = {
    iso: { pos: [7.4, 3.8, 8.0], target: [0.5, -0.3, 0] },
    front: { pos: [13, 0.8, 0.01], target: [0.4, -0.2, 0] },
    side: { pos: [0.4, 0.6, 14], target: [0.4, -0.2, 0] },
    top: { pos: [0.4, 14, 0.01], target: [0.4, -0.2, 0] },
    rear: { pos: [-11, 2.2, 5], target: [-0.6, -0.4, 0] },
  };
  camera.position.set(...VIEWS.iso.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...VIEWS.iso.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 26;
  controls.maxPolarAngle = Math.PI * 0.96;
  controls.autoRotateSpeed = 1.2;

  // lights: soft key with shadows, cool rim, warm fill
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(6, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x5b8cff, 1.1);
  rim.position.set(-7, 3, -6);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x1a1208, 0.35));

  buildPedestal(scene);

  const engine = new THREE.Group(); // shakes with vibration
  scene.add(engine);
  const model = buildEngine(engine);

  const flows = buildFlows(scene, engine, model);
  const ui = buildUi(stage, VIEWS, camera, controls, model);

  // status overlay for context loss (a plain DOM node, so it survives GL failures)
  const overlay = document.createElement('div');
  overlay.className = 'twin-overlay';
  overlay.setAttribute('role', 'status');
  overlay.hidden = true;
  stage.appendChild(overlay);

  // ---------------------------------------------------------- picking
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerInside = false;
  let downAt = null;
  const dom = renderer.domElement;

  dom.addEventListener('pointermove', (e) => {
    const r = dom.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    pointerInside = true;
  });
  dom.addEventListener('pointerleave', () => { pointerInside = false; S.hover = null; dom.style.cursor = 'grab'; });
  dom.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  dom.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 5) return; // it was an orbit drag
    selectPart(S.hover && S.hover !== S.selected ? S.hover : null, ui);
  });

  function pick() {
    if (!pointerInside) return;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(model.pickables, false)[0];
    const next = hit ? hit.object.userData.part : null;
    if (next !== S.hover) {
      S.hover = next;
      dom.style.cursor = next ? 'pointer' : 'grab';
    }
  }

  // ---------------------------------------------------------- sizing
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // follows browser zoom / monitor changes
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  // ---------------------------------------------------------- loop
  // The render loop only runs while the stage is on screen, the tab is visible and the GL
  // context is alive; otherwise the animation frame request is cancelled outright.
  let onScreen = true;
  let contextLost = false;
  let disposed = false;
  let rafId = 0;
  let failures = 0;
  const intersection = new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1].isIntersecting; syncLoop(); });
  intersection.observe(stage);

  let lastT = performance.now();
  let elapsed = 0;
  let camTween = null;
  ui.onView = (name) => {
    const v = VIEWS[name];
    camTween = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos: new THREE.Vector3(...v.pos),
      toTarget: new THREE.Vector3(...v.target),
    };
  };

  // `forcedDt` lets tests (or a hidden tab, where rAF never fires) step the scene manually.
  function tick(forcedDt) {
    const now = performance.now();
    const dt = forcedDt ?? Math.min((now - lastT) / 1000, 0.1);
    lastT = now;
    elapsed += dt;
    const time = elapsed;

    // ease displayed readings toward the last telemetry values
    const k = 1 - Math.exp(-dt / 0.7);
    for (const key of Object.keys(S.target)) {
      S.disp[key] = S.disp[key] === undefined ? S.target[key] : S.disp[key] + (S.target[key] - S.disp[key]) * k;
    }
    S.explode += ((S.explodeOn ? 1 : 0) - S.explode) * (1 - Math.exp(-dt / 0.28));

    if (camTween) {
      camTween.t = Math.min(1, camTween.t + dt / (reducedMotion.matches ? 0.01 : 0.9));
      const e = camTween.t * camTween.t * (3 - 2 * camTween.t);
      camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
      controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
      if (camTween.t >= 1) camTween = null;
    }
    controls.autoRotate = S.autoRotate && !reducedMotion.matches;
    controls.update();

    pick();

    // A stalled feed freezes the shaft, shake and flow so the twin can't pass for a live, running engine.
    const rpm = S.stale ? 0 : (S.disp.rpm ?? 0);
    const omega = ((rpm * TAU) / 60) / S.slow; // rad/s shown on screen
    S.theta += omega * dt;

    model.animate(S.theta, omega, S.explode, S.xray);
    applyShake(engine, S.stale || reducedMotion.matches ? 0 : (S.disp.vibration ?? 0), time);
    applySurfaceState(model, time);
    flows.update(dt, S);
    ui.frame(camera, model, time);

    renderer.render(scene, camera);
  }
  ui.onZoom = (factor) => {
    const dir = camera.position.clone().sub(controls.target).multiplyScalar(factor);
    camTween = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos: controls.target.clone().add(dir),
      toTarget: controls.target.clone(),
    };
  };

  function loop() {
    rafId = requestAnimationFrame(loop);
    try {
      tick();
      failures = 0;
    } catch (err) {
      console.error('[twin3d] frame failed', err);
      if (++failures >= 5) { // don't spin forever on a broken frame
        cancelAnimationFrame(rafId);
        rafId = 0;
        overlay.textContent = '3D rendering stopped after repeated errors. Sensor readouts are unaffected.';
        overlay.hidden = false;
      }
    }
  }
  function syncLoop() {
    const shouldRun = !disposed && onScreen && !document.hidden && !contextLost && failures < 5;
    if (shouldRun && !rafId) {
      lastT = performance.now(); // don't integrate the time spent paused
      rafId = requestAnimationFrame(loop);
    } else if (!shouldRun && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }
  document.addEventListener('visibilitychange', syncLoop);
  syncLoop();

  // ---------------------------------------------------------- GL context loss
  dom.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // lets the browser restore the context
    contextLost = true;
    overlay.textContent = 'Graphics context lost. Restoring the 3D view…';
    overlay.hidden = false;
    syncLoop();
  });
  dom.addEventListener('webglcontextrestored', () => {
    try { buildEnvironment(); } catch (err) { console.error('[twin3d] environment rebuild failed', err); }
    contextLost = false;
    overlay.hidden = true;
    resize();
    syncLoop();
  });

  // ---------------------------------------------------------- teardown
  function dispose() {
    if (disposed) return;
    disposed = true;
    syncLoop();
    document.removeEventListener('visibilitychange', syncLoop);
    resizeObserver.disconnect();
    intersection.disconnect();
    controls.dispose();
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      }
    });
    if (envTarget) envTarget.dispose();
    pmrem.dispose();
    renderer.dispose();
    dom.remove();
    overlay.remove();
    ui.dispose();
    window.twin3d = undefined;
  }
  window.addEventListener('pagehide', (e) => { if (!e.persisted) dispose(); });

  // ---------------------------------------------------------- public API
  window.twin3d = {
    update(eng) {
      ingestEngine(eng);
      ui.update();
    },
    resetHistory() { S.history = {}; },
    setStale(on) { S.stale = !!on; ui.update(); },
    tick,
    dispose,
  };
  const pending = window.dtState && window.dtState.latest;
  if (pending && Array.isArray(pending.engines)) {
    const eng = pending.engines.find((e) => e.id === window.dtState.selectedEngineId) || pending.engines[0];
    window.twin3d.update(eng);
  }
  if (window.dtState && window.dtState.stale && window.dtState.stale !== 'none') window.twin3d.setStale(true);
  document.getElementById('twinLoading')?.remove();
}

/**
 * No WebGL (or the model failed to build): say so, and keep the live sensor
 * readouts working as a plain list so the panel is still useful.
 */
function installFallback(stage, msg) {
  stage.classList.add('twin-fallback');
  document.getElementById('twinCanvasHost')?.replaceChildren();
  let note = document.getElementById('twinLoading');
  if (!note) {
    note = document.createElement('div');
    note.id = 'twinLoading';
    note.className = 'twin-loading';
    stage.appendChild(note);
  }
  note.textContent = msg;
  note.classList.add('twin-error');

  const rail = document.getElementById('twinRail');
  const rows = {};
  if (rail) {
    rail.replaceChildren();
    for (const key of PART_ORDER) {
      const row = makeRailRow(key, 'div');
      row.classList.add('twin-row-static');
      rail.appendChild(row);
      rows[key] = row;
    }
  }
  const paint = () => { for (const key of PART_ORDER) if (rows[key]) paintRow(rows[key], key); };
  paint();
  window.twin3d = {
    fallback: true,
    update(eng) { ingestEngine(eng); paint(); },
    resetHistory() { S.history = {}; },
    setStale() {},
    tick() {},
    dispose() {},
  };
  const pending = window.dtState && window.dtState.latest;
  if (pending && Array.isArray(pending.engines)) {
    window.twin3d.update(pending.engines.find((e) => e.id === window.dtState.selectedEngineId) || pending.engines[0]);
  }
}

// ---------------------------------------------------------------- shake
function applyShake(group, vibration, t) {
  // vibration is mm/s RMS; nominal ~1, critical ~4.2. Amplitude is exaggerated
  // for visibility but stays imperceptible at nominal so a healthy engine looks stable.
  const a = Math.max(0, vibration - 1.4) * 0.0085 + vibration * 0.0009;
  group.position.set(
    Math.sin(t * 61.3) * a * 0.5,
    Math.sin(t * 47.1 + 1.3) * a,
    Math.sin(t * 53.7 + 2.1) * a * 0.8,
  );
  group.rotation.x = Math.sin(t * 39.9) * a * 0.12;
}

// ---------------------------------------------------------------- surface state
const thermalTmp = new THREE.Color();
const emissiveTmp = new THREE.Color();

function norm(key, value, floor) {
  const b = S.sensors && S.sensors[key];
  if (!b || value === undefined) return 0;
  const hi = Number.isFinite(b.highCrit) ? b.highCrit : b.nominal[1] * 1.3;
  const lo = floor !== undefined ? floor : b.nominal[0] * 0.6;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}

function heatColor(h, out) {
  // black-body-ish ramp: dull red -> orange -> yellow-white
  if (h < 0.5) return out.setRGB(0.55 * (h / 0.5), 0.05 * (h / 0.5), 0);
  const u = (h - 0.5) / 0.5;
  return out.setRGB(0.55 + 0.45 * u, 0.05 + 0.5 * u, 0.02 + 0.2 * u);
}

function applySurfaceState(model, time) {
  for (const key of PART_ORDER) {
    const part = model.parts[key];
    const status = S.status[key] || 'nominal';

    // thermal glow (only CHT and EGT surfaces carry one)
    let thermal = 0;
    if (key === 'cht') thermal = Math.pow(norm('cht', S.disp.cht, 90), 2.6);
    else if (key === 'egt') thermal = Math.pow(norm('egt', S.disp.egt, 600), 3.2) * 0.9;

    // status glow: nominal is quiet, warning breathes, critical strobes
    let statusK = 0;
    if (status === 'warning') statusK = 0.16 + 0.1 * Math.sin(time * 3.2);
    else if (status === 'critical') statusK = 0.34 + 0.24 * Math.sin(time * 9);

    const selected = S.selected === key;
    const hovered = S.hover === key;
    const accent = selected ? 0.22 + 0.06 * Math.sin(time * 4) : hovered ? 0.14 : 0;

    for (const m of part.mats) {
      emissiveTmp.setRGB(0, 0, 0);
      if (m.userData.thermal && thermal > 0) {
        heatColor(Math.min(1, thermal), thermalTmp);
        emissiveTmp.add(thermalTmp.multiplyScalar(m.userData.thermal));
      }
      if (statusK > 0) emissiveTmp.add(thermalTmp.copy(STATUS_RGB[status]).multiplyScalar(statusK * (m.userData.statusGain ?? 1)));
      if (accent > 0) emissiveTmp.add(thermalTmp.setRGB(0.36, 0.55, 1).multiplyScalar(accent));
      m.emissive.copy(emissiveTmp);
    }
  }
}

// ---------------------------------------------------------------- materials
function makeMaterialFactory(parts) {
  return function mat(partKey, params, flags = {}) {
    const m = new THREE.MeshStandardMaterial({ envMapIntensity: 1, ...params });
    m.userData = { ...flags };
    if (partKey) parts[partKey].mats.push(m);
    return m;
  };
}

// ---------------------------------------------------------------- engine model
function buildEngine(root) {
  const parts = {};
  for (const key of PART_ORDER) parts[key] = { mats: [], anchor: null, normal: new THREE.Vector3(0, 1, 0), meshes: [] };
  const pickables = [];
  const xrayMats = [];
  const assemblies = []; // explode-able top-level groups
  const M = makeMaterialFactory(parts);

  const mesh = (geom, material, parent, partKey, { pos, rot, cast = true } = {}) => {
    const m = new THREE.Mesh(geom, material);
    if (pos) m.position.set(...pos);
    if (rot) m.rotation.set(...rot);
    m.castShadow = cast;
    m.receiveShadow = true;
    if (partKey) {
      m.userData.part = partKey;
      pickables.push(m);
      parts[partKey].meshes.push(m);
    }
    parent.add(m);
    return m;
  };

  const assembly = (name, explodeVec, partKey) => {
    const g = new THREE.Group();
    g.name = name;
    root.add(g);
    assemblies.push({ group: g, dir: new THREE.Vector3(...explodeVec) });
    g.userData.part = partKey;
    return g;
  };
  const anchorOn = (partKey, group, pos, normal) => {
    const a = new THREE.Object3D();
    a.position.set(...pos);
    group.add(a);
    parts[partKey].anchor = a;
    parts[partKey].normal.set(...normal).normalize();
  };

  // ---- shared materials -----------------------------------------------
  const alu = { color: 0xa9afb8, metalness: 0.92, roughness: 0.34 };
  const black = { color: 0x16171b, metalness: 0.55, roughness: 0.5 };
  const chrome = { color: 0xd4d8de, metalness: 1, roughness: 0.14 };
  const chromeM = new THREE.MeshStandardMaterial(chrome);
  const red = new THREE.MeshStandardMaterial({ color: 0xc41e1e, roughness: 0.45, metalness: 0.1 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.85, metalness: 0 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 1, roughness: 0.3 });
  const oilOrange = new THREE.MeshStandardMaterial({ color: 0xd98a1f, metalness: 0.4, roughness: 0.5 });

  // ---------------------------------------------------------------- crankcase (vibration)
  const caseMat = M('vibration', { ...alu, color: 0x9ba1ab }, {});
  xrayMats.push([caseMat, 0.16]);
  const caseSeamMat = M('vibration', { color: 0x0c0d10, metalness: 0.4, roughness: 0.7 });
  const caseGroup = assembly('crankcase', [0, 0, 0], 'vibration');
  const halves = [];
  for (const side of [1, -1]) {
    const h = new THREE.Group();
    caseGroup.add(h);
    halves.push({ group: h, side });
    mesh(new RoundedBoxGeometry(3.9, 1.15, 0.5, 4, 0.1), caseMat, h, 'vibration', { pos: [-0.05, 0, side * 0.25] });
    // cylinder mounting pads
    for (const sx of STATION_X) {
      mesh(new RoundedBoxGeometry(0.82, 1.0, 0.16, 3, 0.05), caseMat, h, 'vibration', { pos: [sx + side * BOXER_OFFSET, 0, side * 0.55] });
    }
    // through-bolt row along the top and bottom of the case
    for (let i = 0; i < 9; i++) {
      for (const y of [0.5, -0.5]) {
        mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.04, 10), steel, h, null, { pos: [-1.8 + i * 0.44, y, side * 0.5], rot: [Math.PI / 2, 0, 0], cast: false });
      }
    }
  }
  mesh(new THREE.BoxGeometry(3.86, 1.0, 0.012), caseSeamMat, caseGroup, 'vibration', { cast: false, pos: [-0.05, 0, 0] });

  // rear accessory case + magnetos (ignition leads end at the magneto towers)
  const acc = assembly('accessory', [-1.5, 0, 0], 'vibration');
  mesh(new RoundedBoxGeometry(0.55, 1.0, 0.95, 4, 0.08), caseMat, acc, 'vibration', { pos: [-2.28, 0, 0] });
  const magMat = M('vibration', { ...black, color: 0x1b1c20 });
  const magTerminals = [];
  for (const side of [1, -1]) {
    mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 28), magMat, acc, 'vibration', { pos: [-2.72, 0.22, side * 0.31], rot: [0, 0, Math.PI / 2] });
    mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.06, 28), steel, acc, 'vibration', { pos: [-2.5, 0.22, side * 0.31], rot: [0, 0, Math.PI / 2] });
    mesh(new RoundedBoxGeometry(0.18, 0.2, 0.26, 2, 0.03), rubber, acc, null, { pos: [-2.86, 0.4, side * 0.31] });
    magTerminals.push(new THREE.Vector3(-2.86, 0.52, side * 0.31));
  }
  anchorOn('vibration', caseGroup, [-0.1, 0.62, 0.3], [0, 1, 0]);

  // nose casting behind the flange
  const noseMat = M('vibration', { ...alu, color: 0x8f959e });
  mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.3, 40), noseMat, caseGroup, 'vibration', { pos: [2.05, 0, 0], rot: [0, 0, Math.PI / 2] });

  // ---------------------------------------------------------------- sump / oil (oilPressure)
  const sumpMat = M('oilPressure', { ...alu, color: 0x8d939d });
  const sump = assembly('sump', [0, -1.15, 0], 'oilPressure');
  mesh(new RoundedBoxGeometry(3.2, 0.5, 1.0, 4, 0.09), sumpMat, sump, 'oilPressure', { pos: [-0.25, -0.8, 0] });
  for (let i = 0; i < 9; i++) {
    mesh(new RoundedBoxGeometry(0.035, 0.32, 1.08, 1, 0.012), sumpMat, sump, 'oilPressure', { pos: [-1.65 + i * 0.4, -0.84, 0] });
  }
  mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.1, 6), steel, sump, null, { pos: [-0.9, -1.09, 0] });
  // spin-on filter + pump on the rear face
  const filterMat = M('oilPressure', { color: 0x1c3a63, metalness: 0.5, roughness: 0.45 });
  mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.44, 28), filterMat, sump, 'oilPressure', { pos: [-2.72, -0.32, -0.28], rot: [0, 0, Math.PI / 2] });
  mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 28), steel, sump, 'oilPressure', { pos: [-2.5, -0.32, -0.28], rot: [0, 0, Math.PI / 2] });
  const dipstick = mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.9, 10), chromeM, sump, null, { pos: [0.75, -0.3, 0.55], rot: [0.14, 0, 0.08] });
  dipstick.castShadow = false;
  mesh(new THREE.SphereGeometry(0.06, 12, 12), oilOrange, sump, null, { pos: [0.77, 0.14, 0.62] });
  anchorOn('oilPressure', sump, [-0.6, -1.06, 0.42], [0, -0.5, 1]);

  // ---------------------------------------------------------------- oil cooler (oilTemp)
  const coolerMat = M('oilTemp', { color: 0x2a2d33, metalness: 0.7, roughness: 0.4 });
  const coolerFin = M('oilTemp', { color: 0xb9bec7, metalness: 0.9, roughness: 0.35 });
  const cooler = assembly('cooler', [1.4, -0.2, -1.1], 'oilTemp');
  const cc = [1.9, -0.6, -1.05];
  mesh(new RoundedBoxGeometry(0.2, 0.9, 0.9, 3, 0.04), coolerMat, cooler, 'oilTemp', { pos: cc });
  for (let i = 0; i < 16; i++) {
    mesh(new THREE.BoxGeometry(0.24, 0.014, 0.78), coolerFin, cooler, 'oilTemp', { pos: [cc[0] + 0.02, cc[1] - 0.38 + i * 0.05, cc[2]], cast: false });
  }
  const hoseGeo = (pts, r) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), 30, r, 10, false);
  const oilHoseA = [[1.3, -0.75, -0.45], [1.6, -0.85, -0.7], [1.75, -0.85, -0.95], [1.85, -0.98, -1.2]];
  const oilHoseB = [[1.25, -0.6, -0.5], [1.55, -0.45, -0.72], [1.72, -0.35, -0.95], [1.85, -0.25, -1.2]];
  mesh(hoseGeo(oilHoseA, 0.055), rubber, cooler, 'oilTemp');
  mesh(hoseGeo(oilHoseB, 0.055), rubber, cooler, 'oilTemp');
  anchorOn('oilTemp', cooler, [2.0, -0.6, -1.05], [1, 0, -0.6]);

  // ---------------------------------------------------------------- alternator (batteryVoltage)
  const altMat = M('batteryVoltage', { ...black, color: 0x1a1c22 });
  const altCap = M('batteryVoltage', { ...alu, color: 0x8e949e });
  const alt = assembly('alternator', [1.2, -0.8, 0], 'batteryVoltage');
  mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.5, 36), altMat, alt, 'batteryVoltage', { pos: [1.85, -0.92, 0], rot: [0, 0, Math.PI / 2] });
  mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.06, 36), altCap, alt, 'batteryVoltage', { pos: [2.12, -0.92, 0], rot: [0, 0, Math.PI / 2] });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    mesh(new THREE.BoxGeometry(0.38, 0.03, 0.02), altCap, alt, null, { pos: [1.78, -0.92 + Math.sin(a) * 0.262, Math.cos(a) * 0.262], rot: [-a + Math.PI / 2, 0, 0], cast: false });
  }
  const altPulley = new THREE.Group();
  altPulley.position.set(2.26, -0.92, 0);
  alt.add(altPulley);
  mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 32), steel, altPulley, 'batteryVoltage', { rot: [0, 0, Math.PI / 2] });
  mesh(new THREE.BoxGeometry(0.1, 0.07, 0.04), red, altPulley, null, { pos: [0, 0.16, 0], cast: false }); // spin marker
  // drive belt: two straight runs between crank pulley (r .5) and alternator pulley (r .2)
  const beltMat = M('batteryVoltage', { color: 0x0a0a0c, roughness: 0.9, metalness: 0 });
  for (const side of [1, -1]) {
    const a = new THREE.Vector3(2.26, 0, side * 0.5);
    const b = new THREE.Vector3(2.26, -0.92, side * 0.2);
    const len = a.distanceTo(b);
    const belt = mesh(new THREE.BoxGeometry(0.09, len, 0.025), beltMat, alt, null, { cast: false });
    belt.position.copy(a).add(b).multiplyScalar(0.5);
    belt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  }
  anchorOn('batteryVoltage', alt, [1.85, -1.2, 0.05], [0, -1, 0.3]);

  // ---------------------------------------------------------------- cylinders (cht)
  const barrelMat = M('cht', { color: 0x24272c, metalness: 0.7, roughness: 0.42 }, { thermal: 0.9 });
  const finMat = M('cht', { color: 0x2c3036, metalness: 0.75, roughness: 0.38 }, { thermal: 1 });
  const headMat = M('cht', { color: 0x1b1d21, metalness: 0.75, roughness: 0.4 }, { thermal: 1 });
  const coverMat = M('cht', { color: 0xe6e9ee, metalness: 0.85, roughness: 0.25 }, { statusGain: 1.2 });
  xrayMats.push([barrelMat, 0.2], [finMat, 0.22], [headMat, 0.3]);

  const cylinders = [];

  STATION_X.forEach((sx, station) => {
    for (const side of [1, -1]) {
      const xc = sx + side * BOXER_OFFSET;
      const asm = assembly(`cyl-${station}-${side}`, [0, 0, side * 1.15], 'cht');
      const holder = new THREE.Group();
      holder.position.set(xc, 0, 0);
      holder.rotation.x = side * (Math.PI / 2);
      asm.add(holder);
      const inner = new THREE.Group();
      inner.scale.z = side; // keep port side facing down for both banks
      holder.add(inner);

      // barrel + cooling fins (local Y = outward along the bank)
      mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.78, 36), barrelMat, inner, 'cht', { pos: [0, 0.94, 0] });
      for (let i = 0; i < 7; i++) {
        mesh(new THREE.CylinderGeometry(0.375 - i * 0.004, 0.375 - i * 0.004, 0.03, 36), finMat, inner, 'cht', { pos: [0, 0.62 + i * 0.095, 0] });
      }
      // head core + head fins
      mesh(new RoundedBoxGeometry(0.8, 0.52, 0.68, 4, 0.07), headMat, inner, 'cht', { pos: [0, 1.58, 0] });
      for (let i = 0; i < 6; i++) {
        mesh(new RoundedBoxGeometry(0.9, 0.028, 0.76, 1, 0.012), finMat, inner, 'cht', { pos: [0, 1.36 + i * 0.096, 0], cast: false });
      }
      // rocker cover
      mesh(new RoundedBoxGeometry(0.64, 0.17, 0.52, 4, 0.06), coverMat, inner, 'cht', { pos: [0, 1.93, 0] });
      for (const bx of [-0.24, 0.24]) {
        for (const bz of [-0.18, 0.18]) {
          mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 10), steel, inner, null, { pos: [bx, 2.02, bz], cast: false });
        }
      }
      // pushrod tubes on the top side of the cylinder
      for (const px of [-0.16, 0.16]) {
        mesh(new THREE.CylinderGeometry(0.024, 0.024, 1.3, 10), chromeM, inner, null, { pos: [px, 1.2, -0.42], cast: false });
      }
      // spark-plug boot on the +x edge of the head
      mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.2, 14), rubber, inner, null, { pos: [0.5, 1.58, -0.12], rot: [0, 0, Math.PI / 2], cast: false });
      // exhaust + intake port flanges on the down-facing side
      const ex = new THREE.Object3D(); ex.position.set(-0.2, 1.62, 0.4); inner.add(ex);
      const inl = new THREE.Object3D(); inl.position.set(0.2, 1.62, 0.4); inner.add(inl);
      mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 24), chromeM, inner, null, { pos: [-0.2, 1.62, 0.4], rot: [Math.PI / 2, 0, 0], cast: false });
      mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 24), steel, inner, null, { pos: [0.2, 1.62, 0.4], rot: [Math.PI / 2, 0, 0], cast: false });

      // combustion-chamber flash, visible only in X-ray
      const flashMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const flash = mesh(new THREE.SphereGeometry(0.24, 16, 16), flashMat, inner, null, { pos: [0, 1.32, 0], cast: false });
      flash.visible = false;

      cylinders.push({ station, side, xc, asm, flash, flashMat, ex, inl });
    }
  });
  anchorOn('cht', cylinders[2].asm, [cylinders[2].xc, 0.1, 2.08], [0, 0.15, 1]);

  // ---------------------------------------------------------------- crank, pistons, prop (rpm)
  const rotMat = M('rpm', { color: 0x70757e, metalness: 1, roughness: 0.28 });
  const crankMat = M('rpm', { color: 0x9aa0a9, metalness: 1, roughness: 0.22 });
  const spinnerMat = M('rpm', { color: 0xdfe3e8, metalness: 1, roughness: 0.1 });
  const bladeMat = M('rpm', { color: 0xffffff, metalness: 0.35, roughness: 0.42, vertexColors: true, side: THREE.DoubleSide });
  const pistonMat = M('rpm', { color: 0xb8bcc4, metalness: 0.9, roughness: 0.3 });
  const rodMat = M('rpm', { color: 0x8e939c, metalness: 1, roughness: 0.25 });

  const crank = assembly('crank', [0, 0, 0], 'rpm');
  const rot = new THREE.Group(); // spins about X
  crank.add(rot);
  mesh(new THREE.CylinderGeometry(0.12, 0.12, 5.2, 24), rotMat, rot, 'rpm', { pos: [-0.2, 0, 0], rot: [0, 0, Math.PI / 2] });
  const throws = [];
  cylinders.forEach((c) => {
    const beta = THROW_ANGLE[c.station];
    const pinAng = c.side === 1 ? beta : beta + Math.PI;
    c.beta = beta;
    c.pinAng = pinAng;
    for (const dx of [-0.09, 0.09]) {
      mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.06, 32), crankMat, rot, 'rpm', { pos: [c.xc + dx, 0, 0], rot: [0, 0, Math.PI / 2] });
    }
    const cw = new THREE.CylinderGeometry(0.3, 0.3, 0.07, 32, 1, false, pinAng + Math.PI / 2, Math.PI);
    cw.rotateZ(Math.PI / 2);
    mesh(cw, crankMat, rot, 'rpm', { pos: [c.xc + 0.09, 0, 0] });
    mesh(new THREE.CylinderGeometry(CRANK_PLANE_PIN_HALF, CRANK_PLANE_PIN_HALF, 0.2, 16), crankMat, rot, 'rpm', {
      pos: [c.xc, THROW_R * Math.sin(pinAng), THROW_R * Math.cos(pinAng)], rot: [0, 0, Math.PI / 2],
    });
    throws.push({ c });
  });

  // pistons + rods live directly under the engine group so they stay put while cylinders explode
  const pistons = cylinders.map((c) => {
    const g = new THREE.Group();
    root.add(g);
    const dir = new THREE.Vector3(0, 0, c.side);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh(new THREE.CylinderGeometry(0.265, 0.265, 0.3, 28), pistonMat, g, 'rpm', { pos: [0, 0.06, 0] });
    for (const y of [0.13, 0.19, 0.25]) {
      mesh(new THREE.CylinderGeometry(0.272, 0.272, 0.014, 28), steel, g, null, { pos: [0, y, 0], cast: false });
    }
    mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.5, 12), steel, g, null, { rot: [0, 0, Math.PI / 2], cast: false });
    const rod = mesh(new THREE.CylinderGeometry(0.038, 0.06, ROD_L, 12), rodMat, root, 'rpm');
    const bigEnd = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 20), rodMat, root, null, { cast: false });
    bigEnd.rotation.z = Math.PI / 2;
    return { c, g, rod, bigEnd, dir };
  });

  // propeller: flange, spinner, two lofted blades
  mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.1, 40), rotMat, rot, 'rpm', { pos: [2.24, 0, 0], rot: [0, 0, Math.PI / 2] }); // crank pulley
  mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.13, 48), crankMat, rot, 'rpm', { pos: [2.38, 0, 0], rot: [0, 0, Math.PI / 2] });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10), steel, rot, null, { pos: [2.46, Math.sin(a) * 0.5, Math.cos(a) * 0.5], rot: [0, 0, Math.PI / 2], cast: false });
  }
  const spinnerProfile = [];
  const SP_LEN = 1.55;
  for (let i = 0; i <= 28; i++) {
    const u = i / 28;
    const r = 0.66 * Math.sqrt(Math.max(0, 1 - Math.pow(u, 1.7))) * (1 - 0.05 * u);
    spinnerProfile.push(new THREE.Vector2(Math.max(r, 0.001), u * SP_LEN));
  }
  const spinner = mesh(new THREE.LatheGeometry(spinnerProfile, 56), spinnerMat, rot, 'rpm', { pos: [2.45, 0, 0], rot: [0, 0, -Math.PI / 2] });
  spinner.castShadow = true;
  const blades = new THREE.Group();
  rot.add(blades);
  blades.position.set(2.86, 0, 0);
  for (const flip of [1, -1]) {
    const b = mesh(bladeGeometry(), bladeMat, blades, 'rpm');
    b.rotation.x = flip === 1 ? 0 : Math.PI;
  }
  // motion-blur disc: fades in as shown rotation speed rises
  const discMat = new THREE.MeshBasicMaterial({ color: 0x9db4d6, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(3.05, 64), discMat);
  disc.rotation.y = Math.PI / 2;
  disc.position.set(2.86, 0, 0);
  root.add(disc);
  anchorOn('rpm', crank, [3.3, 0.5, 0], [1, 0.3, 0.3]);

  // ---------------------------------------------------------------- intake manifold (manifoldPressure)
  const plenumMat = M('manifoldPressure', { color: 0x7d8590, metalness: 0.95, roughness: 0.3 });
  const intake = assembly('intake', [0, -1.4, 0], 'manifoldPressure');
  mesh(new THREE.CylinderGeometry(0.13, 0.13, 3.1, 28), plenumMat, intake, 'manifoldPressure', { pos: [-0.05, -1.22, 0], rot: [0, 0, Math.PI / 2] });
  const intakeCurves = [];
  cylinders.forEach((c) => {
    const s = c.side;
    const pts = [
      [c.xc, -1.22, s * 0.05], [c.xc + 0.03, -1.26, s * 0.7], [c.xc + 0.2, -0.9, s * 1.4], [c.xc + 0.2, -0.42, s * 1.62],
    ].map((p) => new THREE.Vector3(...p));
    const curve = new THREE.CatmullRomCurve3(pts);
    intakeCurves.push(curve);
    mesh(new THREE.TubeGeometry(curve, 28, 0.075, 14, false), plenumMat, intake, 'manifoldPressure');
  });
  anchorOn('manifoldPressure', intake, [-0.05, -1.36, 0.16], [0, -1, 0.4]);

  // ---------------------------------------------------------------- fuel servo (fuelFlow)
  const servoMat = M('fuelFlow', { color: 0x3b3f46, metalness: 0.85, roughness: 0.35 });
  const fuelLineMat = M('fuelFlow', { ...chrome });
  const filtMat = M('fuelFlow', { color: 0xc8ccd2, metalness: 0.95, roughness: 0.22 });
  const fuel = assembly('fuel', [0.4, -1.6, 0], 'fuelFlow');
  mesh(new RoundedBoxGeometry(0.7, 0.32, 0.55, 3, 0.06), servoMat, fuel, 'fuelFlow', { pos: [-0.05, -1.62, 0] });
  mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.3, 24), servoMat, fuel, 'fuelFlow', { pos: [-0.05, -1.38, 0] });
  mesh(new THREE.CylinderGeometry(0.24, 0.24, 1.1, 28), filtMat, fuel, 'fuelFlow', { pos: [0.85, -1.62, 0], rot: [0, 0, Math.PI / 2] });
  mesh(new THREE.CylinderGeometry(0.31, 0.27, 0.16, 28), servoMat, fuel, 'fuelFlow', { pos: [1.46, -1.62, 0], rot: [0, 0, Math.PI / 2] });
  mesh(new RoundedBoxGeometry(0.18, 0.2, 0.2, 2, 0.04), servoMat, fuel, 'fuelFlow', { pos: [-0.05, -1.62, 0.36] }); // fuel divider
  const fuelPts = [[-0.05, -1.62, 0.4], [-0.6, -1.78, 0.95], [-1.9, -1.5, 1.05], [-2.8, -0.9, 0.95], [-3.0, -0.3, 0.7]];
  const fuelCurve = new THREE.CatmullRomCurve3(fuelPts.map((p) => new THREE.Vector3(...p)));
  mesh(new THREE.TubeGeometry(fuelCurve, 50, 0.04, 10, false), fuelLineMat, fuel, 'fuelFlow');
  mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 12), steel, fuel, null, { pos: [-3.0, -0.3, 0.7], rot: [0, 0, Math.PI / 2] });
  anchorOn('fuelFlow', fuel, [0.85, -1.9, 0.1], [0, -1, 0.3]);

  // ---------------------------------------------------------------- exhaust (egt)
  const exMat = M('egt', { color: 0xcdd2d8, metalness: 1, roughness: 0.2 }, { thermal: 1.2 });
  const exCollMat = M('egt', { color: 0xb9bec6, metalness: 1, roughness: 0.22 }, { thermal: 1.2 });
  const exhaust = assembly('exhaust', [-1.3, -1.0, 0], 'egt');
  const exhaustCurves = [];
  root.updateMatrixWorld(true);
  const exhaustByBank = { 1: [], '-1': [] };
  cylinders.forEach((c) => {
    const s = c.side;
    const p0 = c.ex.getWorldPosition(new THREE.Vector3());
    const endX = c.xc - 0.55;
    const pts = [
      p0.clone(), new THREE.Vector3(p0.x - 0.04, p0.y - 0.35, s * 1.86), new THREE.Vector3(p0.x - 0.3, -1.0, s * 1.95),
      new THREE.Vector3(endX, -1.0, s * 1.95),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    mesh(new THREE.TubeGeometry(curve, 30, 0.085, 14, false), exMat, exhaust, 'egt');
    exhaustByBank[s].push(endX);
    exhaustCurves.push(new THREE.CatmullRomCurve3([...pts, new THREE.Vector3(-3.15, -1.0, s * 1.95)]));
  });
  for (const s of [1, -1]) {
    const startX = Math.max(...exhaustByBank[s]);
    const len = startX - -3.1;
    mesh(new THREE.CylinderGeometry(0.135, 0.135, len, 28), exCollMat, exhaust, 'egt', { pos: [startX - len / 2, -1.0, s * 1.95], rot: [0, 0, Math.PI / 2] });
    mesh(new THREE.CylinderGeometry(0.18, 0.135, 0.3, 28, 1, true), exCollMat, exhaust, 'egt', { pos: [-3.25, -1.0, s * 1.95], rot: [0, 0, Math.PI / 2] }).material.side = THREE.DoubleSide;
    mesh(new THREE.TorusGeometry(0.15, 0.02, 10, 28), steel, exhaust, null, { pos: [startX - 0.3, -1.0, s * 1.95], rot: [0, Math.PI / 2, 0], cast: false }); // clamp
  }
  anchorOn('egt', exhaust, [-1.6, -1.15, 1.95], [0, -0.4, 1]);

  // ---------------------------------------------------------------- ignition leads (static)
  const leadMat = red;
  cylinders.forEach((c) => {
    const s = c.side;
    const b = new THREE.Vector3(c.xc + 0.6, 0, s * 1.5);
    const term = magTerminals[s === 1 ? 0 : 1];
    const pts = [
      b, new THREE.Vector3(b.x + 0.06, 0.32, s * 1.34), new THREE.Vector3(b.x - 0.1, 0.8, s * 1.0),
      new THREE.Vector3((b.x + term.x) / 2, 0.86, s * 0.62), new THREE.Vector3(term.x + 0.55, 0.78, s * 0.42),
      new THREE.Vector3(term.x + 0.1, 0.66, s * 0.32), term,
    ];
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 44, 0.017, 8, false), leadMat, root, null, { cast: false });
  });

  // ---------------------------------------------------------------- x-ray: register ghosting
  const setXray = (on) => {
    for (const [m, o] of xrayMats) {
      m.transparent = on;
      m.opacity = on ? o : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
  };
  let xrayState = null;

  const partList = PART_ORDER.map((k) => parts[k]);
  partList.forEach((p) => { p.mats = [...new Set(p.mats)]; });

  // ---------------------------------------------------------------- per-frame animation
  const tmpP = new THREE.Vector3();
  const tmpQ = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  function animate(theta, omega, explode, xray) {
    if (xrayState !== xray) { setXray(xray); xrayState = xray; }

    rot.rotation.x = -theta;
    altPulley.rotation.x = -theta * 2.5;
    disc.material.opacity = Math.min(0.045, Math.max(0, (omega - 6) / 200)) * (1 - Math.min(1, explode * 2));

    // explode assemblies outward; the crankcase halves split along Z
    for (const a of assemblies) {
      a.group.position.copy(a.dir).multiplyScalar(explode);
    }
    for (const h of halves) h.group.position.set(0, 0, h.side * explode * 0.75);
    caseSeamMat.visible = explode < 0.05;

    for (const p of pistons) {
      const c = p.c;
      const phi = theta + c.beta; // crank angle relative to this bank
      const s = THROW_R * Math.cos(phi) + Math.sqrt(ROD_L * ROD_L - THROW_R * THROW_R * Math.sin(phi) ** 2);
      p.g.position.set(c.xc, 0, c.side * s);
      // crank pin in engine coordinates
      const ang = theta + c.pinAng;
      tmpP.set(c.xc, THROW_R * Math.sin(ang), THROW_R * Math.cos(ang));
      tmpQ.set(c.xc, 0, c.side * s);
      p.rod.position.copy(tmpP).add(tmpQ).multiplyScalar(0.5);
      p.rod.quaternion.setFromUnitVectors(yAxis, tmpQ.clone().sub(tmpP).normalize());
      p.bigEnd.position.copy(tmpP);

      // four-stroke cycle: fire once per 720 deg, flash just after compression TDC
      const cam = c.side === 1 ? 0 : 1;
      const psi = (((theta + c.beta + cam * TAU) % (2 * TAU)) + 2 * TAU) % (2 * TAU);
      const burn = psi < Math.PI ? Math.exp(-psi * 1.7) : 0;
      c.flash.visible = xray;
      c.flashMat.opacity = xray ? burn * 0.85 : 0;
    }
  }

  return { parts, pickables, animate, cylinders, intakeCurves, exhaustCurves, fuelCurve, oilCurves: [
    new THREE.CatmullRomCurve3(oilHoseA.map((p) => new THREE.Vector3(...p))),
    new THREE.CatmullRomCurve3(oilHoseB.map((p) => new THREE.Vector3(...p)).reverse()),
  ], partList };
}

function bladeGeometry() {
  const STATIONS = 16;
  const RING = 18;
  const R0 = 0.55;
  const R1 = 3.0;
  const pos = [];
  const col = [];
  const idx = [];
  for (let i = 0; i < STATIONS; i++) {
    const u = i / (STATIONS - 1);
    const r = R0 + (R1 - R0) * u;
    const chord = 0.36 + 0.3 * Math.sin(Math.PI * Math.min(1, u * 1.15 + 0.1)) - 0.16 * u;
    const thick = chord * (0.17 - 0.09 * u);
    const twist = THREE.MathUtils.degToRad(38 - 32 * Math.pow(u, 0.8));
    const c = Math.cos(twist);
    const s = Math.sin(twist);
    for (let j = 0; j < RING; j++) {
      const a = (j / RING) * TAU;
      // lens section, leading edge at a=0
      const along = Math.cos(a) * 0.5 * chord;
      const camber = Math.sin(a) * 0.5 * thick * (Math.sin(a) > 0 ? 1.25 : 0.7);
      // chord direction (tangential Z rotated toward axial X by pitch), thickness normal
      pos.push(along * s + camber * c, r, along * c - camber * s);
      const tip = u > 0.94;
      col.push(tip ? 1 : 0.13, tip ? 0.72 : 0.14, tip ? 0.12 : 0.16);
    }
  }
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let j = 0; j < RING; j++) {
      const a = i * RING + j;
      const b = i * RING + ((j + 1) % RING);
      idx.push(a, b, a + RING, b, b + RING, a + RING);
    }
  }
  const tipCenter = pos.length / 3;
  pos.push(0, R1 + 0.01, 0);
  col.push(1, 0.72, 0.12);
  for (let j = 0; j < RING; j++) idx.push((STATIONS - 1) * RING + ((j + 1) % RING), (STATIONS - 1) * RING + j, tipCenter);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildPedestal(scene) {
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(7.4, 7.6, 0.16, 96),
    new THREE.MeshStandardMaterial({ color: 0x0e1014, metalness: 0.6, roughness: 0.55 }),
  );
  platform.position.set(0.3, -2.75, 0);
  platform.receiveShadow = true;
  scene.add(platform);
  for (const [r, o] of [[3, 0.25], [5, 0.16], [7, 0.1]]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r, r + 0.03, 128),
      new THREE.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: o, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0.3, -2.66, 0);
    scene.add(ring);
  }
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.4 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.3, -2.66, 0);
  shadow.receiveShadow = true;
  scene.add(shadow);
}

// ---------------------------------------------------------------- flow particles
function buildFlows(scene, engine, model) {
  const groups = [];
  const make = (curves, color, count, size, speedFn, densityFn) => {
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    engine.add(pts);
    const lens = curves.map((c) => c.getLength());
    const st = Array.from({ length: count }, () => ({ c: Math.floor(Math.random() * curves.length), u: Math.random() }));
    groups.push({ pts, geo, arr, curves, lens, st, count, speedFn, densityFn });
  };
  make(model.intakeCurves, 0x7cc7ff, 260, 0.075, (d) => 0.35 + ((d.rpm ?? 0) / 5200) * 2.2, (d) => 0.25 + 0.75 * Math.min(1, (d.manifoldPressure ?? 0) / 100));
  make(model.exhaustCurves, 0xff8a3d, 260, 0.085, (d) => 0.4 + ((d.rpm ?? 0) / 5200) * 2.6, (d) => 0.35 + 0.65 * Math.min(1, (d.egt ?? 0) / 760));
  make([model.fuelCurve], 0xffd24a, 60, 0.07, (d) => 0.15 + ((d.fuelFlow ?? 0) / 15) * 0.9, (d) => 0.3 + 0.7 * Math.min(1, (d.fuelFlow ?? 0) / 15));
  make(model.oilCurves, 0xffa53a, 70, 0.07, (d) => 0.1 + ((d.oilPressure ?? 0) / 55) * 0.9, (d) => Math.min(1, 0.3 + (d.oilPressure ?? 0) / 60));
  const tmp = new THREE.Vector3();
  return {
    update(dt, st) {
      for (const g of groups) {
        g.pts.visible = st.flow && !st.stale && st.explode < 0.05;
        if (!g.pts.visible) continue;
        const speed = g.speedFn(st.disp) / st.slow * 12; // slow-motion consistent with the crank
        const dens = g.densityFn(st.disp);
        for (let i = 0; i < g.count; i++) {
          const p = g.st[i];
          if (i / g.count > dens) { g.arr[i * 3 + 1] = -999; continue; }
          p.u += (speed * dt * 3.2) / g.lens[p.c];
          if (p.u >= 1) { p.u = 0; p.c = Math.floor(Math.random() * g.curves.length); }
          g.curves[p.c].getPointAt(p.u, tmp);
          g.arr[i * 3] = tmp.x;
          g.arr[i * 3 + 1] = tmp.y;
          g.arr[i * 3 + 2] = tmp.z;
        }
        g.geo.attributes.position.needsUpdate = true;
      }
    },
  };
}

// ---------------------------------------------------------------- UI
function selectPart(key, ui) {
  S.selected = key;
  ui.update();
}

function buildUi(stage, VIEWS, camera, controls, model) {
  const $ = (sel) => stage.querySelector(sel);
  const pinsHost = $('#twinPins');
  const rail = document.getElementById('twinRail');
  const detail = $('#twinDetail');
  const hud = $('#twinHud');
  const api = { onView: () => {}, onZoom: () => {} };

  // pins
  const pinEls = {};
  for (const key of PART_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'twin-pin';
    b.dataset.part = key;
    b.tabIndex = -1; // duplicated by the keyboard-reachable readout rail below
    const pinNum = document.createElement('span');
    pinNum.className = 'tp-num';
    pinNum.textContent = String(PARTS[key].num);
    const pinChip = document.createElement('span');
    pinChip.className = 'tp-chip';
    b.append(pinNum, pinChip);
    b.addEventListener('click', () => selectPart(S.selected === key ? null : key, api));
    b.addEventListener('pointerenter', () => { S.hover = key; });
    b.addEventListener('pointerleave', () => { if (S.hover === key) S.hover = null; });
    pinsHost.appendChild(b);
    pinEls[key] = b;
  }

  // rail
  const railEls = {};
  for (const key of PART_ORDER) {
    const row = makeRailRow(key, 'button');
    row.addEventListener('click', () => selectPart(S.selected === key ? null : key, api));
    row.addEventListener('pointerenter', () => { S.hover = key; });
    row.addEventListener('pointerleave', () => { if (S.hover === key) S.hover = null; });
    rail.appendChild(row);
    railEls[key] = row;
  }

  // toolbar
  stage.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => {
    api.onView(btn.dataset.view);
    stage.querySelectorAll('[data-view]').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    });
  }));
  const toggle = (id, prop, extra) => {
    const btn = $('#' + id);
    btn.addEventListener('click', () => {
      S[prop] = !S[prop];
      btn.classList.toggle('active', S[prop]);
      btn.setAttribute('aria-pressed', String(S[prop]));
      if (extra) extra(S[prop]);
    });
    btn.classList.toggle('active', S[prop]);
    btn.setAttribute('aria-pressed', String(S[prop]));
  };
  toggle('twinXray', 'xray');
  toggle('twinExplode', 'explodeOn', (on) => api.onZoom(on ? 1.3 : 1 / 1.3)); // pull back so the spread-out parts stay in frame
  toggle('twinFlow', 'flow');
  toggle('twinLabels', 'labels', (on) => { pinsHost.classList.toggle('hidden', !on); });
  toggle('twinSpin', 'autoRotate');
  const slow = $('#twinSlow');
  const slowLabel = $('#twinSlowLabel');
  const applySlow = () => {
    // slider is log-scaled: 0..100 -> 1:12 .. 1:400
    const v = Number(slow.value) / 100;
    S.slow = Math.round(12 * Math.pow(400 / 12, v));
    slowLabel.textContent = `1:${S.slow}`;
  };
  slow.value = 39; // ~1:60
  slow.addEventListener('input', applySlow);
  applySlow();

  // sparkline
  const spark = detail.querySelector('canvas');
  const sctx = spark.getContext('2d');

  function drawSpark(key, status) {
    const w = spark.width;
    const h = spark.height;
    sctx.clearRect(0, 0, w, h);
    const data = S.history[key] || [];
    if (data.length < 2) return;
    const b = S.sensors && S.sensors[key];
    let lo = Math.min(...data);
    let hi = Math.max(...data);
    if (b) { lo = Math.min(lo, b.nominal[0]); hi = Math.max(hi, b.nominal[1]); }
    const pad = (hi - lo) * 0.1 || 1;
    lo -= pad; hi += pad;
    const y = (v) => h - ((v - lo) / (hi - lo)) * h;
    if (b) {
      sctx.fillStyle = 'rgba(52,211,153,0.10)';
      sctx.fillRect(0, y(b.nominal[1]), w, y(b.nominal[0]) - y(b.nominal[1]));
    }
    sctx.lineWidth = 1.6 * (w / 240);
    sctx.strokeStyle = status === 'critical' ? '#ff5252' : status === 'warning' ? '#ffb700' : '#34d399';
    sctx.beginPath();
    data.forEach((v, i) => {
      const px = ((i + 60 - data.length) / 59) * w;
      if (i === 0) sctx.moveTo(px, y(v)); else sctx.lineTo(px, y(v));
    });
    sctx.stroke();
  }

  api.update = () => {
    for (const key of PART_ORDER) {
      const st = S.status[key] || 'nominal';
      const meta = S.sensors && S.sensors[key];
      const unit = meta ? meta.unit : '';
      const label = meta ? meta.label : key;
      const val = fmt(key, S.target[key]);
      const pin = pinEls[key];
      pin.classList.remove('status-nominal', 'status-warning', 'status-critical');
      pin.classList.add('status-' + st);
      pin.classList.toggle('selected', S.selected === key);
      pin.setAttribute('aria-label', `${label}: ${val} ${unit}, ${st}`);
      pin.querySelector('.tp-chip').textContent = `${STATUS_FLAG[st] ? STATUS_FLAG[st] + ' ' : ''}${label} ${val} ${unit}`.trim();
      railEls[key].classList.toggle('selected', S.selected === key);
      railEls[key].setAttribute('aria-pressed', String(S.selected === key));
      paintRow(railEls[key], key);
    }
    const sel = S.selected;
    detail.hidden = !sel;
    if (sel) {
      const meta = S.sensors && S.sensors[sel];
      const st = S.status[sel] || 'nominal';
      detail.dataset.status = st;
      detail.querySelector('.td-title').textContent = `${PARTS[sel].num} · ${PARTS[sel].name}`;
      detail.querySelector('.td-badge').textContent = st.toUpperCase();
      detail.querySelector('.td-badge').className = 'td-badge status-' + st;
      detail.querySelector('.td-value').textContent = `${fmt(sel, S.target[sel])} ${meta ? meta.unit : ''}`;
      detail.querySelector('.td-sensor').textContent = meta ? meta.label : sel;
      detail.querySelector('.td-blurb').textContent = PARTS[sel].blurb;
      detail.querySelector('.td-band').textContent = meta ? bandText(meta) : '';
      drawSpark(sel, st);
    }
  };

  function bandText(m) {
    const parts = Array.isArray(m.nominal) ? [`Nominal ${m.nominal[0]}–${m.nominal[1]} ${m.unit}`] : [];
    if (Number.isFinite(m.highWarn)) parts.push(`warn ≥ ${m.highWarn}`, `crit ≥ ${m.highCrit}`);
    if (Number.isFinite(m.lowWarn)) parts.push(`warn ≤ ${m.lowWarn}`, `crit ≤ ${m.lowCrit}`);
    return parts.join(' · ');
  }
  detail.querySelector('.td-close').addEventListener('click', () => selectPart(null, api));

  const hudEls = {};
  let hudAt = 0;
  for (const name of ['live', 'tail', 'rpm', 'cycle', 'age']) {
    const span = document.createElement('span');
    if (name === 'live') span.className = 'th-live';
    hud.appendChild(span);
    hudEls[name] = span;
  }

  api.dispose = () => {
    pinsHost.replaceChildren();
    rail.replaceChildren();
    hud.replaceChildren();
  };

  const v = new THREE.Vector3();
  const cdir = new THREE.Vector3();
  api.frame = () => {
    // pins follow their 3D anchors; hide those facing away from the camera
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    for (const key of PART_ORDER) {
      const part = model.parts[key];
      if (!part.anchor) continue;
      part.anchor.getWorldPosition(v);
      cdir.copy(camera.position).sub(v).normalize();
      const n = part.normal;
      const facing = cdir.dot(n) > -0.15;
      v.project(camera);
      const el = pinEls[key];
      const on = facing && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      el.style.opacity = on ? '' : '0';
      el.style.pointerEvents = on ? '' : 'none';
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((-v.y + 1) / 2) * h}px) translate(-50%, -50%)`;
      el.classList.toggle('hovered', S.hover === key);
    }
    for (const key of PART_ORDER) railEls[key].classList.toggle('hovered', S.hover === key);
    const nowMs = performance.now();
    if (nowMs - hudAt > 250) { // the readout is text; no need to touch the DOM every frame
      hudAt = nowMs;
      const rpm = S.stale ? 0 : (S.disp.rpm ?? 0);
      const age = S.lastUpdate ? (nowMs - S.lastUpdate) / 1000 : null;
      const live = age !== null && age < 6 && !S.stale;
      const deg = (((S.theta * 180) / Math.PI) % 720 + 720) % 720;
      hudEls.live.className = `th-live ${live ? 'ok' : 'stale'}`;
      hudEls.live.textContent = live ? '● TWIN SYNCED' : S.stale ? '▲ TELEMETRY STALE' : '▲ NO LINK';
      hudEls.tail.textContent = S.engineTail || '—';
      hudEls.rpm.textContent = `SHAFT ${Math.round(rpm)} RPM`;
      hudEls.cycle.textContent = `CYCLE ${String(Math.round(deg)).padStart(3, '0')}°`;
      hudEls.age.textContent = `LINK AGE ${age === null ? '--' : age.toFixed(1)}s`;
    }
    if (S.selected) drawSpark(S.selected, S.status[S.selected] || 'nominal');
  };

  return api;
}

// ---------------------------------------------------------------- boot
// Sensor bands only scale visuals, so the twin starts without them if /api/meta is slow or
// down, and picks them up on a later retry.
async function loadMeta() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch('/api/meta', { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    if (!meta || typeof meta.sensors !== 'object' || meta.sensors === null) throw new Error('unexpected payload');
    S.sensors = meta.sensors;
    return true;
  } catch (err) {
    console.warn('[twin3d] /api/meta unavailable:', err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function refreshFromState() {
  const st = window.dtState;
  const engines = st && st.latest && st.latest.engines;
  if (!window.twin3d || !Array.isArray(engines)) return;
  window.twin3d.update(engines.find((e) => e.id === st.selectedEngineId) || engines[0]);
}

function boot() {
  try {
    init();
  } catch (err) {
    console.error('[twin3d] failed to start', err);
    const stage = document.getElementById('twinStage');
    if (window.twin3d && window.twin3d.dispose) window.twin3d.dispose();
    if (stage) installFallback(stage, '3D twin failed to start. Live sensor readouts are still shown below.');
  }
}

loadMeta().then((ok) => {
  boot();
  let retries = 0;
  const retry = () => {
    if (S.sensors || retries++ >= 3) return;
    setTimeout(() => loadMeta().then((got) => { if (got) refreshFromState(); else retry(); }), 10000);
  };
  if (!ok) retry();
});
