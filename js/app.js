/*
 * Flow Lines — app: settings, UI, input, transitions and the frame loop.
 */
(async function () {
  'use strict';

  // ---------------------------------------------------------------- catalog

  // `gl` is the field's id inside the shader's fieldById().
  const FIELDS = [
    { id: 'marble', gl: 1, name: 'Marble', blurb: 'Domain-warped angle field' },
    { id: 'curl', gl: 0, name: 'Curl Noise', blurb: 'Divergence-free simplex curl' },
    { id: 'vortex', gl: 2, name: 'Whirlpools', blurb: 'Drifting vortices in a turbulent sea' },
    { id: 'charge', gl: 3, name: 'Magnetic', blurb: 'Field lines between charges' },
    { id: 'orbit', gl: 4, name: 'Orbits', blurb: 'Rings with a radial ripple' },
    { id: 'origin', gl: 5, name: 'Origin', blurb: 'The original 2024 formula, breathing' },
  ];

  const PALETTES = [
    { id: 'aurora', name: 'Aurora', stops: ['#0b1a4a', '#1466a6', '#1fc6b2', '#9cf2a2', '#f4abff'] },
    { id: 'ultraviolet', name: 'Ultraviolet', stops: ['#2a0145', '#730d9e', '#9622c7', '#cd72f2', '#f6d4ff'] },
    { id: 'ember', name: 'Ember', stops: ['#2b0603', '#a1200b', '#ff5a1f', '#ffb347', '#fff0c9'] },
    { id: 'abyss', name: 'Abyss', stops: ['#020c2b', '#0b3d91', '#1f8fff', '#6fd3ff', '#e6fbff'] },
    { id: 'synth', name: 'Synthwave', stops: ['#250b5e', '#7a1fd6', '#ff2e88', '#ff9e3d', '#ffe8a3'] },
    { id: 'koi', name: 'Koi', stops: ['#0b1d2a', '#ef476f', '#ffd166', '#06d6a0', '#f4faff'] },
    { id: 'silver', name: 'Silver', stops: ['#262932', '#5f6577', '#a2a8b8', '#d9dde7', '#ffffff'] },
  ];

  const COUNTS = [
    { value: 16384, label: '16K' },
    { value: 65536, label: '65K' },
    { value: 262144, label: '262K' },
    { value: 1048576, label: '1M' },
  ];

  const SYMMETRY = [
    { value: 0, label: 'Off' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
    { value: 6, label: '6' },
    { value: 8, label: '8' },
  ];

  const SLIDERS = [
    { key: 'speed', label: 'Speed', group: 'motion' },
    { key: 'scale', label: 'Field scale', group: 'motion' },
    { key: 'evolve', label: 'Evolution', group: 'motion' },
    { key: 'trails', label: 'Trail length', group: 'motion' },
    { key: 'bright', label: 'Exposure', group: 'look' },
    { key: 'glow', label: 'Glow', group: 'look' },
    { key: 'spread', label: 'Color spread', group: 'look' },
  ];

  // Slider value (0..1) -> engine units.
  const MAP = {
    speed: v => 0.035 * Math.pow(10, v * 1.1),
    scale: v => 0.6 * Math.pow(6, v),
    evolve: v => 2.4 * v * v,
    trails: v => 1 - 0.25 * Math.pow(0.012, v),
    bright: v => 2.2 * Math.pow(4, v - 0.5),
    glow: v => 1.1 * Math.pow(v, 1.4),
    spread: v => v,
  };

  const isSmall = Math.min(window.innerWidth, window.innerHeight) < 600;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const DEFAULTS = {
    field: 'marble',
    palette: 'aurora',
    count: isSmall ? 16384 : 65536,
    speed: reducedMotion ? 0.3 : 0.5,
    scale: 0.42,
    evolve: reducedMotion ? 0.15 : 0.35,
    trails: 0.84,
    bright: 0.5,
    glow: 0.42,
    spread: 0.18,
    sym: 0,
    paper: false,
    auto: false,
    vectors: false,
    seed: (Math.random() * 1e6) | 0,
  };

  // ---------------------------------------------------------------- settings

  const HASH_KEYS = {
    field: 'f', palette: 'p', count: 'n', speed: 'sp', scale: 'sc', evolve: 'ev', trails: 'tr',
    bright: 'ex', glow: 'gl', spread: 'cs', sym: 'k', paper: 'ink', auto: 'auto', seed: 's',
  };

  function loadSettings() {
    const s = { ...DEFAULTS };
    let fromHash = false;
    try {
      const q = new URLSearchParams(location.hash.slice(1));
      for (const [key, short] of Object.entries(HASH_KEYS)) {
        if (!q.has(short)) continue;
        fromHash = true;
        const raw = q.get(short);
        const def = DEFAULTS[key];
        if (typeof def === 'boolean') s[key] = raw === '1';
        else if (typeof def === 'number') {
          const n = Number(raw);
          if (Number.isFinite(n)) s[key] = n;
        } else s[key] = raw;
      }
    } catch (e) { /* ignore a malformed hash */ }
    if (!FIELDS.some(f => f.id === s.field)) s.field = DEFAULTS.field;
    if (!PALETTES.some(p => p.id === s.palette)) s.palette = DEFAULTS.palette;
    if (!COUNTS.some(c => c.value === s.count)) s.count = DEFAULTS.count;
    if (!SYMMETRY.some(c => c.value === s.sym)) s.sym = 0;
    for (const sl of SLIDERS) s[sl.key] = Math.min(1, Math.max(0, s[sl.key]));
    return { s, fromHash };
  }

  let hashTimer = 0;
  function saveSettings() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const q = new URLSearchParams();
      for (const [key, short] of Object.entries(HASH_KEYS)) {
        const v = settings[key];
        q.set(short, typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v));
      }
      try { history.replaceState(null, '', '#' + q.toString()); } catch (e) { /* file:// in some browsers */ }
    }, 250);
  }

  const loaded = loadSettings();
  const settings = loaded.s;
  let userChoseCount = loaded.fromHash;

  // ---------------------------------------------------------------- helpers

  const $ = sel => document.querySelector(sel);
  const fieldIndex = id => FIELDS.findIndex(f => f.id === id);
  const fieldGl = id => FIELDS[fieldIndex(id)].gl;
  const paletteOf = id => PALETTES.find(p => p.id === id);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = t => t * t * (3 - 2 * t);

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function paletteArray(id) {
    return new Float32Array(paletteOf(id).stops.flatMap(hexToRgb));
  }

  function seedVec(seed) {
    let a = seed >>> 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return [rnd() * 200 - 100, rnd() * 200 - 100, rnd() * Math.PI * 2, rnd() * Math.PI * 2];
  }

  const fmtCount = n => n.toLocaleString('en-US');

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }

  // ---------------------------------------------------------------- engine

  const canvas = $('#stage');
  let engine;
  try {
    engine = new window.FlowEngine(canvas);
    await engine.ready();
  } catch (err) {
    console.error(err);
    const fb = $('#fallback');
    fb.hidden = false;
    fb.querySelector('.reason').textContent =
      err.code === 'webgl2' ? 'This browser does not expose WebGL2.' :
      err.code === 'float' ? 'This GPU cannot render to floating-point textures.' :
      err.message;
    document.body.classList.add('failed');
    return;
  }

  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    toast('GPU context lost — reloading');
    setTimeout(() => location.reload(), 900);
  });

  const LIFE = 4.2;
  let dpr = 1;

  // Never render more pixels than a 4K panel has. Scaled display modes
  // (e.g. "looks like 2560x1440" on a 4K screen) would otherwise render
  // 5120x2880 only for the OS to throw most of it away.
  const MAX_PIXELS = 3840 * 2160;

  function fitCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = window.innerWidth * window.innerHeight;
    if (css * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / css);
    const w = Math.max(2, Math.floor(window.innerWidth * dpr));
    const h = Math.max(2, Math.floor(window.innerHeight * dpr));
    engine.resize(w, h);
  }
  fitCanvas();
  engine.setParticleCount(settings.count, engine.width / engine.height, LIFE);
  window.addEventListener('resize', () => { fitCanvas(); live.dirty = true; });

  // ---------------------------------------------------------------- live state

  const live = {
    fieldA: fieldGl(settings.field),
    fieldB: fieldGl(settings.field),
    seedA: seedVec(settings.seed),
    seedB: seedVec(settings.seed),
    mix: 0,
    pal: paletteArray(settings.palette),
    palTarget: paletteArray(settings.palette),
    paper: settings.paper ? 1 : 0,
    vectors: settings.vectors ? 1 : 0,
    sym: settings.sym,
    symRot: 0,
    time: Math.random() * 100,
    clock: 0,
    hueShift: 0,
    paused: false,
    dirty: true,
  };

  function transitionTo(fieldId, seed) {
    if (live.mix > 0.5) {
      live.fieldA = live.fieldB;
      live.seedA = live.seedB;
    }
    live.fieldB = fieldGl(fieldId);
    live.seedB = seedVec(seed);
    live.mix = 1e-4;
  }

  // ---------------------------------------------------------------- actions

  function setField(id, { quiet = false } = {}) {
    if (settings.field === id && live.mix === 0) return;
    settings.field = id;
    transitionTo(id, settings.seed);
    syncUI();
    saveSettings();
    if (!quiet) toast(FIELDS[fieldIndex(id)].name);
  }

  function setPalette(id) {
    settings.palette = id;
    live.palTarget = paletteArray(id);
    syncUI();
    saveSettings();
  }

  function shuffle() {
    settings.seed = (Math.random() * 1e6) | 0;
    transitionTo(settings.field, settings.seed);
    saveSettings();
    toast('New seed · ' + settings.seed);
  }

  function setCount(n, { manual = true } = {}) {
    if (manual) userChoseCount = true;
    settings.count = n;
    fitCanvas();
    engine.setParticleCount(n, engine.width / engine.height, LIFE);
    fpsWindow.length = 0;
    syncUI();
    saveSettings();
  }

  function setPaper(on) {
    settings.paper = on;
    live.paper = on ? 1 : 0;
    engine.clear();
    document.body.classList.toggle('paper', on);
    syncUI();
    saveSettings();
  }

  function setSym(n) {
    settings.sym = n;
    live.sym = n;
    syncUI();
    saveSettings();
  }

  function cycle(list, current, dir) {
    const i = list.findIndex(x => (x.id ?? x.value) === current);
    const next = list[(i + dir + list.length) % list.length];
    return next.id ?? next.value;
  }

  function clearTrails() {
    engine.clear();
    live.dirty = true;
  }

  let wantSnapshot = false;
  function snapshot() {
    wantSnapshot = true;
  }

  function saveCanvas() {
    canvas.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `flow-lines-${settings.field}-${settings.seed}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
    toast('Snapshot saved');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen unavailable'));
  }

  function togglePause() {
    live.paused = !live.paused;
    document.body.classList.toggle('paused', live.paused);
    toast(live.paused ? 'Paused' : 'Flowing');
    syncUI();
  }

  function toggleUI() {
    document.body.classList.toggle('chrome-hidden');
  }

  function copyLink() {
    clearTimeout(hashTimer);
    saveSettings();
    setTimeout(() => {
      const url = location.href;
      (navigator.clipboard?.writeText(url) ?? Promise.reject())
        .then(() => toast('Link to this scene copied'))
        .catch(() => toast('Copy failed — the URL holds the scene'));
    }, 300);
  }

  // ---------------------------------------------------------------- UI build

  const ICONS = {
    pause: '<path d="M9 6v12M15 6v12"/>',
    play: '<path d="M8 6l10 6-10 6z"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  function el(tag, attrs = {}, html = '') {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    if (html) e.innerHTML = html;
    return e;
  }

  const ui = { fields: [], palettes: [], sliders: {}, counts: [], syms: [], toggles: {} };

  function buildUI() {
    const fieldsEl = $('#fields');
    FIELDS.forEach((f, i) => {
      const b = el('button', { class: 'chip', type: 'button', title: f.blurb, onclick: () => setField(f.id) },
        `<span class="chip-key">${i + 1}</span><span class="chip-name">${f.name}</span>`);
      fieldsEl.appendChild(b);
      ui.fields.push(b);
    });

    const palEl = $('#palettes');
    PALETTES.forEach(p => {
      const b = el('button', {
        class: 'swatch', type: 'button', title: p.name, 'aria-label': p.name + ' palette',
        style: `--g: linear-gradient(90deg, ${p.stops.map((c, i) => `${c} ${i * 20}% ${(i + 1) * 20}%`).join(', ')})`,
        onclick: () => setPalette(p.id),
      });
      palEl.appendChild(b);
      ui.palettes.push(b);
    });

    for (const sl of SLIDERS) {
      const wrap = el('label', { class: 'slider' },
        `<span class="fill"></span><span class="slider-label">${sl.label}</span><output></output>
         <input type="range" min="0" max="1" step="0.001" aria-label="${sl.label}">`);
      const input = wrap.querySelector('input');
      input.addEventListener('input', () => {
        settings[sl.key] = Number(input.value);
        syncSlider(sl.key);
        saveSettings();
      });
      input.addEventListener('dblclick', () => {
        settings[sl.key] = DEFAULTS[sl.key];
        syncSlider(sl.key);
        saveSettings();
      });
      $('#sliders-' + sl.group).appendChild(wrap);
      ui.sliders[sl.key] = { wrap, input, out: wrap.querySelector('output') };
    }

    const segment = (container, items, store, onPick) => {
      items.forEach(it => {
        const b = el('button', { type: 'button', onclick: () => onPick(it.value) }, it.label);
        container.appendChild(b);
        store.push({ b, value: it.value });
      });
    };
    segment($('#counts'), COUNTS, ui.counts, n => n !== settings.count && setCount(n));
    segment($('#syms'), SYMMETRY, ui.syms, setSym);

    const toggles = [
      { key: 'paper', label: 'Ink on paper', hint: 'P', on: v => setPaper(v) },
      { key: 'auto', label: 'Autopilot', hint: 'A', on: v => { settings.auto = v; autoClock = 0; saveSettings(); toast(v ? 'Autopilot on' : 'Autopilot off'); } },
      { key: 'vectors', label: 'Field vectors', hint: 'D', on: v => { settings.vectors = v; } },
    ];
    for (const t of toggles) {
      const b = el('button', { class: 'toggle', type: 'button', role: 'switch', onclick: () => { t.on(!settings[t.key]); syncUI(); } },
        `<span class="check"></span><span class="toggle-label">${t.label}</span><span class="key">${t.hint}</span>`);
      $('#toggles').appendChild(b);
      ui.toggles[t.key] = b;
    }

    const actions = [
      { label: 'Shuffle', key: 'R', run: shuffle },
      { label: 'Scatter', key: 'X', run: () => engine.scatter() },
      { label: 'Clear', key: 'C', run: clearTrails },
      { label: 'Snapshot', key: 'S', run: snapshot },
      { label: 'Copy link', key: 'L', run: copyLink },
      { label: 'Fullscreen', key: 'F', run: toggleFullscreen },
    ];
    for (const a of actions) {
      $('#actions').appendChild(el('button', { type: 'button', class: 'action', title: `${a.label} (${a.key})`, onclick: a.run },
        a.label));
    }

    $('#panelToggle').addEventListener('click', () => setPanel(!document.body.classList.contains('panel-open')));
    $('#panelClose').addEventListener('click', () => setPanel(false));
    $('#pauseBtn').addEventListener('click', togglePause);

    // Buttons should never keep keyboard focus: Space is the pause key.
    document.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) b.blur();
    });
  }

  let idleTimer = 0;

  // Real GPU time per frame (see the frame loop), shown in the readout.
  let gpuMs = 0;
  const gpuSamples = [];
  let gpuTimer = -2; // skip the first seconds, while pipelines warm up
  function showGpu() {
    $('#metaGpu').textContent = live.paused ? 'idle'
      : gpuMs ? `${gpuMs.toFixed(1)} ms (\u2248${Math.round(1000 / gpuMs)} fps)` : '\u2013';
  }

  function setPanel(open) {
    document.body.classList.toggle('panel-open', open);
    $('#panelToggle').setAttribute('aria-expanded', String(open));
    wake();
  }

  function syncSlider(key) {
    const { wrap, input, out } = ui.sliders[key];
    const v = settings[key];
    input.value = v;
    wrap.style.setProperty('--v', (v * 100).toFixed(2) + '%');
    out.textContent = key === 'speed' ? (MAP.speed(v) / MAP.speed(0.5)).toFixed(2) + '×'
      : key === 'scale' ? MAP.scale(v).toFixed(2)
      : Math.round(v * 100);
  }

  function syncUI() {
    live.dirty = true;
    ui.fields.forEach((b, i) => b.classList.toggle('active', FIELDS[i].id === settings.field));
    ui.palettes.forEach((b, i) => b.classList.toggle('active', PALETTES[i].id === settings.palette));
    ui.counts.forEach(({ b, value }) => b.classList.toggle('active', value === settings.count));
    ui.syms.forEach(({ b, value }) => b.classList.toggle('active', value === settings.sym));
    for (const [k, b] of Object.entries(ui.toggles)) {
      b.classList.toggle('on', !!settings[k]);
      b.setAttribute('aria-checked', String(!!settings[k]));
    }
    for (const sl of SLIDERS) syncSlider(sl.key);

    const pal = paletteOf(settings.palette);
    $('#paletteName').textContent = pal.name;

    $('#metaField').textContent = FIELDS[fieldIndex(settings.field)].name;
    $('#metaCount').textContent = fmtCount(settings.count);
    $('#pauseBtn').innerHTML = icon(live.paused ? 'play' : 'pause');
    showGpu();
    $('#pauseBtn').setAttribute('aria-label', live.paused ? 'Resume' : 'Pause');
  }

  buildUI();
  document.body.classList.toggle('paper', settings.paper);
  setPanel(window.innerWidth > 720);
  syncUI();

  // ---------------------------------------------------------------- input

  const pointer = { x: 0, y: 0, vx: 0, vy: 0, rawVx: 0, rawVy: 0, t: 0, has: false, down: false, on: 0, press: 0, lastMove: -1e9 };

  function toWorld(e) {
    const aspect = engine.width / engine.height;
    return [e.clientX / window.innerWidth * aspect, 1 - e.clientY / window.innerHeight];
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; // left button / touch / pen tip only
    const [x, y] = toWorld(e);
    Object.assign(pointer, { x, y, t: performance.now(), has: true, down: true, rawVx: 0, rawVy: 0, lastMove: performance.now() });
    canvas.setPointerCapture(e.pointerId);
    dismissHint();
  });
  canvas.addEventListener('pointermove', e => {
    const now = performance.now();
    const [x, y] = toWorld(e);
    if (pointer.has) {
      const dt = Math.max(8, now - pointer.t) / 1000;
      pointer.rawVx = (x - pointer.x) / dt;
      pointer.rawVy = (y - pointer.y) / dt;
    }
    Object.assign(pointer, { x, y, t: now, has: true, lastMove: now });
  });
  const release = () => { pointer.down = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') pointer.has = false; });

  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches?.('input[type="text"], textarea')) return;
    const k = e.key.toLowerCase();
    const n = Number(e.key);
    if (n >= 1 && n <= FIELDS.length) { setField(FIELDS[n - 1].id); return; }
    switch (k) {
      case ' ': e.preventDefault(); togglePause(); break;
      case 'h': toggleUI(); break;
      case 'd': settings.vectors = !settings.vectors; syncUI(); break;
      case 'p': setPaper(!settings.paper); break;
      case 'a': ui.toggles.auto.click(); break;
      case 'r': shuffle(); break;
      case 's': snapshot(); break;
      case 'c': clearTrails(); break;
      case 'f': toggleFullscreen(); break;
      case 'l': copyLink(); break;
      case 'k': setSym(cycle(SYMMETRY, settings.sym, 1)); break;
      case 'x': engine.scatter(); break;
      case 'tab': e.preventDefault(); setPanel(!document.body.classList.contains('panel-open')); break;
      case 'arrowright': case ']': setPalette(cycle(PALETTES, settings.palette, 1)); toast(paletteOf(settings.palette).name); break;
      case 'arrowleft': case '[': setPalette(cycle(PALETTES, settings.palette, -1)); toast(paletteOf(settings.palette).name); break;
      default: return;
    }
    dismissHint();
  });

  // Idle: after a while without input the interface melts away.
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Only melt away when the settings panel is closed.
      if (!document.body.classList.contains('panel-open')) document.body.classList.add('idle');
    }, 4500);
  }
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(t => window.addEventListener(t, wake, { passive: true }));
  wake();

  let hintGone = false;
  function dismissHint() {
    if (hintGone) return;
    hintGone = true;
    $('#hint').classList.add('gone');
  }
  setTimeout(dismissHint, 9000);

  // ---------------------------------------------------------------- loop

  const fpsWindow = [];
  let fpsShown = 60;
  let fpsTimer = 0;
  let autoClock = 0;
  let autoPaletteClock = 0;
  let adaptiveChecks = 0;
  let lowStreak = 0;
  let last = performance.now();
  const startTime = last;

  const params = {
    mouse: [0, 0], mouseVel: [0, 0], bg: [0.012, 0.012, 0.02], paperCol: [0.955, 0.94, 0.905],
    arrowCol: [1, 0.36, 0.36],
  };

  function loop(now) {
    requestAnimationFrame(loop);
    frame(now);
  }

  function frame(now) {
    const rawDt = Math.max(0, (now - last) / 1000);
    last = now;
    const dt = Math.min(rawDt, 1 / 20);

    // fps + adaptive particle budget
    // Ignore stalls (hidden tab, throttled pane) so they never count as slowness.
    if (rawDt > 0 && rawDt < 0.2) fpsWindow.push(rawDt);
    if (fpsWindow.length > 90) fpsWindow.shift();
    fpsTimer += rawDt;
    if (fpsTimer > 0.5) {
      fpsTimer = 0;
      const avg = fpsWindow.reduce((a, b) => a + b, 0) / fpsWindow.length;
      fpsShown = Math.round(1 / avg);
      $('#metaFps').textContent = fpsShown;
      if (!userChoseCount && !live.paused && adaptiveChecks < 3 && now - startTime > 4000 && fpsWindow.length >= 90 && document.visibilityState === 'visible' && document.hasFocus()) {
        const i = COUNTS.findIndex(c => c.value === settings.count);
        lowStreak = fpsShown < 45 ? lowStreak + 1 : 0;
        if (lowStreak >= 6 && i > 0) {
          lowStreak = 0;
          adaptiveChecks++;
          setCount(COUNTS[i - 1].value, { manual: false });
          toast(`Easing to ${COUNTS[i - 1].label} particles for smoother motion`);
        }
      }
    }

    // field transitions
    if (live.mix > 0) {
      live.mix += dt / 2.2;
      if (live.mix >= 1) {
        live.fieldA = live.fieldB;
        live.seedA = live.seedB;
        live.mix = 0;
      }
    }

    // palette blend
    const k = 1 - Math.exp(-dt * 2.5);
    for (let i = 0; i < 15; i++) live.pal[i] = lerp(live.pal[i], live.palTarget[i], k);
    live.vectors = live.paused ? (settings.vectors ? 1 : 0) : lerp(live.vectors, settings.vectors ? 1 : 0, 1 - Math.exp(-dt * 8));

    // autopilot
    if (settings.auto && !live.paused) {
      autoClock += dt;
      autoPaletteClock += dt;
      if (autoClock > 13) {
        autoClock = 0;
        const others = FIELDS.filter(f => f.id !== settings.field);
        settings.seed = (Math.random() * 1e6) | 0;
        setField(others[(Math.random() * others.length) | 0].id);
      }
      if (autoPaletteClock > 27) {
        autoPaletteClock = 0;
        setPalette(cycle(PALETTES, settings.palette, 1));
      }
    }

    // pointer easing
    const idleMs = now - pointer.lastMove;
    if (idleMs > 60 || !pointer.down) { pointer.rawVx = 0; pointer.rawVy = 0; }
    const pk = 1 - Math.exp(-dt * 14);
    pointer.vx = lerp(pointer.vx, pointer.rawVx, pk);
    pointer.vy = lerp(pointer.vy, pointer.rawVy, pk);
    const vmag = Math.hypot(pointer.vx, pointer.vy);
    if (vmag > 3) { pointer.vx *= 3 / vmag; pointer.vy *= 3 / vmag; }
    // Only an active left-drag touches the fluid; hovering never does.
    const active = pointer.down;
    pointer.on = lerp(pointer.on, active ? 1 : 0, 1 - Math.exp(-dt * (active ? 10 : 2)));
    pointer.press = lerp(pointer.press, pointer.down ? 1 : 0, 1 - Math.exp(-dt * 6));

    if (!live.paused) {
      live.time += dt * MAP.evolve(settings.evolve);
      live.hueShift += dt * 0.006 * (0.3 + MAP.evolve(settings.evolve));
      if (live.sym > 1) live.symRot += dt * 0.025;
    }
    live.clock += rawDt;

    const aspect = engine.width / engine.height;
    const speed = MAP.speed(settings.speed);
    const decay60 = MAP.trails(settings.trails);
    const count = engine.count;
    const intensity = 0.75 * Math.pow(1 - decay60, 0.8) * (engine.width / 1000)
      * Math.pow(262144 / count, 0.8) * Math.pow(MAP.speed(0.5) / speed, 0.45);

    Object.assign(params, {
      step: !live.paused,
      dt,
      time: live.time,
      clock: live.clock,
      aspect,
      scale: MAP.scale(settings.scale),
      speed,
      life: LIFE,
      fieldA: live.fieldA,
      fieldB: live.fieldB,
      fieldMix: live.mix > 0 ? ease(Math.min(1, live.mix)) : 0,
      seedA: live.seedA,
      seedB: live.seedB,
      mouseOn: pointer.on,
      mouseDown: pointer.press,
      decay: Math.pow(decay60, dt * 60),
      intensity,
      paper: live.paper,
      hueShift: live.hueShift,
      spread: MAP.spread(settings.spread),
      palette: live.pal,
      bloom: MAP.glow(settings.glow) * (settings.paper ? 0.35 : 1),
      exposure: MAP.bright(settings.bright) * (settings.paper ? 0.7 : 1),
      sym: live.sym,
      symRot: live.symRot,
      vectors: live.vectors,
      // Above ~262K particles, baking the field into a grid is far cheaper
      // than evaluating it twice per particle.
      useGrid: count >= 262144,
      // Slightly under one CSS pixel: silky on high-DPI screens, never below 1px.
      lineWidth: Math.max(1, 0.85 * dpr),
    });
    params.mouse[0] = pointer.x;
    params.mouse[1] = pointer.y;
    params.mouseVel[0] = pointer.vx;
    params.mouseVel[1] = pointer.vy;
    params.arrowCol = settings.paper ? [0.75, 0.12, 0.16] : [1, 0.38, 0.38];

    // While paused the GPU idles: only redraw when something visible changed.
    if (!live.paused || live.dirty || wantSnapshot) {
      // Every two seconds, time one frame end to end on the GPU: drain the
      // queue, time an empty round trip, then render and wait. The display
      // caps what you see (usually 60 fps); this shows what the GPU could
      // actually sustain.
      gpuTimer += rawDt;
      if (gpuTimer > 2 && !live.paused && document.visibilityState === 'visible') {
        gpuTimer = 0;
        engine.waitForGpu();
        const t0 = performance.now();
        engine.waitForGpu();
        const t1 = performance.now();
        engine.render(params);
        engine.waitForGpu();
        const t2 = performance.now();
        // Other work on the GPU (other tabs, apps) can only add time, so the
        // best of the last few samples is the honest estimate.
        gpuSamples.push([t2 - t1, t1 - t0]);
        if (gpuSamples.length > 5) gpuSamples.shift();
        const frameMs = Math.min(...gpuSamples.map(x => x[0]));
        const syncMs = Math.min(...gpuSamples.map(x => x[1]));
        gpuMs = Math.max(0.3, frameMs - syncMs);
        showGpu();
      } else {
        engine.render(params);
      }
      live.dirty = false;
    }

    if (wantSnapshot) {
      wantSnapshot = false;
      saveCanvas();
    }
  }

  // Run a few frames before anything is visible, so GPU pipelines are built
  // and the first trails exist, then fade the canvas in.
  for (let i = 0; i < 3; i++) frame(last + 1000 / 60);
  last = performance.now();
  requestAnimationFrame(loop);
  requestAnimationFrame(() => document.body.classList.remove('booting'));

  // Handy for tinkering from the console.
  window.flowLines = {
    engine, settings, live, setField, setPalette, setCount, shuffle,
    // Step the simulation n frames synchronously (handy for testing in throttled tabs).
    warm(n = 120) {
      for (let i = 0; i < n; i++) frame(last + 1000 / 60);
      last = performance.now();
    },
  };
})();
