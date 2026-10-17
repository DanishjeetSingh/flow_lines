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
      this.syncPixel = new Uint8Array(4);
    }

    // Blocks until the GPU has finished everything queued so far. Only used
    // every couple of seconds, to measure real GPU time per frame. It clears and
    // reads a 1x1 offscreen target: reading the on-screen canvas instead
    // would wait for the display (vsync) and always report ~16.7 ms.
    waitForGpu() {
      const gl = this.gl;
      if (!this.probe) this.probe = createTarget(gl, 1, 1, gl.RGBA8, gl.UNSIGNED_BYTE, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.probe.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
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
      this.syncPixel = new Uint8Array(4);
    }

    // Blocks until the GPU has finished everything queued so far. Only used
    // every couple of seconds, to measure real GPU time per frame. It clears and
    // reads a 1x1 offscreen target: reading the on-screen canvas instead
    // would wait for the display (vsync) and always report ~16.7 ms.
    waitForGpu() {
      const gl = this.gl;
      if (!this.probe) this.probe = createTarget(gl, 1, 1, gl.RGBA8, gl.UNSIGNED_BYTE, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.probe.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
    }

    scatter() {
      this.pendingReset = true;
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
        pr.f('uPaper', p.paper);
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
      const useBloom = p.bloom > 0.001 && this.bloom.length > 1;
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

      // 5. composite to the screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.BLEND);
      pr = this.progs.composite;
      gl.useProgram(pr.program);
      pr.tex('uAccum', this.accum.tex, 0);
      pr.tex('uBloom', useBloom ? this.bloom[0].tex : this.accum.tex, 1);
      const top = this.bloom[0];
      pr.v2('uBloomTexel', top ? 1 / top.w : 0, top ? 1 / top.h : 0);
      // Undo the deposit scale and lazy-decay gain on the way out.
      const toDisplay = 1 / (DEPOSIT_SCALE * this.gain);
      pr.f('uExposure', p.exposure * toDisplay);
      pr.f('uBloomStr', useBloom ? p.bloom * toDisplay : 0);
      pr.f('uPaper', p.paper);
      pr.f('uSymA', p.symA);
      pr.f('uSymB', p.symB);
      pr.f('uSymMix', p.symMix);
      pr.f('uSymRot', p.symRot);
      pr.f('uTime', p.clock);
      pr.f('uAspect', p.aspect);
      pr.v3('uBg', p.bg[0], p.bg[1], p.bg[2]);
      pr.v3('uPaperCol', p.paperCol[0], p.paperCol[1], p.paperCol[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 6. optional flow-field vectors, an homage to the old debug grid
      if (p.vectors > 0.01) {
        const cell = 0.045;
        const cols = Math.ceil(p.aspect / cell);
        const rows = Math.ceil(1 / cell);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        pr = this.progs.arrows;
        gl.useProgram(pr.program);
        this.setFlowUniforms(pr, p);
        pr.i('uCols', cols);
        pr.f('uCell', cell);
        pr.v3('uArrowCol', p.arrowCol[0], p.arrowCol[1], p.arrowCol[2]);
        gl.drawArrays(gl.LINES, 0, cols * rows * 6);
        gl.disable(gl.BLEND);
      }
    }
  }

  window.FlowEngine = FlowEngine;
  window.FlowError = FlowError;
})();
