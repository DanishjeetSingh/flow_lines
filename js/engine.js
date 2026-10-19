/*
 * Flow Lines — WebGL2 engine. Owns every GPU resource and runs one frame of
 * the pipeline described in shaders.js. It knows nothing about the UI: the
 * app hands it a plain params object each frame.
 */
(function () {
  'use strict';

  const S = window.FL_SHADERS;

  // Stored trail values = displayed x DEPOSIT_SCALE x gain, with gain in
  // [1, GAIN_LIMIT). Keeps faint strands well clear of half-float's smallest
  // values while staying far below its maximum (~65000). GAIN_LIMIT must be
  // a power of two.
  const DEPOSIT_SCALE = 16;
  const GAIN_LIMIT = 16;

  // Sound. The first SINGERS particles (texels 0..SINGERS-1 of row 0) get
  // seeds that make them the brightest "hero" strands; the sound engine
  // tracks them. The image is also summarised into a GRID_W x GRID_H grid of
  // light, plus a matching grid of wind (where visible strands move, which
  // way and how fast).
  // Both are read back asynchronously (pixel-pack buffer + fence), so the
  // CPU never waits on the GPU.
  const SINGERS = 8;
  const GRID_W = 32;
  const GRID_H = 18;
  const NO_NOTES = new Float32Array(32);
  const READBACK_AGE = 3; // frames between a readback's fence and reading it

  class FlowError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  // Kick off compilation without asking for the result, so that drivers with
  // KHR_parallel_shader_compile can build every program in the background.
  function startProgram(gl, vsSrc, fsSrc) {
    const program = gl.createProgram();
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    return { program, shaders: [[vs, vsSrc], [fs, fsSrc]] };
  }

  function finishProgram(gl, { program, shaders }) {
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      for (const [sh, src] of shaders) {
        if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) continue;
        const log = gl.getShaderInfoLog(sh);
        const listing = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
        console.error(log + '\n' + listing);
        throw new FlowError('shader', 'Shader compile failed: ' + log);
      }
      throw new FlowError('shader', 'Program link failed: ' + gl.getProgramInfoLog(program));
    }

    const loc = {};
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(program, i);
      loc[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
    }

    // Setters silently skip uniforms the compiler optimised away.
    return {
      program,
      f: (name, v) => loc[name] && gl.uniform1f(loc[name], v),
      i: (name, v) => loc[name] && gl.uniform1i(loc[name], v),
      v2: (name, x, y) => loc[name] && gl.uniform2f(loc[name], x, y),
      v3: (name, x, y, z) => loc[name] && gl.uniform3f(loc[name], x, y, z),
      v4: (name, a) => loc[name] && gl.uniform4f(loc[name], a[0], a[1], a[2], a[3]),
      v3v: (name, arr) => loc[name] && gl.uniform3fv(loc[name], arr),
      v4v: (name, arr) => loc[name] && gl.uniform4fv(loc[name], arr),
      f1v: (name, arr) => loc[name] && gl.uniform1fv(loc[name], arr),
      tex: (name, tex, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (loc[name]) gl.uniform1i(loc[name], unit);
      },
    };
  }

  function createTarget(gl, w, h, internalFormat, type, filter, data) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, type, data || null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new FlowError('float', 'Float render target incomplete (0x' + status.toString(16) + ')');
    }
    return { tex, fbo, w, h };
  }

  function destroyTarget(gl, t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  class FlowEngine {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!gl) throw new FlowError('webgl2', 'WebGL2 is not available.');
      if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new FlowError('float', 'Rendering to float textures is not supported.');
      }

      this.canvas = canvas;
      this.gl = gl;

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);

      this.pending = {
        update: startProgram(gl, S.fullscreenVS, S.updateFS),
        field: startProgram(gl, S.fullscreenVS, S.fieldFS),
        fade: startProgram(gl, S.fullscreenVS, S.fadeFS),
        lines: startProgram(gl, S.linesVS, S.linesFS),
        downBox: startProgram(gl, S.fullscreenVS, S.downBoxFS),
        down: startProgram(gl, S.fullscreenVS, S.downFS),
        up: startProgram(gl, S.fullscreenVS, S.upFS),
        composite: startProgram(gl, S.fullscreenVS, S.compositeFS),
        soundGrid: startProgram(gl, S.fullscreenVS, S.soundGridFS),
        arrows: startProgram(gl, S.arrowsVS, S.arrowsFS),
      };
      this.progs = null;

      this.width = 0;
      this.height = 0;
      this.side = 0;
      this.state = [];
      this.color = null;
      this.grid = null;
      this.cur = 0;
      this.frameIndex = 0;
      this.accum = null;
      this.bloom = [];
      this.pendingReset = false;
      // Lazy decay: instead of fading the whole buffer every frame, new
      // segments are drawn ever brighter (x gain) and the composite divides
      // by gain. Rarely, the buffer is rescaled once and gain resets to 1.
      this.gain = 1;
      // Feedback echo: two full-size 8-bit frames, made on first use.
      this.fb = null;
      this.fbCur = 0;
    }


    // Resolves once every program is linked. Waiting a frame at a time keeps
    // the page responsive instead of freezing on one big synchronous compile.
    async ready() {
      const gl = this.gl;
      const ext = gl.getExtension('KHR_parallel_shader_compile');
      if (ext) {
        const done = () => Object.values(this.pending)
          .every(p => gl.getProgramParameter(p.program, ext.COMPLETION_STATUS_KHR));
        while (!done()) await new Promise(r => setTimeout(r, 16));
      }
      this.progs = {};
      for (const [name, p] of Object.entries(this.pending)) this.progs[name] = finishProgram(gl, p);
      this.pending = null;
    }

    get count() {
      return this.side * this.side;
    }

    setParticleCount(count, aspect, life) {
      const side = Math.round(Math.sqrt(count));
      if (side === this.side) return;
      const gl = this.gl;
      const oldState = this.state;
      const oldColor = this.color;
      const oldCur = oldState[this.cur];
      const oldSide = this.side;

      // On a live change, new particles are born (age 0) so they fade in.
      const data = new Float32Array(side * side * 4);
      for (let i = 0; i < side * side; i++) {
        data[i * 4] = Math.random() * aspect;
        data[i * 4 + 1] = Math.random();
        data[i * 4 + 2] = oldCur ? 0 : Math.random() * life;
        data[i * 4 + 3] = Math.random();
      }
      // Singers: seed = (k + f) / 91.71 puts fract(seed * 91.71) = f near 1,
      // the top of the shader's "hero" brightness curve.
      for (let i = 0; i < SINGERS; i++) {
        data[i * 4 + 3] = (Math.floor(Math.random() * 90) + 0.965 + Math.random() * 0.03) / 91.71;
      }
      this.state = [0, 1].map(() => createTarget(gl, side, side, gl.RGBA32F, gl.FLOAT, gl.NEAREST, data));

      // Second render target of the update pass: each particle's segment color.
      this.color = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.color);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, side, side, 0, gl.RGBA, gl.HALF_FLOAT, null);
      for (const t of this.state) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.color, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new FlowError('float', 'Particle render targets incomplete');
        }
      }

      // Carry the existing particles over, so changing the count never resets
      // the picture: they keep their position, age and seed.
      if (oldCur) {
        const k = Math.min(oldSide, side);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, oldCur.fbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.state[0].fbo);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
        gl.blitFramebuffer(0, 0, k, k, 0, 0, k, k, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      }
      oldState.forEach(t => destroyTarget(gl, t));
      if (oldColor) gl.deleteTexture(oldColor);

      this.side = side;
      this.cur = 0;
    }

    resize(w, h) {
      if (w === this.width && h === this.height) return;
      const gl = this.gl;
      this.canvas.width = w;
      this.canvas.height = h;
      this.width = w;
      this.height = h;

      destroyTarget(gl, this.accum);
      this.bloom.forEach(t => destroyTarget(gl, t));
      this.dropFeedback();
      this.accum = createTarget(gl, w, h, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR);
      // The bloom pyramid starts 400-800px tall whatever the screen size, so
      // the glow looks the same everywhere and costs the same at 4K as at 1080p.
      let factor = 2;
      while (h / factor > 800) factor *= 2;
      this.bloomFactor = Math.min(factor, 8);
      this.bloom = [];
      let bw = Math.max(1, Math.round(w / this.bloomFactor));
      let bh = Math.max(1, Math.round(h / this.bloomFactor));
      for (let i = 0; i < 5 && bw >= 8 && bh >= 8; i++) {
        this.bloom.push(createTarget(gl, bw, bh, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR));
        bw = Math.max(1, bw >> 1);
        bh = Math.max(1, bh >> 1);
      }
      this.clear();
    }

    // Field grid used at high particle counts: ~384 cells per screen height.
    ensureGrid(aspect) {
      const h = 384;
      const w = Math.max(8, Math.round(h * aspect));
      if (this.grid && this.grid.w === w && this.grid.h === h) return;
      destroyTarget(this.gl, this.grid);
      this.grid = createTarget(this.gl, w, h, this.gl.RGBA16F, this.gl.HALF_FLOAT, this.gl.LINEAR);
    }

    clear() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.gain = 1;
    }


    scatter() {
      this.pendingReset = true;
    }

    dropFeedback() {
      if (!this.fb) return;
      this.fb.forEach(t => destroyTarget(this.gl, t));
      this.fb = null;
    }

    // The view: mirror, space warp and kaleidoscope fold, with their cross-fade.
    setViewUniforms(pr, p) {
      pr.f('uSymA', p.symA);
      pr.f('uSymB', p.symB);
      pr.f('uSymMix', p.symMix);
      pr.f('uSymRot', p.symRot);
      pr.f('uWarpA', p.warpA);
      pr.f('uWarpB', p.warpB);
      pr.f('uWarpT', p.warpT);
      pr.f('uMirA', p.mirA);
      pr.f('uMirB', p.mirB);
      pr.f('uAspect', p.aspect);
    }

    // ------------------------------------------------------------------ sound

    initSound() {
      const gl = this.gl;
      const pbo = bytes => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        return b;
      };
      // One pass writes both grids: light to attachment 0, wind to 1.
      const grid = createTarget(gl, GRID_W, GRID_H, gl.RGBA16F, gl.HALF_FLOAT, gl.NEAREST);
      const windTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, windTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, GRID_W, GRID_H, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, grid.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, windTex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      this.snd = {
        grid,
        windTex,
        gridPbo: pbo(GRID_W * GRID_H * 16),
        windPbo: pbo(GRID_W * GRID_H * 16),
        singerPbo: pbo(SINGERS * 16),
        gridData: new Float32Array(GRID_W * GRID_H * 4),
        windData: new Float32Array(GRID_W * GRID_H * 4),
        singers: new Float32Array(SINGERS * 4),
        gridSync: null,
        singerSync: null,
        gridScale: 1,
        pendingScale: 1,
        gridFresh: false,
        singersFresh: false,
        frame: 0,
        singerAt: 0,
        gridAt: -1e9,
        singerSeen: -1,
        gridSeen: -1,
      };
    }

    // Collect any finished readbacks without blocking.
    pollSound() {
      const gl = this.gl;
      const snd = this.snd;
      // A readback is collected in three steps, a frame apart at least:
      //   1. its fence is a few frames old (READBACK_AGE),
      //   2. the fence is seen as signalled (clientWaitSync, zero timeout:
      //      never blocks),
      //   3. on a LATER frame, the data is read.
      // Chrome copies the buffer for us in the background once the fence
      // signals; reading on the same frame we first see the signal can beat
      // that copy, which forces a slow synchronous path and a console warning.
      const ready = (sync, issued, seen) => {
        if (!sync || snd.frame - issued < READBACK_AGE) return 'wait';
        if (seen >= 0) return snd.frame > seen ? 'read' : 'wait';
        const r = gl.clientWaitSync(sync, 0, 0);
        return r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED ? 'seen' : 'wait';
      };
      const singer = ready(snd.singerSync, snd.singerAt, snd.singerSeen);
      if (singer === 'seen') snd.singerSeen = snd.frame;
      if (singer === 'read') {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, snd.singerPbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, snd.singers);
        gl.deleteSync(snd.singerSync);
        snd.singerSync = null;
        snd.singerSeen = -1;
        snd.singersFresh = true;
      }
      const grid = ready(snd.gridSync, snd.gridAt, snd.gridSeen);
      if (grid === 'seen') snd.gridSeen = snd.frame;
      if (grid === 'read') {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, snd.gridPbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, snd.gridData);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, snd.windPbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, snd.windData);
        gl.deleteSync(snd.gridSync);
        snd.gridSync = null;
        snd.gridSeen = -1;
        snd.gridScale = snd.pendingScale;
        snd.gridFresh = true;
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    captureSound(p) {
      const gl = this.gl;
      if (!this.snd) this.initSound();
      const snd = this.snd;
      snd.frame++;
      this.pollSound();

      // Singer positions from the newest particle state (~20 per second).
      if (!snd.singerSync) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.state[this.cur].fbo);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, snd.singerPbo);
        gl.readPixels(0, 0, SINGERS, 1, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        snd.singerSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        snd.singerAt = snd.frame;
      }

      // The image as seen, summarised into small light and wind grids
      // (~10 per second).
      if (!snd.gridSync && snd.frame - snd.gridAt >= 2 * READBACK_AGE) {
        const src = this.bloom.find(l => l.h <= GRID_H * 4) || this.bloom[this.bloom.length - 1];
        const pr = this.progs.soundGrid;
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, snd.grid.fbo);
        gl.viewport(0, 0, GRID_W, GRID_H);
        gl.useProgram(pr.program);
        this.setFlowUniforms(pr, p);
        this.setViewUniforms(pr, p);
        pr.f('uUseGrid', 0);
        pr.tex('uSrc', src.tex, 0);
        pr.v2('uGridRes', GRID_W, GRID_H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, snd.gridPbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.readPixels(0, 0, GRID_W, GRID_H, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, snd.windPbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.readPixels(0, 0, GRID_W, GRID_H, gl.RGBA, gl.FLOAT, 0);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        snd.gridSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        snd.gridAt = snd.frame;
        // Grid values are in stored trail units; this brings them to display units.
        snd.pendingScale = p.exposure / (DEPOSIT_SCALE * this.gain);
      }
    }

    // Hand over whatever arrived since the last call.
    takeSound() {
      const snd = this.snd;
      if (!snd) return null;
      this.pollSound();
      const out = {
        singers: snd.singersFresh ? snd.singers : null,
        grid: snd.gridFresh ? snd.gridData : null,
        wind: snd.gridFresh ? snd.windData : null,
        gridScale: snd.gridScale,
        gridW: GRID_W,
        gridH: GRID_H,
      };
      snd.singersFresh = false;
      snd.gridFresh = false;
      return out;
    }

    setFlowUniforms(pr, p) {
      pr.f('uTime', p.time);
      pr.f('uAspect', p.aspect);
      pr.f('uScale', p.scale);
      pr.f('uSpeed', p.speed);
      pr.i('uFieldA', p.fieldA);
      pr.i('uFieldB', p.fieldB);
      pr.f('uFieldMix', p.fieldMix);
      pr.v4('uSeedA', p.seedA);
      pr.v4('uSeedB', p.seedB);
      pr.v2('uMouse', p.mouse[0], p.mouse[1]);
      pr.v2('uMouseVel', p.mouseVel[0], p.mouseVel[1]);
      pr.f('uMouseOn', p.mouseOn);
      pr.f('uMouseDown', p.mouseDown);
    }

    render(p) {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      let pr;

      if (p.step) {
        const src = this.state[this.cur];
        const dst = this.state[1 - this.cur];

        gl.disable(gl.BLEND);

        // 0. bake the field into the grid (high particle counts only)
        if (p.useGrid) {
          this.ensureGrid(p.aspect);
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.grid.fbo);
          gl.viewport(0, 0, this.grid.w, this.grid.h);
          pr = this.progs.field;
          gl.useProgram(pr.program);
          this.setFlowUniforms(pr, p);
          pr.v2('uGridSize', this.grid.w, this.grid.h);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        // 1. advect particles, and write each segment's color alongside
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, this.side, this.side);
        pr = this.progs.update;
        gl.useProgram(pr.program);
        this.setFlowUniforms(pr, p);
        pr.f('uDt', p.dt);
        pr.f('uLife', p.life);
        pr.i('uFrame', this.frameIndex++);
        pr.f('uReset', this.pendingReset ? 1 : 0);
        pr.f('uHueShift', p.hueShift);
        pr.f('uSpread', p.spread);
        pr.v3v('uPal', p.palette);
        pr.f('uUseGrid', p.useGrid ? 1 : 0);
        pr.tex('uState', src.tex, 0);
        pr.tex('uFieldTex', p.useGrid ? this.grid.tex : null, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.pendingReset = false;

        // 2. lazy decay: older content dims by `decay` relative to new
        //    segments. Fading the whole 4K buffer every frame was the single
        //    most expensive thing the old pipeline did. Now, only once the
        //    gain reaches GAIN_LIMIT is the buffer scaled by exactly
        //    1/GAIN_LIMIT, a power of two, so the float math is exact and the
        //    picture doesn't change at all.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.enable(gl.BLEND);
        this.gain /= p.decay;
        if (this.gain >= GAIN_LIMIT) {
          gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
          pr = this.progs.fade;
          gl.useProgram(pr.program);
          pr.f('uDecay', 1 / GAIN_LIMIT);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          this.gain /= GAIN_LIMIT;
        }

        // 3. draw this frame's segments additively, as anti-aliased quads
        gl.blendFunc(gl.ONE, gl.ONE);
        pr = this.progs.lines;
        gl.useProgram(pr.program);
        pr.tex('uPrev', src.tex, 0);
        pr.tex('uCur', dst.tex, 1);
        pr.tex('uColor', this.color, 2);
        pr.i('uSide', this.side);
        pr.f('uAspect', p.aspect);
        pr.f('uIntensity', p.intensity * DEPOSIT_SCALE * this.gain);
        pr.f('uWidth', p.lineWidth);
        pr.v2('uRes', this.width, this.height);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);

        this.cur = 1 - this.cur;
      }

      // 4. bloom: downsample chain, then additive upsample back to level 0
      // Sound reads the bloom pyramid, so it's built even with Glow at zero.
      const useBloom = (p.bloom > 0.001 || p.sound) && this.bloom.length > 1;
      if (useBloom) {
        gl.disable(gl.BLEND);

        // One box-filtered pass from full resolution straight to the top level.
        const top = this.bloom[0];
        pr = this.progs.downBox;
        gl.useProgram(pr.program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, top.fbo);
        gl.viewport(0, 0, top.w, top.h);
        pr.tex('uSrc', this.accum.tex, 0);
        pr.v2('uTexel', 1 / this.width, 1 / this.height);
        pr.i('uTaps', this.bloomFactor >> 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        pr = this.progs.down;
        gl.useProgram(pr.program);
        let srcTex = top.tex;
        let sw = top.w;
        let sh = top.h;
        for (const lvl of this.bloom.slice(1)) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, lvl.fbo);
          gl.viewport(0, 0, lvl.w, lvl.h);
          pr.tex('uSrc', srcTex, 0);
          pr.v2('uTexel', 1 / sw, 1 / sh);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          srcTex = lvl.tex;
          sw = lvl.w;
          sh = lvl.h;
        }
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        pr = this.progs.up;
        gl.useProgram(pr.program);
        for (let i = this.bloom.length - 1; i > 0; i--) {
          const s = this.bloom[i];
          const d = this.bloom[i - 1];
          gl.bindFramebuffer(gl.FRAMEBUFFER, d.fbo);
          gl.viewport(0, 0, d.w, d.h);
          pr.tex('uSrc', s.tex, 0);
          pr.v2('uTexel', 0.5 / s.w, 0.5 / s.h);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      }

      if (p.sound) this.captureSound(p);

      // 5. composite. With feedback on, it renders into one of two offscreen
      //    frames (reading the other as last frame), then that is copied to
      //    the screen.
      const feedback = p.feedback > 0;
      if (feedback && !this.fb) {
        this.fb = [0, 1].map(() => createTarget(gl, this.width, this.height, gl.RGBA8, gl.UNSIGNED_BYTE, gl.LINEAR));
        for (const t of this.fb) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
          gl.clearColor(p.bg[0], p.bg[1], p.bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }
      const fbDst = feedback ? this.fb[1 - this.fbCur] : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbDst ? fbDst.fbo : null);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.BLEND);
      pr = this.progs.composite;
      gl.useProgram(pr.program);
      pr.tex('uAccum', this.accum.tex, 0);
      pr.tex('uBloom', useBloom ? this.bloom[0].tex : this.accum.tex, 1);
      pr.tex('uPrev', feedback ? this.fb[this.fbCur].tex : this.accum.tex, 2);
      const top = this.bloom[0];
      pr.v2('uBloomTexel', top ? 1 / top.w : 0, top ? 1 / top.h : 0);
      // Undo the deposit scale and lazy-decay gain on the way out.
      const toDisplay = 1 / (DEPOSIT_SCALE * this.gain);
      pr.f('uExposure', p.exposure * toDisplay);
      pr.f('uBloomStr', useBloom ? p.bloom * toDisplay : 0);
      this.setViewUniforms(pr, p);
      pr.f('uTime', p.clock);
      pr.v3('uBg', p.bg[0], p.bg[1], p.bg[2]);

      const notesOn = p.sound && p.notes;
      pr.v4v('uNotes', notesOn ? p.notes : NO_NOTES);
      if (notesOn && p.noteAges) pr.f1v('uNoteAge', p.noteAges);
      if (p.noteTint) pr.v3('uNoteTint', p.noteTint[0], p.noteTint[1], p.noteTint[2]);
      pr.f('uRipple', notesOn ? p.ripple : 0);
      pr.f('uFeedback', p.feedback);
      pr.f('uFbZoom', p.fbZoom);
      pr.f('uFbRot', p.fbRot);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (fbDst) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbDst.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.fbCur = 1 - this.fbCur;
      } else if (this.fb && p.feedbackIdle) {
        this.dropFeedback(); // off for a while: give the memory back
      }

      // 6. optional flow-field vectors, an homage to the old debug grid
      if (p.vectors > 0.01) {
        // A finer grid when the view folds or warps the picture, so the
        // mirrored structure reads in the arrows too.
        const plain = p.symA < 2 && p.symB < 2 && p.warpA < 1 && p.warpB < 1 && p.mirA < 1 && p.mirB < 1;
        const cell = plain ? 0.045 : 0.03;
        const cols = Math.ceil(p.aspect / cell);
        const rows = Math.ceil(1 / cell);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        pr = this.progs.arrows;
        gl.useProgram(pr.program);
        this.setFlowUniforms(pr, p);
        this.setViewUniforms(pr, p);
        pr.f('uUseGrid', 0);
        pr.i('uCols', cols);
        pr.f('uCell', cell);
        pr.f('uAlpha', Math.min(1, p.vectors));
        pr.v3('uArrowCol', p.arrowCol[0], p.arrowCol[1], p.arrowCol[2]);
        gl.drawArrays(gl.LINES, 0, cols * rows * 6);
        gl.disable(gl.BLEND);
      }
    }
  }

  window.FlowEngine = FlowEngine;
  window.FlowError = FlowError;
})();
