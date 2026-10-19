/*
 * Flow Lines — sound ("Glass").
 *
 * Particles as texture, notes only when something happens:
 *   shimmer  "particle grains": tiny glassy tones (an inharmonic FM pair,
 *            like a struck bar) shed by the bright parts of the image. Height
 *            is pitch, left/right is pan, and how much the picture is
 *            changing sets how many there are.
 *   notes    sparse, soft bells: a quiet phrase every few seconds, a cadence
 *            when the field changes, a rising figure on scatter.
 *   pad      a light chord bed underneath (detuned sawtooth ensembles with
 *            natural drift, chorus, a long hall), crossfading to a new chord
 *            every 9-16 s, slower when Evolution is low.
 *   bass     a soft sine under each chord.
 *   wind     the moving mass of strands blowing across strings tuned to the
 *            chord, like an aeolian harp. Where the strands flow sets which
 *            strings sing and where they sit in stereo; faster flow makes each
 *            string hop up its harmonics; turbulence makes it flutter.
 *
 * The first palette sets the key; later palettes change the mode over the
 * same root. Field changes land on a chord change, dragging opens the pad and
 * draws grains to your hand, the kaleidoscope adds echoes.
 *
 * FlowSound runs on any BaseAudioContext, so the same code plays live and
 * renders offline (FlowSound.renderOffline) from a recorded trace of what the
 * visuals did. Everything is scheduled at explicit times, never "now".
 */
(function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (dt, tau) => 1 - Math.exp(-dt / tau);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Palette -> key, mode, and how bright the instruments are.
  const KEYS = {
    aurora:      { root: 2,  mode: 'Lydian',     steps: [0, 2, 4, 6, 7, 9, 11], bright: 1.0 },
    ultraviolet: { root: 1,  mode: 'Aeolian',    steps: [0, 2, 3, 5, 7, 8, 10], bright: 0.75 },
    ember:       { root: 4,  mode: 'Dorian',     steps: [0, 2, 3, 5, 7, 9, 10], bright: 0.8 },
    abyss:       { root: 2,  mode: 'Aeolian',    steps: [0, 2, 3, 5, 7, 8, 10], bright: 0.6 },
    synth:       { root: 9,  mode: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10], bright: 1.05 },
    koi:         { root: 7,  mode: 'Ionian',     steps: [0, 2, 4, 5, 7, 9, 11], bright: 0.95 },
    silver:      { root: 10, mode: 'Lydian',     steps: [0, 2, 4, 6, 7, 9, 11], bright: 1.1 },
  };

  // Generated palettes bring their own mood (see app.js): any of these modes.
  const MODE_STEPS = {
    Ionian: [0, 2, 4, 5, 7, 9, 11],
    Dorian: [0, 2, 3, 5, 7, 9, 10],
    Mixolydian: [0, 2, 4, 5, 7, 9, 10],
    Aeolian: [0, 2, 3, 5, 7, 8, 10],
    Lydian: [0, 2, 4, 6, 7, 9, 11],
  };

  // Which layers play, and how loud. "glass" is the live sound (chosen by ear
  // from three rendered directions); the others are kept for comparison.
  // windStyle: 'harp' (clear singing tones with a whisper of air) or
  // 'breath' (the same strings, much airier).
  const RECIPES = {
    bloom: { pad: 1.0, bass: 1.0, shimmer: 1.0, notes: 1.0, bell: false, wind: 0 },
    drift: { pad: 1.0, bass: 1.0, shimmer: 1.2, notes: 0.0, bell: false, wind: 0 },
    glass: { pad: 0.5, bass: 0.8, shimmer: 0.9, notes: 1.0, bell: true, wind: 1.0, windStyle: 'harp' },
  };

  const STRINGS = 7;
  const PARTIALS = [1, 2, 3];

  const FADE_IN = new Float32Array(64).map((_, i) => Math.sin(Math.PI / 2 * i / 63));
  const FADE_OUT = new Float32Array(64).map((_, i) => Math.cos(Math.PI / 2 * i / 63));
  // Grain envelope: a soft 12% attack, then a natural decay, like tapping
  // glass. (A symmetric swell made overlapping grains blur into a held chord
  // that read as a high organ stop: earshot "Organ", z +3.9 on the shimmer.)
  const STRIKE = new Float32Array(128).map((_, i) => (i < 15 ? Math.sin(Math.PI / 2 * i / 15) : Math.exp(-(i - 15) / 26)));
  const SOFT_CLIP = (() => {
    const c = new Float32Array(4096);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1) * 2 - 1) * 2; // input range +-2 (after a 0.5 pre-gain)
      const ax = Math.abs(x);
      c[i] = Math.sign(x) * (ax < 0.65 ? ax : 0.65 + 0.24 * Math.tanh((ax - 0.65) / 0.24));
    }
    return c;
  })();

  // A stereo hall: sparse early reflections, then a decorrelated tail that
  // gets darker as it decays.
  function hallImpulse(ctx, seconds, rnd) {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let k = 0; k < 14; k++) {
        const i = Math.floor(sr * (0.008 + rnd() * 0.07));
        d[i] += (rnd() * 2 - 1) * 0.5 * (1 - i / (sr * 0.09));
      }
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 6.9 / seconds) * Math.min(1, t / 0.025);
        lp += (0.55 - 0.42 * Math.min(1, t / seconds)) * ((rnd() * 2 - 1) - lp);
        d[i] += lp * env * 0.6;
      }
    }
    return buf;
  }

  class FlowSound {
    constructor(ctx, opts = {}) {
      this.ctx = ctx;
      this.recipe = { ...RECIPES[opts.recipe || 'bloom'], ...(opts.overrides || {}) };
      this.rnd = mulberry32(opts.seed ?? 1);
      this.keyId = null;
      this.key = KEYS.aurora;
      this.field = null;
      this.degree = 0;
      this.voices = [];
      this.intensity = 0.85;
      this.chordStart = -1e9;
      this.nextChordAt = 0;
      this.energy = 0;
      this.flux = 0;
      this.fluxSlow = 0.01;
      this.stir = 0;
      this.lum = null;
      this.prevLum = null;
      this.gridW = 32;
      this.gridH = 18;
      this.hot = { u: 0.5, v: 0.5 };
      this.singer = null;
      this.grainCarry = 0;
      this.nextPhraseAt = 2.5;
      this.lastParamsAt = -1;
      this.flares = [];
      this.stats = { grains: 0, notes: 0, chords: 0 };
      // Wind, read from the frames: overall amount, speed of the moving mass,
      // how aligned it is, its sideways drift, and per-height bands.
      this.wind = { amount: 0, speed: 0, coherence: 0, drift: 0, bands: new Float32Array(STRINGS), bandX: new Float32Array(STRINGS).fill(0.5) };
      this.gust = 0;
      this.build();
    }

    get keyName() {
      return `${NOTE_NAMES[this.key.root]} ${this.key.mode}`;
    }

    // ------------------------------------------------------------- graph

    build() {
      const ctx = this.ctx;
      const gain = v => new GainNode(ctx, { gain: v });

      // Master: gentle glue, a touch of warmth and air, then a limiter and a
      // soft clipper so nothing ever leaves above about -1 dBFS.
      this.mix = gain(1);
      const glue = new DynamicsCompressorNode(ctx, { threshold: -22, knee: 10, ratio: 2, attack: 0.03, release: 0.4 });
      const warmth = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 160, gain: 1.5 });
      const air = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 8000, gain: 1 });
      this.master = gain(0);
      this.fader = gain(0);
      const limiter = new DynamicsCompressorNode(ctx, { threshold: -4, knee: 0, ratio: 20, attack: 0.002, release: 0.2 });
      const clip = new WaveShaperNode(ctx, { curve: SOFT_CLIP, oversample: '4x' });
      this.mix.connect(glue).connect(warmth).connect(air).connect(this.master).connect(this.fader)
        .connect(limiter).connect(gain(0.5)).connect(clip).connect(ctx.destination);
      this.out = clip;

      // One hall, fed by every layer at its own amount.
      this.verbIn = gain(1);
      this.verbIn.connect(new ConvolverNode(ctx, { buffer: hallImpulse(ctx, 7, this.rnd) })).connect(this.mix);
      const bus = (dry, wet) => {
        const input = gain(1);
        const d = gain(dry);
        const w = gain(wet);
        input.connect(d).connect(this.mix);
        input.connect(w).connect(this.verbIn);
        return { input, dry: d, wet: w };
      };
      this.bus = {
        pad: bus(0.55, 0.7),
        bass: bus(1.0, 0.08),
        shimmer: bus(0.3, 0.9),
        notes: bus(0.75, 0.45),
        wind: bus(0.6, 0.75),
      };
      this.layer = {};
      for (const name of Object.keys(this.bus)) {
        this.layer[name] = gain(0);
        this.layer[name].connect(this.bus[name].input);
      }

      // Pad: two gentle low-passes (24 dB/oct together) that breathe slowly,
      // then a stereo chorus.
      this.padIn = gain(1);
      this.padLP1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1200, Q: 0.5 });
      this.padLP2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1200, Q: 0.5 });
      const breathe = new OscillatorNode(ctx, { frequency: 0.045 });
      const breatheAmt = gain(70);
      breathe.connect(breatheAmt);
      breatheAmt.connect(this.padLP1.frequency);
      breatheAmt.connect(this.padLP2.frequency);
      breathe.start(0);
      const chorusIn = gain(1);
      const chorusOut = gain(0.8);
      this.padIn.connect(this.padLP1).connect(this.padLP2).connect(chorusIn);
      chorusIn.connect(chorusOut);
      for (const side of [-1, 1]) {
        const d = new DelayNode(ctx, { delayTime: 0.014 + side * 0.003, maxDelayTime: 0.05 });
        const lfo = new OscillatorNode(ctx, { frequency: side < 0 ? 0.13 : 0.17 });
        const depth = gain(0.0025);
        lfo.connect(depth).connect(d.delayTime);
        lfo.start(0);
        chorusIn.connect(d).connect(gain(0.5)).connect(new StereoPannerNode(ctx, { pan: side * 0.55 })).connect(chorusOut);
      }
      chorusOut.connect(this.layer.pad);

      // Three slow, unsynced wobbles shared by every pad voice: real ensembles
      // and analog synths never hold a dead-steady pitch.
      this.drift = [0.071, 0.113, 0.167].map(hz => {
        const o = new OscillatorNode(ctx, { frequency: hz });
        o.start(0);
        return o;
      });

      // Air: a faint, wide noise bed (room tone), brighter as the image lights up.
      const noise = ctx.createBuffer(2, ctx.sampleRate * 4, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = noise.getChannelData(ch);
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < d.length; i++) { // pink-ish noise
          const w = this.rnd() * 2 - 1;
          b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w;
          d[i] = (b0 + b1 + b2 + w * 0.05) * 0.35;
        }
      }
      const airSrc = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
      this.airHP = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 2500, Q: 0.4 });
      this.airLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 9000, Q: 0.4 });
      this.airAmp = gain(0);
      airSrc.connect(this.airHP).connect(this.airLP).connect(this.airAmp).connect(this.bus.pad.input);
      airSrc.start(0);

      this.buildWind();

      // Bass goes straight in.
      this.bassIn = gain(1);
      this.bassIn.connect(this.layer.bass);

      // Shimmer grains.
      this.shimmerIn = gain(1);
      this.shimmerIn.connect(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3000, gain: -4 })).connect(this.layer.shimmer);

      // Notes: a little softening, then a ping-pong echo whose repeats get darker.
      this.notesIn = gain(1);
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5200, Q: 0.4 });
      this.notesIn.connect(tone).connect(this.layer.notes);
      this.echoSend = gain(0.28);
      this.echoL = new DelayNode(ctx, { delayTime: 0.6, maxDelayTime: 2 });
      this.echoR = new DelayNode(ctx, { delayTime: 0.6, maxDelayTime: 2 });
      this.echoFb = gain(0.36);
      const echoLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2600 });
      tone.connect(this.echoSend).connect(this.echoL);
      this.echoL.connect(new StereoPannerNode(ctx, { pan: -0.7 })).connect(this.layer.notes);
      this.echoL.connect(this.echoR);
      this.echoR.connect(new StereoPannerNode(ctx, { pan: 0.7 })).connect(this.layer.notes);
      this.echoR.connect(echoLP).connect(this.echoFb).connect(this.echoL);
    }

    // Wind: a set of strings the moving strands blow across. Like a real
    // aeolian harp, each string sings one harmonic at a time (which one
    // depends on the wind's speed), swells and flutters with the gusts, and
    // carries a whisper of breath: a narrow band of noise around its tone.
    buildWind() {
      const ctx = this.ctx;
      const gain = v => new GainNode(ctx, { gain: v });
      this.windIn = gain(1);
      this.windIn.connect(this.layer.wind);
      const len = ctx.sampleRate * 3;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = this.rnd() * 2 - 1;
      const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
      src.start(0);
      const breath = this.recipe.windStyle === 'breath';
      this.windBreath = breath ? 0.9 : 0.3; // how much of each partial is noise
      this.windQ = breath ? 30 : 90;
      this.strings = [];
      for (let i = 0; i < STRINGS; i++) {
        const out = gain(1);
        const pan = new StereoPannerNode(ctx, { pan: (i / (STRINGS - 1) - 0.5) * 0.9 });
        out.connect(pan).connect(this.windIn);
        const f0 = 220 * (1 + i * 0.2);
        const partials = PARTIALS.map((h, k) => {
          // the tone: a sine with its own slow pitch wander, so partials beat
          const osc = new OscillatorNode(ctx, { frequency: f0 * h, detune: (this.rnd() - 0.5) * 6 });
          const wob = gain(3 + this.rnd() * 4);
          this.drift[(i + k) % 3].connect(wob).connect(osc.detune);
          const tone = gain(0);
          osc.connect(tone).connect(out);
          osc.start(0);
          // the breath: noise through a narrow band at the same pitch
          const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: f0 * h, Q: this.windQ });
          const air = gain(0);
          src.connect(bp).connect(air).connect(out);
          return { h, osc, tone, bp, air };
        });
        this.strings.push({ out, pan, partials, f: f0, flutter: 0 });
      }
    }

    // Strings follow the harmony: on every chord they glide to its tones.
    retuneWind(at) {
      const ladder = this.chordLadder(55, 81, 0.6); // G3-A5
      const n = ladder.length;
      this.strings.forEach((st, i) => {
        const midi = ladder[Math.round(i * (n - 1) / (STRINGS - 1))];
        st.f = mtof(midi);
        for (const p of st.partials) {
          const fh = Math.min(st.f * p.h, this.ctx.sampleRate * 0.45);
          p.bp.frequency.setTargetAtTime(fh, at, 0.7);
          p.osc.frequency.setTargetAtTime(fh, at, 0.7);
        }
      });
    }

    windParams(f, t) {
      const s = f.settings;
      const w = this.wind;
      const turb = 1 - w.coherence;
      const half = this.ctx.sampleRate / 2;
      this.strings.forEach((st, i) => {
        // Gusts: each string flutters on its own, deeper in turbulent flow.
        st.flutter += (this.rnd() - 0.5) * 0.6 - st.flutter * 0.2;
        const gust = Math.max(0, 1 + st.flutter * (0.3 + 0.7 * turb) + this.gust * 0.5);
        const e = Math.pow(w.bands[i], 0.9) * gust;
        // The harmonic it sings: higher as the wind speeds up, a little
        // higher on the upper strings, crossfading as it hops.
        const centre = 1 + 2.2 * w.speed + 0.25 * (i % 3) - 0.25;
        st.partials.forEach(p => {
          const weight = Math.exp(-Math.pow(p.h - centre, 2) / 0.3) / Math.sqrt(p.h);
          const level = 0.065 * e * weight;
          p.tone.gain.setTargetAtTime(level, t, 0.45);
          const bw = (st.f * p.h) / this.windQ;
          p.air.gain.setTargetAtTime(level * this.windBreath * 0.7 * Math.sqrt(half / bw), t, 0.45);
        });
        let pan = clamp01(w.bandX[i]) * 1.6 - 0.8;
        if (f.sym > 1) pan *= 0.5; // mirrored wind blows from both sides
        st.pan.pan.setTargetAtTime(pan, t, 0.6);
      });
      this.gust *= 0.9;
      this.layer.wind.gain.setTargetAtTime((this.recipe.wind || 0) * (s.mixWind ?? 0.75) ** 2, t, 0.4);
    }

    // ------------------------------------------------------------- music

    // The first palette fixes the root for the session; later palettes change
    // the mode and colour over that same root, so autopilot doesn't keep
    // jumping key (it changes palette every 12-30 s).
    setKey(id) {
      this.keyId = id;
      const k = KEYS[id] || KEYS.aurora;
      if (this.root === undefined) this.root = k.root;
      this.key = { ...k, root: this.root };
      this.degree = 0;
    }

    // Scale degree -> semitones above the root (degrees past the scale wrap up an octave).
    tone(deg) {
      const st = this.key.steps;
      const n = st.length;
      return st[((deg % n) + n) % n] + 12 * Math.floor(deg / n);
    }

    chordTones(deg = this.degree, spread = 0.3) {
      const ks = [0, 2, 4];
      if (spread > 0.25) ks.push(6);
      if (spread > 0.6) ks.push(8);
      return ks.map(k => this.tone(deg + k));
    }

    // The current chord's notes inside a fixed MIDI range, low to high.
    // (Stacking chord tones up from the root instead overshoots badly in high
    // keys with extended chords: past 20 kHz.)
    chordLadder(lo, hi, spread) {
      const pcs = new Set(this.chordTones(this.degree, spread).map(t => (this.key.root + t) % 12));
      const out = [];
      for (let m = lo; m <= hi; m++) if (pcs.has(m % 12)) out.push(m);
      return out;
    }

    pickDegree() {
      const n = this.key.steps.length;
      const moves = [[3, 3], [4, 2], [5, 3], [1, 1.5], [6, 1], [2, 1]];
      for (let tries = 0; tries < 12; tries++) {
        const total = moves.reduce((s, [, w]) => s + w, 0);
        let r = this.rnd() * total;
        let mv = moves[0][0];
        for (const [m, w] of moves) if ((r -= w) <= 0) { mv = m; break; }
        const deg = this.degree !== 0 && this.rnd() < 0.22 ? 0 : (this.degree + mv) % n;
        const fifth = this.tone(deg + 4) - this.tone(deg);
        if (fifth === 6) continue; // skip diminished chords
        return deg;
      }
      return 0;
    }

    nextChord(at, s) {
      const ctx = this.ctx;
      const A = 6;     // attack: slow enough to be a crossfade, not a swell
      // Release the chord that's playing.
      for (const v of this.voices) {
        // Equal-power crossfade: the old chord fades out on a cosine over the
        // same time the new one fades in, so the total level stays constant
        // (a fast fade-out under a slow fade-in dips and swells like a riser).
        // A fade-out can't overlap the fade-in curve, so it waits for it to end.
        const from = Math.max(at, v.until + 0.01);
        v.env.gain.setValueCurveAtTime(FADE_OUT.map(x => x * v.peak), from, A);
        v.osc.stop(from + A + 0.1);
      }
      this.voices = [];

      this.degree = this.stats.chords === 0 ? 0 : this.pickDegree();
      this.retuneWind(at);
      // Each chord sits at its own intensity, so the piece rises and falls.
      this.intensity = 0.7 + 0.3 * this.rnd();
      this.stats.chords++;
      const tones = this.chordTones(this.degree, s.spread);
      // Keep every key in a similar register (roots above F sharp drop an octave).
      const base = 48 + this.key.root - (this.key.root > 6 ? 12 : 0);
      // Open voicing: root low, fifth, then the third and colour tones above.
      const voicing = [tones[0], tones[2], tones[1] + 12, (tones[3] ?? tones[0] + 12) + 12];
      if (tones[4] !== undefined) voicing.push(tones[4] + 12);
      const level = 0.026 / Math.sqrt(voicing.length / 4);

      // Each note is an ensemble of seven detuned sawtooths: the beating between
      // them is what makes a pad lush rather than a static organ tone.
      const N = 7;
      voicing.forEach((t, vi) => {
        const f = mtof(base + t);
        for (let k = 0; k < N; k++) {
          const spread = (k / (N - 1) - 0.5) * 36; // +-18 cents
          const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: f, detune: spread + (this.rnd() - 0.5) * 5 });
          const wob = new GainNode(ctx, { gain: 4 + this.rnd() * 6 }); // cents of drift
          this.drift[(vi + k) % 3].connect(wob).connect(osc.detune);
          const env = new GainNode(ctx, { gain: 0 });
          const trem = new GainNode(ctx, { gain: 1 });
          const tremAmt = new GainNode(ctx, { gain: 0.12 });
          this.drift[(vi + k + 1) % 3].connect(tremAmt).connect(trem.gain);
          const pan = new StereoPannerNode(ctx, { pan: (k / (N - 1) - 0.5) * 0.8 * (vi % 2 ? -1 : 1) });
          osc.connect(env).connect(trem).connect(pan).connect(this.padIn);
          // Equal-power fade in: sin(pi/2 * x).
          const peak = level * (vi === 0 ? 0.8 : vi >= 3 ? 0.75 : 1) * this.intensity;
          const fade = A + this.rnd() * 1.5;
          env.gain.setValueCurveAtTime(FADE_IN.map(v => v * peak), at, fade);
          osc.start(at + this.rnd() * 0.08);
          this.voices.push({ osc, env, until: at + fade, peak });
        }
      });

      // Bass: the root an octave below the pad.
      const bass = new OscillatorNode(ctx, { frequency: mtof(base - 12 + tones[0]) });
      const bwob = new GainNode(ctx, { gain: 4 });
      this.drift[1].connect(bwob).connect(bass.detune);
      const benv = new GainNode(ctx, { gain: 0 });
      bass.connect(benv).connect(this.bassIn);
      benv.gain.setValueCurveAtTime(FADE_IN.map(v => v * 0.05), at, A);
      bass.start(at);
      this.voices.push({ osc: bass, env: benv, until: at + A, peak: 0.05 });

      this.chordStart = at;
      const dur = 16 - 7 * clamp01(s.evolve);
      this.nextChordAt = at + dur * (0.85 + this.rnd() * 0.3);
    }

    // ------------------------------------------------------------- listening

    // Read the frame: overall energy, how much is changing, where it's bright,
    // and how hard the pointer is stirring.
    listen(f, dt) {
      if (f.lum) {
        const lum = f.lum;
        const n = lum.length;
        this.gridW = f.gridW || this.gridW;
        this.gridH = f.gridH || this.gridH;
        let sum = 0;
        let flux = 0;
        let best = 0;
        let bestI = 0;
        for (let i = 0; i < n; i++) {
          const v = lum[i];
          sum += v;
          if (this.prevLum) flux += Math.max(0, v - this.prevLum[i]);
          if (v > best) { best = v; bestI = i; }
        }
        this.prevLum = Float32Array.from(lum);
        this.lum = this.prevLum;
        const mean = sum / n;
        this.energy = lerp(this.energy, clamp01(mean / 0.8), smooth(dt, 0.8));
        const fl = flux / n;
        this.fluxSlow = lerp(this.fluxSlow, fl, smooth(dt, 12));
        this.flux = lerp(this.flux, clamp01(fl / (4 * this.fluxSlow + 1e-4)), smooth(dt, 0.25));
        this.hot = { u: ((bestI % this.gridW) + 0.5) / this.gridW, v: (Math.floor(bestI / this.gridW) + 0.5) / this.gridH };
      }
      if (f.wind) this.listenWind(f, dt);
      const p = f.pointer || { on: 0, vx: 0, vy: 0, press: 0 };
      const stirNow = clamp01(p.on * (Math.hypot(p.vx, p.vy) / 1.2 + p.press * 0.5));
      this.stir = lerp(this.stir, stirNow, smooth(dt, stirNow > this.stir ? 0.12 : 0.9));
      if (f.singers) {
        // The brightest strands: remember the first live one as a melodic anchor.
        const d = f.singers;
        for (let i = 0; i < d.length / 4; i++) {
          if (d[i * 4 + 2] > 0.6) { this.singer = { u: d[i * 4] / (f.aspect || 1.6), v: d[i * 4 + 1] }; break; }
        }
      }
    }

    // The wind grid: per cell (vx, vy, speed, density), each weighted by how
    // many strands are there, in screen units. Rows run bottom to top.
    listenWind(f, dt) {
      const g = f.wind;
      const W = this.gridW;
      const H = this.gridH;
      const n = W * H;
      const k = f.speedUnits || 0.14; // field units -> screen heights per second
      let moving = 0;
      let mass = 0;
      let nx = 0;
      let ny = 0;
      const bands = new Float32Array(STRINGS);
      const bandX = new Float32Array(STRINGS);
      for (let i = 0; i < n; i++) {
        const sp = g[i * 4 + 2];
        moving += sp;
        mass += g[i * 4 + 3];
        nx += g[i * 4];
        ny += g[i * 4 + 1];
        const b = Math.min(STRINGS - 1, Math.floor(Math.floor(i / W) / H * STRINGS));
        bands[b] += sp;
        bandX[b] += sp * ((i % W) + 0.5) / W;
      }
      const w = this.wind;
      const a = smooth(dt, 0.35);
      // WIND_REF: moving mass that counts as a full breeze (calibrated on
      // recorded traces: a typical scene sits around 0.4-0.7).
      const WIND_REF = 0.05;
      w.amount = lerp(w.amount, clamp01(moving / n * k / WIND_REF), a);
      w.speed = lerp(w.speed, clamp01((moving / Math.max(mass, 1e-4)) * k / 0.3), a);
      w.coherence = lerp(w.coherence, clamp01(Math.hypot(nx, ny) / Math.max(moving, 1e-4)), a);
      w.drift = lerp(w.drift, nx / Math.max(moving, 1e-4), a);
      const perBand = n / STRINGS;
      for (let b = 0; b < STRINGS; b++) {
        w.bands[b] = lerp(w.bands[b], clamp01(bands[b] / perBand * k / WIND_REF), a);
        if (bands[b] > 1e-5) w.bandX[b] = lerp(w.bandX[b], bandX[b] / bands[b], a);
      }
    }

    // A bright cell, chosen with a bias toward brightness.
    pickCell() {
      const lum = this.lum;
      if (!lum) return { u: this.rnd(), v: this.rnd(), k: 0.5 };
      let best = -1;
      let bi = 0;
      for (let j = 0; j < 6; j++) {
        const i = Math.floor(this.rnd() * lum.length);
        if (lum[i] > best) { best = lum[i]; bi = i; }
      }
      return {
        u: ((bi % this.gridW) + 0.5) / this.gridW,
        v: (Math.floor(bi / this.gridW) + 0.5) / this.gridH,
        k: clamp01(best / 1.2),
      };
    }

    // ------------------------------------------------------------- shimmer

    shimmer(f, t, dt) {
      if (!this.recipe.shimmer) return;
      const s = f.settings;
      const rate = (1.2 + 9 * this.energy + 16 * this.flux + 22 * this.stir) * (0.6 + 0.8 * s.glow) * this.recipe.shimmer;
      this.grainCarry += Math.min(40, rate) * dt;
      const ladder = this.chordLadder(69, 88, s.spread); // A4-E6
      while (this.grainCarry >= 1) {
        this.grainCarry -= 1;
        const p = f.pointer;
        const byHand = this.stir > 0.2 && this.rnd() < this.stir;
        const cell = byHand ? { u: p.x / (f.aspect || 1.6), v: p.y, k: 0.8 } : this.pickCell();
        // Height picks the note.
        const n = ladder.length;
        const midi = ladder[Math.max(0, Math.min(n - 1, Math.round(clamp01(cell.v) * (n - 1) + (this.rnd() - 0.5) * 1.5)))];
        let pan = clamp01(cell.u) * 1.6 - 0.8;
        if (f.sym > 1 && this.rnd() < 0.5) pan = -pan; // kaleidoscope: mirrored sparkle
        this.grain(t + this.rnd() * dt, midi, 0.02 + 0.05 * cell.k, pan, 0.45 + this.rnd() * 0.8);
      }
    }

    grain(at, midi, level, pan, dur) {
      const ctx = this.ctx;
      // Glass, not organ: an inharmonic modulator (2.76x, like a struck bar's
      // second mode) whose brightness fades during the grain. Harmonic
      // overtones at 2x/3x/5x are exactly how an organ's drawbars sound.
      const f = mtof(midi);
      const osc = new OscillatorNode(ctx, { frequency: f, detune: (this.rnd() - 0.5) * 8 });
      const mod = new OscillatorNode(ctx, { frequency: Math.min(f * 2.76, ctx.sampleRate * 0.45) });
      const idx = new GainNode(ctx, { gain: 0 });
      idx.gain.setValueAtTime(f * 0.6, at);
      idx.gain.setTargetAtTime(f * 0.05, at, dur * 0.35);
      mod.connect(idx).connect(osc.frequency);
      const env = new GainNode(ctx, { gain: 0 });
      const lvl = new GainNode(ctx, { gain: level });
      osc.connect(env).connect(lvl).connect(new StereoPannerNode(ctx, { pan })).connect(this.shimmerIn);
      env.gain.setValueCurveAtTime(STRIKE, at, dur);
      osc.start(at);
      mod.start(at);
      osc.stop(at + dur + 0.02);
      mod.stop(at + dur + 0.02);
      this.stats.grains++;
    }

    // ------------------------------------------------------------- notes

    // Warm electric piano (two-operator FM with a faint tine), or a soft bell.
    note(at, midi, vel, pan, u, v) {
      const ctx = this.ctx;
      const f = mtof(midi);
      const bell = this.recipe.bell;
      const decay = (bell ? 3.2 : 1.6) + 1.4 * clamp01((84 - midi) / 30);
      const car = new OscillatorNode(ctx, { frequency: f });
      const mod = new OscillatorNode(ctx, { frequency: Math.min(f * (bell ? 3.5 : 1), ctx.sampleRate * 0.45) });
      const modGain = new GainNode(ctx, { gain: 0 });
      const index = f * (bell ? 1.1 : 0.3 + 0.75 * vel);
      modGain.gain.setValueAtTime(index, at);
      modGain.gain.setTargetAtTime(index * 0.08, at, bell ? 0.6 : 0.3);
      mod.connect(modGain).connect(car.frequency);
      const amp = new GainNode(ctx, { gain: 0 });
      amp.gain.setValueAtTime(0, at);
      amp.gain.linearRampToValueAtTime(vel * 0.2, at + (bell ? 0.01 : 0.025));
      amp.gain.setTargetAtTime(0, at + 0.01, decay / 3);
      car.connect(amp).connect(new StereoPannerNode(ctx, { pan })).connect(this.notesIn);
      const end = at + decay * 2.2;
      // A second, slightly detuned carrier on the same modulator: warmth, not a click.
      const twin = new OscillatorNode(ctx, { frequency: f, detune: 6 });
      const twinAmp = new GainNode(ctx, { gain: 0.45 });
      mod.connect(modGain);
      modGain.connect(twin.frequency);
      twin.connect(twinAmp).connect(amp);
      car.start(at);
      mod.start(at);
      twin.start(at);
      car.stop(end);
      mod.stop(end);
      twin.stop(end);
      if (!bell) {
        // The tine: a short, quiet high partial at the attack.
        const tine = new OscillatorNode(ctx, { frequency: Math.min(f * 14, ctx.sampleRate * 0.45) });
        const tg = new GainNode(ctx, { gain: 0 });
        tg.gain.setValueAtTime(vel * 0.004, at);
        tg.gain.setTargetAtTime(0, at, 0.03);
        tine.connect(tg).connect(this.notesIn);
        tine.start(at);
        tine.stop(at + 0.3);
      }
      this.stats.notes++;
      this.flares.push({ t: at, u, v, k: 0.55 * vel + 0.2, r: 0.016 });
      if (this.flares.length > 32) this.flares.shift();
    }

    // A short phrase from chord tones near a height (0..1).
    phrase(at, kind, s) {
      const ladder = this.chordLadder(62, 86, s.spread); // D4-D6
      const anchor = this.singer || this.hot;
      const k = Math.round(clamp01(anchor.v * 0.85 + 0.1) * (ladder.length - 1));
      const beat = 60 / (54 + 30 * s.speed);
      const pan = clamp01(anchor.u) * 1.4 - 0.7;
      const shapes = kind === 'rise' ? [[0, 1, 2, 3, 4]]
        : kind === 'cadence' ? [[2, 1, 0], [0, 1, 2]]
        : [[0], [0, 1], [0, -1], [1, 0], [0, 2, 1], [0]];
      const shape = shapes[Math.floor(this.rnd() * shapes.length)];
      const gap = kind === 'rise' ? beat / 3 : beat * (this.rnd() < 0.5 ? 1 : 1.5);
      const vel = (kind === 'rise' ? 0.35 : 0.32 + 0.3 * this.energy) * (0.9 + this.rnd() * 0.2);
      shape.forEach((step, i) => {
        const idx = Math.max(0, Math.min(ladder.length - 1, k + step));
        this.note(at + i * gap + (this.rnd() - 0.5) * 0.03, ladder[idx], vel * (1 - i * 0.08), pan, anchor.u, anchor.v);
      });
    }

    // ------------------------------------------------------------- per frame

    /*
     * One frame of what the visuals are doing, at audio time t:
     *   lum (luminance grid, display units), gridW/H, singers, aspect,
     *   settings {speed, trails, glow, spread, evolve, vol, mix*}, field,
     *   palette, sym, pointer {x, y, vx, vy, on, press}, dt.
     */
    perform(f, t) {
      const s = f.settings;
      const dt = Math.min(0.25, f.dt || 1 / 60);
      if (f.palette !== this.keyId) {
        const first = this.keyId === null;
        this.setKey(f.palette);
        if (!first) this.nextChordAt = Math.min(this.nextChordAt, Math.max(t + 0.05, this.chordStart + 3.5));
      }
      if (f.field !== this.field) {
        const first = this.field === null;
        this.field = f.field;
        if (!first) {
          this.nextChordAt = Math.max(t + 0.05, this.chordStart + 3.5);
          if (this.recipe.notes) this.phrase(this.nextChordAt + 0.4, 'cadence', s);
        }
      }
      this.listen(f, dt);
      if (t - this.lastParamsAt >= 0.1) {
        this.lastParamsAt = t;
        this.params(f, t);
        this.windParams(f, t);
      }
      if (t >= this.nextChordAt) this.nextChord(Math.max(t, this.nextChordAt), s);
      this.shimmer(f, t, dt);
      if (this.recipe.notes && t >= this.nextPhraseAt) {
        this.phrase(t + 0.05, 'idle', s);
        this.nextPhraseAt = t + (4 + this.rnd() * 6) / (0.65 + 0.7 * this.energy + 0.4 * this.flux);
      }
    }

    scatter(t) {
      if (this.recipe.notes) this.phrase(t + 0.05, 'rise', this.lastSettings || { spread: 0.3, speed: 0.5 });
      this.flux = 1;
      this.gust = 1.5; // the scatter blows through the strings
    }

    // Keys for generated palettes (app.js derives the mood from the colours).
    static defineKey(id, { root, mode, bright }) {
      KEYS[id] = { root, mode, steps: MODE_STEPS[mode] || MODE_STEPS.Ionian, bright };
    }

    params(f, t) {
      const s = f.settings;
      this.lastSettings = s;
      const r = this.recipe;
      const T = 0.4;
      const curve = v => v * v;
      this.master.gain.setTargetAtTime((s.vol ?? 0.7) ** 2 * 1.6, t, T); // ~-22 LUFS at the default volume
      this.layer.pad.gain.setTargetAtTime(r.pad * curve(s.mixPad ?? 0.8) * (0.6 + 0.55 * this.energy + 0.3 * this.stir), t, 1.2);
      // The air bed belongs to the pad: it fades with the Pad slider, so turning
      // the layers down never leaves bare noise behind.
      this.airAmp.gain.setTargetAtTime((0.015 + 0.025 * this.energy) * curve(s.mixPad ?? 0.8), t, 2);
      this.layer.bass.gain.setTargetAtTime(r.bass * curve(s.mixBass ?? 0.7), t, T);
      this.layer.shimmer.gain.setTargetAtTime(r.shimmer * curve(s.mixShimmer ?? 0.8), t, T);
      this.layer.notes.gain.setTargetAtTime(r.notes * curve(s.mixNotes ?? 0.75), t, T);

      const cut = this.key.bright * (1100 + 1300 * s.glow) + 500 * this.energy + 1500 * this.stir;
      this.padLP1.frequency.setTargetAtTime(cut, t, this.stir > 0.1 ? 0.3 : 2.5);
      this.padLP2.frequency.setTargetAtTime(cut * 1.3, t, this.stir > 0.1 ? 0.3 : 2.5);

      const wet = 0.55 + 0.6 * s.trails;
      for (const name of ['pad', 'shimmer', 'notes']) {
        this.bus[name].wet.gain.setTargetAtTime(wet * (name === 'shimmer' ? 1.2 : name === 'notes' ? 0.7 : 1), t, T);
      }
      const beat = 60 / (54 + 30 * s.speed);
      this.echoL.delayTime.setTargetAtTime(beat * 0.75, t, 0.5);
      this.echoR.delayTime.setTargetAtTime(beat * 0.75, t, 0.5);
      this.echoFb.gain.setTargetAtTime(f.sym > 1 ? Math.min(0.55, 0.36 + 0.025 * f.sym) : 0.32, t, 0.6);
      this.echoSend.gain.setTargetAtTime(f.sym > 1 ? 0.42 : 0.26, t, 0.6);
    }

    // ------------------------------------------------------------- offline

    static async renderOffline(trace, opts = {}) {
      const sr = 48000;
      const frames = trace.frames;
      const dur = frames[frames.length - 1].t + 6;
      const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
      const snd = new FlowSound(ctx, opts);
      snd.fader.gain.value = 1;
      for (const f of frames) {
        snd.perform(f, f.t);
        if (f.scatter) snd.scatter(f.t);
      }
      const buffer = await ctx.startRendering();
      return { buffer, stats: snd.stats, key: snd.keyName };
    }

    static toWav(buffer) {
      const L = buffer.getChannelData(0);
      const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
      const n = L.length;
      const out = new ArrayBuffer(44 + n * 4);
      const v = new DataView(out);
      const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
      v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * 4, true);
      v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
      let o = 44;
      for (let i = 0; i < n; i++) {
        v.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
        v.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true);
        o += 4;
      }
      return out;
    }

    // The app's per-frame state -> one frame for perform().
    static frameFromState(s) {
      let lum = null;
      if (s.grid) {
        const g = s.grid;
        const n = s.gridW * s.gridH;
        lum = new Float32Array(n);
        for (let i = 0; i < n; i++) lum[i] = (0.3 * g[i * 4] + 0.6 * g[i * 4 + 1] + 0.1 * g[i * 4 + 2]) * s.gridScale;
      }
      let wind = null;
      if (s.wind) {
        wind = new Float32Array(s.wind.length);
        for (let i = 0; i < wind.length; i++) wind[i] = s.wind[i] * s.gridScale;
      }
      return {
        dt: s.dt,
        lum,
        wind,
        speedUnits: s.speedUnits,
        gridW: s.gridW,
        gridH: s.gridH,
        singers: s.singers ? Array.from(s.singers) : null,
        aspect: s.aspect,
        settings: {
          speed: s.speed, trails: s.trails, glow: s.glow, spread: s.spread, evolve: s.evolve, vol: s.vol,
          mixPad: s.mixPad, mixWind: s.mixWind, mixBass: s.mixBass, mixShimmer: s.mixShimmer, mixNotes: s.mixNotes,
        },
        field: s.field,
        palette: s.palette,
        sym: s.sym,
        pointer: { ...s.pointer },
      };
    }
  }

  // Live wrapper: owns the AudioContext and keeps the app's API.
  class FlowAudio {
    constructor() {
      this.ctx = null;
      this.sound = null;
      this.enabled = false;
      this.running = true;
    }

    get keyName() {
      return this.sound ? this.sound.keyName : '';
    }

    get stats() {
      return this.sound ? this.sound.stats : {};
    }

    get out() {
      return this.sound && this.sound.out;
    }

    // iPhones mute Web Audio when the ring switch is on silent, unlike video
    // and music. Declaring the page a media player lifts that: the Audio
    // Session API where it exists (iOS 17+), otherwise a silent looping
    // <audio> element, which switches the page into playback mode.
    playThroughSilentSwitch() {
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (e) { /* read-only in some builds */ }
        return;
      }
      if (!/iPad|iPhone|iPod/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) return;
      if (!this.keepAlive) {
        const silence = new AudioBuffer({ length: 4000, sampleRate: 8000, numberOfChannels: 1 });
        this.keepAlive = new Audio(URL.createObjectURL(new Blob([FlowSound.toWav(silence)], { type: 'audio/wav' })));
        this.keepAlive.loop = true;
        this.keepAlive.setAttribute('playsinline', '');
      }
      this.keepAlive.play().catch(() => {});
    }

    // Must be called from a user gesture (browsers block audio otherwise).
    async start() {
      this.playThroughSilentSwitch(); // before any await: it needs the gesture
      if (this.ctx) {
        await this.ctx.resume();
        return;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio is not available');
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.sound = new FlowSound(this.ctx, { recipe: 'glass', seed: (Math.random() * 2 ** 31) | 0 });
      this.analyser = new AnalyserNode(this.ctx, { fftSize: 2048 });
      this.sound.out.connect(this.analyser);
      await this.ctx.resume();
    }

    setEnabled(on) {
      this.enabled = on;
      this.applyRunning();
    }

    setRunning(on) {
      this.running = on;
      this.applyRunning();
    }

    applyRunning() {
      if (!this.ctx) return;
      const live = this.enabled && this.running;
      const now = this.ctx.currentTime;
      clearTimeout(this.suspendTimer);
      const g = this.sound.fader.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      if (live) {
        this.ctx.resume();
        this.keepAlive?.play().catch(() => {});
        g.setTargetAtTime(1, now, 0.4);
      } else {
        g.setTargetAtTime(0, now, 0.15);
        this.keepAlive?.pause();
        this.suspendTimer = setTimeout(() => this.ctx.suspend(), 900);
      }
    }

    update(state) {
      if (!this.sound || !this.enabled || !this.running) return;
      this.sound.perform(FlowSound.frameFromState(state), this.ctx.currentTime + 0.05);
    }

    onScatter() {
      if (this.sound && this.enabled && this.running) this.sound.scatter(this.ctx.currentTime + 0.05);
    }

    // Fills `out` (8 x vec4: u, v, intensity, radius) with notes sounding now,
    // and `ages` (seconds since each was struck) for the ripples.
    visualNotes(out, ages) {
      out.fill(0);
      if (ages) ages.fill(0);
      if (!this.sound || !this.enabled || !this.running) return out;
      const now = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
      const live = [];
      for (const f of this.sound.flares) {
        const age = now - f.t;
        if (age >= 0 && age < 1.5) live.push([f, f.k * Math.exp(-age / 0.5)]);
      }
      live.sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < Math.min(8, live.length); i++) {
        out.set([live[i][0].u, live[i][0].v, live[i][1], live[i][0].r], i * 4);
        if (ages) ages[i] = now - live[i][0].t;
      }
      return out;
    }

    meter() {
      if (!this.analyser) return { peak: 0, rms: 0 };
      const buf = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      let sum = 0;
      for (const v of buf) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
      return { peak, rms: Math.sqrt(sum / buf.length) };
    }
  }

  window.FlowSound = FlowSound;
  window.FlowAudio = FlowAudio;
})();
