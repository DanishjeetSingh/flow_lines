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
 ┌──────────────┐  update.frag  ┌──────────────┐  lazy decay ┌────────────┐
 │  ping  tex   │ ────────────▶ │  pong  tex   │ ─────────▶ │  + lines   │──▶ bloom ──▶ composite
 └──────────────┘   RK2 advect  └──────────────┘            └────────────┘    chain      (tonemap,
                                                                                           grain…)
```

1. **Update.** Every particle is a texel in a float texture. A fragment shader samples the flow field twice (midpoint/RK2 integration) and writes the new position into a second texture, plus that frame's segment color into a third (so the line pass doesn't redo the work). Particles respawn when they age out or leave the screen. From 262K particles up, the field is first baked into a fine grid (~384 cells per screen height) once per frame and sampled bilinearly, which is much cheaper than evaluating it two million times.
2. **Lazy decay.** Fading the whole trail buffer every frame was the most expensive thing on a 4K screen. Instead, each frame's new segments are drawn slightly brighter than the last, and the composite divides by that growing gain. Every few seconds the buffer is scaled by exactly 1/16 (a power of two, so the float math is exact and nothing visibly changes).
3. **Lines.** Each particle's segment (previous → current position) is an instanced quad with box-filtered, anti-aliased edges, built purely from `gl_VertexID`/`gl_InstanceID` with no vertex buffers. The ends ramp over one pixel so consecutive segments join seamlessly, and color is divided by width so brightness doesn't depend on line width.
4. **Bloom.** One box-filtered pass straight from full resolution to a pyramid about 540px tall, then dual-filter down/up passes. The pyramid size doesn't depend on screen resolution, so the glow looks and costs the same at 1080p and 4K.
5. **Composite.** Exposure, filmic tonemap, contrast, saturation, kaleidoscope fold, vignette and grain.

## Performance

Measured on a base Apple M1 at a 4K canvas (3840×2160):

| Particles | GPU time per frame |
|---|---|
| 16K | ~6 ms |
| 65K (default) | ~8 ms |
| 262K | ~14 ms |
| 1M | ~40 ms |

The readout in the corner shows this live: **GPU** is the measured GPU time per frame and the frame rate that would allow. Your display caps the frames you actually see (60 on a 60Hz screen), so rendering more would only waste power. Up to 262K fits comfortably in 60 fps at 4K. 1M is limited by the number of primitives, not pixels: two million tiny triangles per frame is a lot for any tile-based GPU, so it's for stronger GPUs. The canvas never renders more pixels than a 4K panel has (scaled display modes would otherwise render 5120×2880). It runs at your display's full refresh rate. Pausing stops GPU work entirely, and hidden tabs don't render at all.

Shaders compile in the background (`KHR_parallel_shader_compile`), the GPU pipelines are warmed with a few frames before anything is shown, and the canvas then fades in, so startup doesn't stutter.

Brightness is normalised for particle count, resolution, speed and trail length, so the sliders change the character of the image rather than just its brightness. If the frame rate stays low on first load, the app steps down the particle count; existing particles carry over, so the picture never resets.

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
