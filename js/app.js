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
    { key: 'vol', label: 'Volume', group: 'sound' },
    { key: 'mixPad', label: 'Pad', group: 'sound' },
    { key: 'mixShimmer', label: 'Shimmer', group: 'sound' },
    { key: 'mixNotes', label: 'Notes', group: 'sound' },
    { key: 'mixBass', label: 'Bass', group: 'sound' },
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
    auto: true,
    vectors: false,
    sound: false, // never restored from a link: browsers only allow audio after a click
    vol: 0.7,
    mixPad: 0.8,
    mixShimmer: 0.8,
    mixNotes: 0.75,
    mixBass: 0.7,
    seed: (Math.random() * 1e6) | 0,
  };

  // ---------------------------------------------------------------- settings

  const HASH_KEYS = {
    field: 'f', palette: 'p', count: 'n', speed: 'sp', scale: 'sc', evolve: 'ev', trails: 'tr',
    bright: 'ex', glow: 'gl', spread: 'cs', sym: 'k', paper: 'ink', auto: 'auto', seed: 's',
    vol: 'vol', mixPad: 'mp', mixShimmer: 'msh', mixNotes: 'mn', mixBass: 'mb',
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
    // A fresh visit starts somewhere new; a shared link restores its scene.
    if (!fromHash) {
      s.field = FIELDS[(Math.random() * FIELDS.length) | 0].id;
      s.palette = PALETTES[(Math.random() * PALETTES.length) | 0].id;
    }
    if (!FIELDS.some(f => f.id === s.field)) s.field = DEFAULTS.field;
    if (!PALETTES.some(p => p.id === s.palette)) s.palette = DEFAULTS.palette;
    if (!COUNTS.some(c => c.value === s.count)) s.count = DEFAULTS.count;
    if (!SYMMETRY.some(c => c.value === s.sym)) s.sym = 0;
    for (const sl of SLIDERS) s[sl.key] = Math.min(1, Math.max(0, s[sl.key]));
    return { s, fromHash };
  }

  // The scene as a link, for Copy link. The address bar itself stays clean.
  function sceneUrl() {
    const q = new URLSearchParams();
    for (const [key, short] of Object.entries(HASH_KEYS)) {
      const v = settings[key];
      q.set(short, typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v));
    }
    return location.origin + location.pathname + '#' + q.toString();
  }

  const loaded = loadSettings();
  const settings = loaded.s;
  // A shared link has done its job once loaded: show the plain address.
  if (location.hash || location.search) {
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// in some browsers */ }
  }
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

  const audio = window.FlowAudio ? new window.FlowAudio() : null;
  const noteBuf = new Float32Array(32);

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
  // When the shape changes (a phone rotating), spread the particles over the
  // new shape right away instead of leaving an empty strip until they respawn.
  let fitAspect = engine.width / engine.height;
  window.addEventListener('resize', () => {
    fitCanvas();
    live.dirty = true;
    const aspect = engine.width / engine.height;
    if (Math.abs(aspect / fitAspect - 1) > 0.1) engine.scatter();
    fitAspect = aspect;
  });

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
    symA: settings.sym,
    symB: settings.sym,
    symMix: 0,
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
    if (!quiet) toast(FIELDS[fieldIndex(id)].name);
  }

  function setPalette(id) {
    settings.palette = id;
    live.palTarget = paletteArray(id);
    syncUI();
  }

  function shuffle() {
    settings.seed = (Math.random() * 1e6) | 0;
    transitionTo(settings.field, settings.seed);
    toast('New seed · ' + settings.seed);
  }

  function setCount(n, { manual = true } = {}) {
    if (manual) userChoseCount = true;
    settings.count = n;
    fitCanvas();
    engine.setParticleCount(n, engine.width / engine.height, LIFE);
    fpsWindow.length = 0;
    syncUI();
  }

  function setPaper(on) {
    settings.paper = on;
    live.paper = on ? 1 : 0;
    engine.clear();
    document.body.classList.toggle('paper', on);
    syncUI();
  }

  function setSym(n) {
    settings.sym = n;
    // Cross-fade from the fold on screen to the new one (see the frame loop).
    if (live.symMix > 0.5) live.symA = live.symB;
    if (n === live.symA && live.symMix === 0) return syncUI();
    live.symB = n;
    live.symMix = 1e-4;
    syncUI();
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
    audio?.setRunning(!live.paused && document.visibilityState === 'visible');
    toast(live.paused ? 'Paused' : 'Flowing');
    syncUI();
  }

  async function setSound(on) {
    if (!audio) { toast('Sound is not supported in this browser'); return; }
    if (on) {
      try {
        await audio.start(); // must stay inside the click that called us
      } catch (err) {
        console.error(err);
        toast('Could not start sound');
        return;
      }
    }
    settings.sound = on;
    audio.setRunning(!live.paused && document.visibilityState === 'visible');
    audio.setEnabled(on);
    document.body.classList.toggle('sound-on', on);
    if (on) dismissSoundHint();
    syncUI();
    toast(on ? 'Sound on' : 'Sound off');
  }

  function scatter() {
    engine.scatter();
    audio?.onScatter();
  }

  document.addEventListener('visibilitychange', () => {
    audio?.setRunning(!live.paused && document.visibilityState === 'visible');
  });

  function toggleUI() {
    document.body.classList.toggle('chrome-hidden');
  }

  function copyLink() {
    (navigator.clipboard?.writeText(sceneUrl()) ?? Promise.reject())
      .then(() => toast('Link to this scene copied'))
      .catch(() => toast('Copy failed'));
  }

  // ---------------------------------------------------------------- autopilot

  // A small director. Every kind of change runs on its own random schedule,
  // motion and light settings glide toward new targets instead of jumping,
  // big changes are spaced apart, and anything you touch yourself is left
  // alone for a while.
  const AUTO_RANGES = {
    speed: [0.3, 0.72], scale: [0.2, 0.75], evolve: [0.15, 0.6], trails: [0.62, 0.94],
    bright: [0.42, 0.66], glow: [0.25, 0.7], spread: [0.05, 0.6],
  };
  const MOTION_KEYS = ['speed', 'scale', 'evolve', 'trails'];
  const LIGHT_KEYS = ['bright', 'glow', 'spread'];
  const KALEIDO_FOLDS = [2, 3, 4, 6, 8];
  const HOLD_MS = 30000;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[(Math.random() * arr.length) | 0];
  const pickSome = (arr, min, max) => arr.slice().sort(() => Math.random() - 0.5).slice(0, Math.round(rand(min, max)));

  const heldUntil = {};
  function hold(key) { heldUntil[key] = performance.now() + HOLD_MS; }
  const isHeld = key => (heldUntil[key] || 0) > performance.now();

  const auto = {
    t: 0,
    lastBig: -1e9,
    next: {},
    glides: {},
    ghost: null,

    reset() {
      this.t = 0;
      this.lastBig = -1e9;
      this.glides = {};
      this.ghost = null;
      this.next = {
        field: rand(6, 14), seed: rand(25, 50), palette: rand(10, 22), motion: rand(2, 6),
        light: rand(3, 8), kaleido: rand(18, 40), scatter: rand(35, 80), stir: rand(8, 18),
      };
    },

    glide(key, to, dur) {
      if (isHeld(key)) return;
      this.glides[key] = { from: settings[key], to, start: this.t, dur };
    },

    // Field, palette and kaleidoscope changes are "big": keep them apart.
    big() {
      if (this.t - this.lastBig < 4) return false;
      this.lastBig = this.t;
      return true;
    },

    events: {
      field() {
        if (isHeld('field') || !auto.big()) return rand(2, 5);
        settings.seed = (Math.random() * 1e6) | 0;
        setField(pick(FIELDS.filter(f => f.id !== settings.field)).id, { quiet: true });
        return rand(9, 26);
      },
      seed() {
        if (isHeld('field')) return rand(5, 10);
        settings.seed = (Math.random() * 1e6) | 0;
        transitionTo(settings.field, settings.seed);
        return rand(20, 45);
      },
      palette() {
        if (isHeld('palette') || !auto.big()) return rand(2, 5);
        setPalette(pick(PALETTES.filter(p => p.id !== settings.palette)).id);
        return rand(12, 32);
      },
      motion() {
        for (const k of pickSome(MOTION_KEYS, 1, 3)) auto.glide(k, rand(...AUTO_RANGES[k]), rand(4, 11));
        return rand(6, 16);
      },
      light() {
        for (const k of pickSome(LIGHT_KEYS, 1, 2)) auto.glide(k, rand(...AUTO_RANGES[k]), rand(3, 8));
        return rand(5, 14);
      },
      // Kaleidoscope comes in sessions: on for a while, maybe a fold change, then off.
      kaleido() {
        if (isHeld('sym') || !auto.big()) return rand(2, 5);
        if (settings.sym === 0) {
          setSym(pick(KALEIDO_FOLDS));
          return rand(10, 24);
        }
        if (Math.random() < 0.4) {
          setSym(pick(KALEIDO_FOLDS.filter(n => n !== settings.sym)));
          return rand(8, 18);
        }
        setSym(0);
        return rand(25, 60);
      },
      scatter() {
        scatter();
        return rand(40, 95);
      },
      // A ghost hand drags a slow arc through the fluid.
      stir() {
        if (pointer.down) return rand(5, 10);
        const aspect = engine.width / engine.height;
        auto.ghost = {
          start: auto.t,
          dur: rand(1.6, 3.4),
          cx: rand(0.25, 0.75) * aspect,
          cy: rand(0.25, 0.75),
          r: rand(0.08, 0.2),
          a0: rand(0, Math.PI * 2),
          sweep: rand(2.5, 6) * (Math.random() < 0.5 ? -1 : 1),
        };
        return rand(10, 30);
      },
    },

    update(dt) {
      this.t += dt;
      for (const [name, fn] of Object.entries(this.events)) {
        if (this.t >= this.next[name]) this.next[name] = this.t + fn();
      }
      for (const [key, g] of Object.entries(this.glides)) {
        if (isHeld(key)) { delete this.glides[key]; continue; }
        const u = Math.min(1, (this.t - g.start) / g.dur);
        settings[key] = lerp(g.from, g.to, ease(u));
        syncSlider(key);
        if (u >= 1) {
          delete this.glides[key];
        }
      }
    },

    // Position and velocity of the ghost hand, or null when it isn't stirring.
    ghostPointer() {
      const g = this.ghost;
      if (!g) return null;
      const u = (this.t - g.start) / g.dur;
      if (u >= 1 || pointer.down) { this.ghost = null; return null; }
      const a = g.a0 + g.sweep * ease(u);
      const da = g.sweep * 6 * u * (1 - u) / g.dur; // d(angle)/dt of the eased sweep
      return {
        x: g.cx + Math.cos(a) * g.r,
        y: g.cy + Math.sin(a) * g.r,
        vx: -Math.sin(a) * g.r * da,
        vy: Math.cos(a) * g.r * da,
      };
    },
  };
  auto.reset();

  // ---------------------------------------------------------------- UI build

  const ICONS = {
    pause: '<path d="M9 6v12M15 6v12"/>',
    play: '<path d="M8 6l10 6-10 6z"/>',
    sound: '<path d="M4 9.5h3l5-4v13l-5-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
    mute: '<path d="M4 9.5h3l5-4v13l-5-4H4z"/><path d="M16 10l5 4M21 10l-5 4"/>',
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
      const b = el('button', { class: 'chip', type: 'button', title: f.blurb, onclick: () => { hold('field'); setField(f.id); } },
        `<span class="chip-key">${i + 1}</span><span class="chip-name">${f.name}</span>`);
      fieldsEl.appendChild(b);
      ui.fields.push(b);
    });

    const palEl = $('#palettes');
    PALETTES.forEach(p => {
      const b = el('button', {
        class: 'swatch', type: 'button', title: p.name, 'aria-label': p.name + ' palette',
        style: `--g: linear-gradient(90deg, ${p.stops.map((c, i) => `${c} ${i * 20}% ${(i + 1) * 20}%`).join(', ')})`,
        onclick: () => { hold('palette'); setPalette(p.id); },
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
        hold(sl.key);
        settings[sl.key] = Number(input.value);
        syncSlider(sl.key);
      });
      input.addEventListener('dblclick', () => {
        hold(sl.key);
        settings[sl.key] = DEFAULTS[sl.key];
        syncSlider(sl.key);
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
    segment($('#syms'), SYMMETRY, ui.syms, n => { hold('sym'); setSym(n); });

    const toggles = [
      { key: 'paper', label: 'Ink on paper', hint: 'P', on: v => setPaper(v) },
      { key: 'auto', label: 'Autopilot', hint: 'A', on: v => { settings.auto = v; auto.reset(); toast(v ? 'Autopilot on' : 'Autopilot off'); } },
      { key: 'vectors', label: 'Field vectors', hint: 'D', on: v => { settings.vectors = v; } },
      { key: 'sound', label: 'Sound', hint: 'M', parent: '#soundToggles', on: v => setSound(v) },
    ];
    for (const t of toggles) {
      const b = el('button', { class: 'toggle', type: 'button', role: 'switch', onclick: () => { t.on(!settings[t.key]); syncUI(); } },
        `<span class="check"></span><span class="toggle-label">${t.label}</span><span class="key">${t.hint}</span>`);
      $(t.parent || '#toggles').appendChild(b);
      ui.toggles[t.key] = b;
    }

    const actions = [
      { label: 'Shuffle', key: 'R', run: shuffle },
      { label: 'Scatter', key: 'X', run: scatter },
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
    $('#soundBtn').addEventListener('click', () => setSound(!settings.sound));

    // Buttons should never keep keyboard focus: Space is the pause key.
    document.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) b.blur();
    });
  }

  let idleTimer = 0;

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
    $('#pauseBtn').setAttribute('aria-label', live.paused ? 'Resume' : 'Pause');
    $('#soundBtn').innerHTML = icon(settings.sound ? 'sound' : 'mute');
    $('#soundBtn').setAttribute('aria-label', settings.sound ? 'Sound off' : 'Sound on');
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
    if (n >= 1 && n <= FIELDS.length) { hold('field'); setField(FIELDS[n - 1].id); return; }
    switch (k) {
      case ' ': e.preventDefault(); togglePause(); break;
      case 'h': toggleUI(); break;
      case 'd': settings.vectors = !settings.vectors; syncUI(); break;
      case 'p': setPaper(!settings.paper); break;
      case 'a': ui.toggles.auto.click(); break;
      case 'r': hold('field'); shuffle(); break;
      case 's': snapshot(); break;
      case 'c': clearTrails(); break;
      case 'f': toggleFullscreen(); break;
      case 'l': copyLink(); break;
      case 'k': hold('sym'); setSym(cycle(SYMMETRY, settings.sym, 1)); break;
      case 'x': scatter(); break;
      case 'm': setSound(!settings.sound); break;
      case 'tab': e.preventDefault(); setPanel(!document.body.classList.contains('panel-open')); break;
      case 'arrowright': case ']': hold('palette'); setPalette(cycle(PALETTES, settings.palette, 1)); toast(paletteOf(settings.palette).name); break;
      case 'arrowleft': case '[': hold('palette'); setPalette(cycle(PALETTES, settings.palette, -1)); toast(paletteOf(settings.palette).name); break;
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

  // Touch screens get touch words.
  if (matchMedia('(hover: none)').matches) {
    $('#hint').textContent = 'Drag to stir. Hold still to spin a vortex.';
    $('#soundHint .sound-hint-how').textContent = 'Tap the speaker.';
  }

  let hintGone = false;
  function dismissHint() {
    if (hintGone) return;
    hintGone = true;
    $('#hint').classList.add('gone');
  }
  setTimeout(dismissHint, 9000);

  // Sound can't start on its own (browsers need a click), so invite it once.
  let soundHintTimer = 0;
  function dismissSoundHint() {
    clearTimeout(soundHintTimer);
    $('#soundHint').classList.add('gone');
  }
  if (audio && !settings.sound) {
    $('#soundHint').classList.remove('gone');
    soundHintTimer = setTimeout(dismissSoundHint, 25000);
  }

  // ---------------------------------------------------------------- loop

  const fpsWindow = [];
  let fpsShown = 60;
  let fpsTimer = 0;
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
      if (audio && settings.sound) $('#metaKey').textContent = audio.keyName;
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

    // kaleidoscope cross-fade (keeps redrawing even while paused)
    if (live.symMix > 0) {
      live.symMix += rawDt / 1.5;
      live.dirty = true;
      if (live.symMix >= 1) {
        live.symA = live.symB;
        live.symMix = 0;
      }
    }

    // palette blend
    const k = 1 - Math.exp(-dt * 2.5);
    for (let i = 0; i < 15; i++) live.pal[i] = lerp(live.pal[i], live.palTarget[i], k);
    live.vectors = live.paused ? (settings.vectors ? 1 : 0) : lerp(live.vectors, settings.vectors ? 1 : 0, 1 - Math.exp(-dt * 8));

    // autopilot
    if (settings.auto && !live.paused) auto.update(dt);

    // pointer easing (the autopilot's ghost hand drives it when you aren't)
    const ghost = settings.auto && !live.paused ? auto.ghostPointer() : null;
    if (ghost) Object.assign(pointer, { x: ghost.x, y: ghost.y, rawVx: ghost.vx, rawVy: ghost.vy, lastMove: now });
    const idleMs = now - pointer.lastMove;
    if (idleMs > 60 || !(pointer.down || ghost)) { pointer.rawVx = 0; pointer.rawVy = 0; }
    const pk = 1 - Math.exp(-dt * 14);
    pointer.vx = lerp(pointer.vx, pointer.rawVx, pk);
    pointer.vy = lerp(pointer.vy, pointer.rawVy, pk);
    const vmag = Math.hypot(pointer.vx, pointer.vy);
    if (vmag > 3) { pointer.vx *= 3 / vmag; pointer.vy *= 3 / vmag; }
    // Only an active left-drag touches the fluid; hovering never does.
    const active = pointer.down || !!ghost;
    pointer.on = lerp(pointer.on, active ? 1 : 0, 1 - Math.exp(-dt * (active ? 10 : 2)));
    pointer.press = lerp(pointer.press, active ? 1 : 0, 1 - Math.exp(-dt * 6));

    if (!live.paused) {
      live.time += dt * MAP.evolve(settings.evolve);
      live.hueShift += dt * 0.006 * (0.3 + MAP.evolve(settings.evolve));
      if (live.symA > 1 || live.symB > 1) live.symRot += dt * 0.025;
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
      symA: live.symA,
      symB: live.symB,
      symMix: live.symMix > 0 ? ease(Math.min(1, live.symMix)) : 0,
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

    // Sound: flares for the notes sounding now, tinted by the palette.
    const soundOn = !!(settings.sound && audio && !live.paused);
    params.sound = soundOn;
    if (soundOn) {
      params.notes = audio.visualNotes(noteBuf);
      params.noteTint = settings.paper ? [0.55, 0.55, 0.6] : hexToRgb(paletteOf(settings.palette).stops[4]);
    }

    // While paused the GPU idles: only redraw when something visible changed.
    if (!live.paused || live.dirty || wantSnapshot) {
      engine.render(params);
      live.dirty = false;
    }

    if (soundOn) {
      const snd = engine.takeSound();
      audio.update({
        dt: rawDt,
        singers: snd && snd.singers,
        grid: snd && snd.grid,
        gridScale: snd ? snd.gridScale : 1,
        gridW: snd ? snd.gridW : 1,
        gridH: snd ? snd.gridH : 1,
        aspect,
        speedUnits: speed,
        life: LIFE,
        speed: settings.speed,
        trails: settings.trails,
        glow: settings.glow,
        spread: settings.spread,
        evolve: settings.evolve,
        scale: settings.scale,
        vol: settings.vol,
        mixPad: settings.mixPad,
        mixShimmer: settings.mixShimmer,
        mixNotes: settings.mixNotes,
        mixBass: settings.mixBass,
        field: settings.field,
        palette: settings.palette,
        sym: settings.sym,
        paper: settings.paper,
        pointer: { x: pointer.x, y: pointer.y, vx: pointer.vx, vy: pointer.vy, on: pointer.on, press: pointer.press },
      });
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
    engine, audio, settings, live, setField, setPalette, setCount, shuffle,
    // Step the simulation n frames synchronously (handy for testing in throttled tabs).
    warm(n = 120) {
      for (let i = 0; i < n; i++) frame(last + 1000 / 60);
      last = performance.now();
    },
  };
})();
