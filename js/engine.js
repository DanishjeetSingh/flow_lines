/*
 * Flow Lines — WebGL2 engine. Owns every GPU resource and runs one frame of
 * the pipeline described in shaders.js. It knows nothing about the UI: the
 * app hands it a plain params object each frame.
 */
(function () {
  'use strict';

  const S = window.FL_SHADERS;

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
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const listing = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
      console.error(log + '\n' + listing);
      throw new FlowError('shader', 'Shader compile failed: ' + log);
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
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

      this.progs = {
        update: createProgram(gl, S.fullscreenVS, S.updateFS),
        field: createProgram(gl, S.fullscreenVS, S.fieldFS),
        fade: createProgram(gl, S.fullscreenVS, S.fadeFS),
        lines: createProgram(gl, S.linesVS, S.linesFS),
        down: createProgram(gl, S.fullscreenVS, S.downFS),
        up: createProgram(gl, S.fullscreenVS, S.upFS),
        composite: createProgram(gl, S.fullscreenVS, S.compositeFS),
        arrows: createProgram(gl, S.arrowsVS, S.arrowsFS),
      };

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
    }

    get count() {
      return this.side * this.side;
    }

    setParticleCount(count, aspect, life) {
      const side = Math.round(Math.sqrt(count));
      if (side === this.side) return;
      const gl = this.gl;
      this.state.forEach(t => destroyTarget(gl, t));
      if (this.color) gl.deleteTexture(this.color);

      const data = new Float32Array(side * side * 4);
      for (let i = 0; i < side * side; i++) {
        data[i * 4] = Math.random() * aspect;
        data[i * 4 + 1] = Math.random();
        data[i * 4 + 2] = Math.random() * life;
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
      this.bloom = [];
      let bw = w >> 1;
      let bh = h >> 1;
      for (let i = 0; i < 6 && bw >= 8 && bh >= 8; i++) {
        this.bloom.push(createTarget(gl, bw, bh, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR));
        bw >>= 1;
        bh >>= 1;
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

        // 2. fade trails: dst = dst * decay
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
        pr = this.progs.fade;
        gl.useProgram(pr.program);
        pr.f('uDecay', p.decay);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // 3. draw this frame's segments additively
        gl.blendFunc(gl.ONE, gl.ONE);
        pr = this.progs.lines;
        gl.useProgram(pr.program);
        pr.tex('uPrev', src.tex, 0);
        pr.tex('uCur', dst.tex, 1);
        pr.tex('uColor', this.color, 2);
        pr.i('uSide', this.side);
        pr.f('uAspect', p.aspect);
        pr.f('uIntensity', p.intensity);
        gl.drawArrays(gl.LINES, 0, this.count * 2);

        this.cur = 1 - this.cur;
      }

      // 4. bloom: downsample chain, then additive upsample back to level 0
      const useBloom = p.bloom > 0.001 && this.bloom.length > 1;
      if (useBloom) {
        gl.disable(gl.BLEND);
        pr = this.progs.down;
        gl.useProgram(pr.program);
        let srcTex = this.accum.tex;
        let sw = this.width;
        let sh = this.height;
        for (const lvl of this.bloom) {
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
      pr.f('uExposure', p.exposure);
      pr.f('uBloomStr', useBloom ? p.bloom : 0);
      pr.f('uPaper', p.paper);
      pr.f('uSym', p.sym);
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
