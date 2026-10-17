# Flow Lines

Up to a million particles drifting through living flow fields, simulated and rendered entirely on the GPU.

Open `index.html` in a modern browser. There's no build step and no dependencies, just WebGL2.

```bash
python3 -m http.server 8000   # optional, then visit http://localhost:8000
```

## What's in it

**Six flow fields.** Switching fields cross-fades smoothly between them.

| # | Field | Idea |
|---|-------|------|
| 1 | **Marble** | Angle taken from domain-warped simplex noise, so it folds into glowing ribbons |
| 2 | **Curl Noise** | The curl of layered 3D simplex noise. It's divergence-free, so particles never clump |
| 3 | **Whirlpools** | Ten drifting vortices with finite reach over a turbulent sea |
| 4 | **Magnetic** | Electric field lines between drifting +/− charges, with a slight spiral twist |
| 5 | **Orbits** | Concentric rings with a travelling radial ripple |
| 6 | **Origin** | The original 2024 formula, `angle = (cos(x·zoom) + sin(y·zoom)) · curve`, now breathing over time |

**Seven palettes** (Aurora, Ultraviolet, Ember, Abyss, Synthwave, Koi, Silver). Hue follows each strand's direction of travel. Palettes blend smoothly into each other.

**Look.** HDR trail accumulation, a dual-Kawase bloom chain, a contrast curve with saturation recovery, subtle chromatic aberration, vignette and dithered film grain. "Hero" strands burn much brighter than the rest, which adds depth.

**Ink on paper.** The same simulation rendered subtractively, like ink bleeding into warm paper.

**Kaleidoscope.** 2/3/4/6/8-fold mirrored symmetry that rotates slowly.

**Interaction.** Click and drag to pull the fluid along, and hold still to spin up a vortex. Hovering does nothing. Touch works too.

**Autopilot.** Wanders through fields and palettes on its own. Leave it running as a screensaver.

**Shareable scenes.** Every setting, including the seed, lives in the URL hash. Hit *Share* to copy a link that reproduces the exact scene.

**Field vectors.** A live arrow overlay of the field, a nod to the old red debug grid.

## Controls

| Key | Action |
|-----|--------|
| `1`–`6` | Switch field |
| `←` `→` / `[` `]` | Previous / next palette |
| `Space` | Pause / resume |
| `R` | Shuffle the seed |
| `K` | Cycle kaleidoscope symmetry |
| `P` | Ink on paper |
| `A` | Autopilot |
| `D` | Field vectors |
| `X` | Scatter all particles |
| `C` | Clear trails |
| `S` | Save a PNG snapshot |
| `L` | Copy a link to this scene |
| `F` | Fullscreen |
| `Tab` | Toggle the control panel |
| `H` | Hide all interface |

Double-click any slider to reset it. The interface fades away when idle and comes back when you move the mouse.

## How it works

```
 particle state (RGBA32F: x, y, age, seed)        trail buffer (RGBA16F, HDR)
 ┌──────────────┐  update.frag  ┌──────────────┐   ×decay   ┌────────────┐
 │  ping  tex   │ ────────────▶ │  pong  tex   │ ─────────▶ │  + lines   │──▶ bloom ──▶ composite
 └──────────────┘   RK2 advect  └──────────────┘            └────────────┘    chain      (tonemap,
                                                                                           grain…)
```

1. **Update.** Every particle is a texel in a float texture. A fragment shader samples the flow field twice (midpoint/RK2 integration) and writes the new position into a second texture, plus that frame's segment color into a third (so the line pass doesn't redo the work). Particles respawn when they age out or leave the screen. From 262K particles up, the field is first baked into a fine grid (~384 cells per screen height) once per frame and sampled bilinearly, which is much cheaper than evaluating it two million times.
2. **Fade.** The trail buffer is multiplied down each frame with a blend trick (`ZERO, SRC_ALPHA`), so trails persist for free.
3. **Lines.** One `GL_LINES` segment per particle, from previous to current position, generated purely from `gl_VertexID` with no vertex buffers, and drawn additively.
4. **Bloom.** Six levels of dual-filter downsampling, then additive upsampling.
5. **Composite.** Exposure, filmic tonemap, contrast, saturation, kaleidoscope fold, vignette and grain.

## Performance

Measured on a base Apple M1 at a 2020×1322 canvas:

| Particles | GPU time per frame |
|---|---|
| 65K (default) | ~3.6 ms |
| 262K | ~7 ms |
| 1M | ~17–18 ms |

At the default count, most of the cost is the screen-sized passes (bloom and compositing), so it scales with resolution rather than particle count. At 1M, it's rasterizing a million tiny lines. It runs at your display's full refresh rate, so on a 120Hz screen expect twice the per-second GPU work. Pausing stops GPU work entirely, and hidden tabs don't render at all.

Brightness is normalised for particle count, resolution, speed and trail length, so the sliders change the character of the image rather than just its brightness. If the frame rate drops on first load, the app quietly steps down the particle count.

## Files

- `index.html`: markup for the canvas and interface
- `style.css`: the inspector-style interface, dark and paper themes, mobile layout
- `js/shaders.js`: every GLSL program, including the six flow fields
- `js/engine.js`: the WebGL2 pipeline (textures, framebuffers, passes)
- `js/app.js`: settings, URL state, UI, input, transitions and the frame loop

In the console, `flowLines` exposes the engine and helpers, e.g. `flowLines.setField('orbit')` or `flowLines.setCount(1048576)`.

## Requirements

WebGL2 with `EXT_color_buffer_float`, which every current desktop and mobile browser supports.

---

*This started in 2024 as a 2D-canvas sketch with 5,000 particles and a single trig formula. That formula still lives on as the **Origin** field.*
