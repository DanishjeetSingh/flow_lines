/*
 * Flow Lines — GLSL sources.
 *
 * Pipeline per frame:
 *   field     (high particle counts only) bake the field into a fine grid.
 *   update    particles live in a float texture (x, y, age, seed); a fragment
 *             shader advects every particle through the flow field (RK2) and
 *             writes the segment color to a second target.
 *   fade      decay is lazy: new segments are drawn brighter and the composite
 *             divides; this pass rarely rescales the buffer.
 *   lines     one GL line per particle, previous -> current position, added
 *             into the trail buffer.
 *   bloom     one box-filtered pass down to a ~540p pyramid, then a
 *             dual-filter (Kawase) down/up chain.
 *   composite tonemap, bloom, the view (space warp + kaleidoscope fold),
 *             feedback echo, ripples from notes, vignette, dither.
 */
(function () {
  'use strict';

  const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

  const FULLSCREEN_VS = HEADER + `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // Ashima / Stefan Gustavson 3D simplex noise.
  const NOISE = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

  const COMMON = `
const float TAU = 6.28318530718;
float lifeOf(float seed, float base) { return base * (0.35 + 1.3 * fract(seed * 3.731)); }
float paceOf(float seed) { return 0.55 + 0.9 * fract(seed * 7.137); }
`;

  // The flow field. Positions are in "world" units: y in [0, 1], x in [0, aspect].
  const FLOW = `
uniform float uTime;
uniform float uAspect;
uniform float uScale;
uniform float uSpeed;
uniform int uFieldA;
uniform int uFieldB;
uniform float uFieldMix;
uniform vec4 uSeedA;
uniform vec4 uSeedB;
uniform vec2 uMouse;
uniform vec2 uMouseVel;
uniform float uMouseOn;
uniform float uMouseDown;

vec2 perp(vec2 v) { return vec2(-v.y, v.x); }

// Soft speed limit: linear for small vectors, saturating at (1 + k).
vec2 soften(vec2 v, float k) {
  float l = length(v);
  return v * (1.0 + k) / (k + l + 1e-6);
}

float potential(vec3 p) {
  return snoise(p) + 0.45 * snoise(p * 2.07 + vec3(13.7, 7.3, 3.1));
}

vec2 curlNoise(vec2 q, float t) {
  const float e = 0.012;
  float a = potential(vec3(q.x, q.y + e, t));
  float b = potential(vec3(q.x, q.y - e, t));
  float c = potential(vec3(q.x + e, q.y, t));
  float d = potential(vec3(q.x - e, q.y, t));
  return vec2(a - b, d - c) / (2.0 * e);
}

// 0 — divergence-free curl of layered simplex noise. Silky, never clumps.
vec2 fieldCurl(vec2 q, float t, vec4 s) {
  return soften(curlNoise(q * 1.1 + s.xy, t * 0.12) * 0.32, 0.6);
}

// 1 — angle from domain-warped noise. Marbled, folded, organic.
vec2 fieldWarp(vec2 q, float t, vec4 s) {
  vec2 g = q * 0.85 + s.xy;
  vec2 w = vec2(snoise(vec3(g, t * 0.08)), snoise(vec3(g + 5.2, t * 0.08 + 1.3)));
  float n = snoise(vec3(g + w * 1.7, t * 0.05));
  float ang = n * TAU * 0.95 + t * 0.03;
  return vec2(cos(ang), sin(ang)) * (0.6 + 0.8 * abs(n));
}

// 2 — whirlpools: drifting vortices with finite reach over a turbulent sea.
vec2 fieldVortex(vec2 q, float t, vec4 s) {
  vec2 v = curlNoise(q * 0.9 + s.xy, t * 0.08) * 0.11;
  float R = 0.34 * uScale;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.07 + fi * 0.013) + fi * 2.399 + s.z),
                  cos(t * (0.06 + fi * 0.017) + fi * 3.883 + s.w))
             * vec2(uAspect * 0.47, 0.47) * uScale;
    vec2 d = q - c;
    float r2 = dot(d, d);
    float spin = mod(fi, 2.0) < 1.0 ? 1.0 : -1.0;
    float strength = 0.6 + 0.4 * sin(fi * 3.1 + s.z);
    v += spin * strength * perp(d) / (r2 + 0.003 * uScale * uScale) * exp(-r2 / (R * R)) * 0.1 * uScale;
  }
  return soften(v, 0.6);
}

// 3 — electric field lines between drifting +/- charges.
vec2 fieldCharge(vec2 q, float t, vec4 s) {
  vec2 e = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.06 + fi * 0.013) + fi * 1.9 + s.z),
                  sin(t * (0.05 + fi * 0.011) + fi * 2.7 + s.w + 1.0))
             * vec2(uAspect * 0.4, 0.4) * uScale;
    vec2 d = q - c;
    float charge = mod(fi, 2.0) < 1.0 ? 1.0 : -1.0;
    e += charge * d / (dot(d, d) + 0.0015 * uScale * uScale);
  }
  float l = length(e);
  vec2 dir = e / (l + 1e-5);
  // A slight rotation turns rigid field lines into gentle spirals.
  float tw = 0.18 * sin(t * 0.07 + s.z);
  dir = vec2(dir.x * cos(tw) - dir.y * sin(tw), dir.x * sin(tw) + dir.y * cos(tw));
  return dir * (0.65 + 0.35 * smoothstep(0.0, 6.0, l));
}

// 4 — concentric orbits with a travelling radial ripple.
vec2 fieldOrbit(vec2 q, float t, vec4 s) {
  vec2 g = q + 0.18 * uScale * vec2(sin(t * 0.1 + s.z), cos(t * 0.13 + s.w));
  float r = length(g);
  float a = atan(g.y, g.x);
  float ang = a + 1.5708
            + 0.9 * sin(r * 7.5 - t * 0.5 + s.z)
            + 0.4 * snoise(vec3(g * 1.4 + s.xy, t * 0.05));
  return vec2(cos(ang), sin(ang));
}

// 5 — the original 2024 formula: angle = (cos(x * zoom) + sin(y * zoom)) * curve,
//     now breathing over time.
vec2 fieldOrigin(vec2 q, float t, vec4 s) {
  float zoom = 5.2 * (1.0 + 0.2 * sin(t * 0.05 + s.z));
  float curve = -1.25 + 0.8 * sin(t * 0.09 + s.w);
  vec2 g = q * zoom + s.xy * 0.05;
  float ang = (cos(g.x) + sin(g.y)) * curve * 1.6;
  return vec2(cos(ang), sin(ang));
}

// 6 — a steady stream past drifting round obstacles (potential flow around
//     cylinders, with a little circulation so they shed curls). Inside each
//     obstacle the strands spin like a trapped eddy.
vec2 fieldStream(vec2 q, float t, vec4 s) {
  float th = s.z + 0.35 * sin(t * 0.05 + s.w);
  vec2 dir = vec2(cos(th), sin(th));
  vec2 nrm = perp(dir);
  vec2 v = dir;
  vec2 inside = vec2(0.0);
  float hole = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.05 + fi * 0.011) + fi * 2.1 + s.w), cos(t * (0.04 + fi * 0.013) + fi * 1.3 + s.z))
             * vec2(uAspect * 0.42, 0.42) * uScale;
    float R = (0.06 + 0.06 * fract(fi * 0.618 + s.w * 0.37)) * uScale;
    vec2 z = q - c;
    vec2 zl = vec2(dot(z, dir), dot(z, nrm));      // in the stream's frame
    float r2 = max(dot(zl, zl), R * R);
    vec2 pert = -R * R * vec2(zl.x * zl.x - zl.y * zl.y, 2.0 * zl.x * zl.y) / (r2 * r2);
    float gam = 0.9 * R * sin(t * 0.3 + fi * 1.7 + s.z);
    pert += gam * perp(zl) / r2;
    v += pert.x * dir + pert.y * nrm;
    float k = 1.0 - smoothstep(R * 0.85, R * 1.05, length(z));
    inside += k * perp(z) / R * (mod(fi, 2.0) < 1.0 ? 1.4 : -1.4);
    hole = max(hole, k);
  }
  v = mix(v, inside, hole);
  v += curlNoise(q * 1.6 + s.xy, t * 0.1) * 0.06;
  return soften(v, 0.8);
}

// 7 — silk: long ribbons rippling across the screen. Calm, layered waves
//     whose height and timing differ from sheet to sheet.
vec2 fieldSilk(vec2 q, float t, vec4 s) {
  float th0 = 0.5 * sin(s.z) + 0.15 * sin(t * 0.03);
  vec2 p = vec2(cos(th0) * q.x + sin(th0) * q.y, -sin(th0) * q.x + cos(th0) * q.y);
  float k = 11.0;
  float y = p.y * k + s.w + 0.6 * sin(t * 0.07);
  float phase = p.x * 2.4 - t * 0.8 + 1.6 * sin(p.y * 1.3 + t * 0.11 + s.z);
  float ang = 0.55 * sin(phase) * (0.6 + 0.4 * sin(y * 0.5)) + 0.12 * snoise(vec3(p * 0.9 + s.xy, t * 0.04));
  // Strands drift toward the ribbon centres (y = multiples of 2pi), so they
  // bunch into bright bands with dark gaps between them.
  float pull = -0.45 * sin(y);
  vec2 v = vec2(cos(ang), sin(ang)) + vec2(0.0, pull);
  return vec2(cos(th0) * v.x - sin(th0) * v.y, sin(th0) * v.x + cos(th0) * v.y) * 0.9;
}

// 8 — waves from three drifting sources interfere; strands run along the
//     crests, drawing moiré fringes that slide as the sources move.
vec2 fieldWaves(vec2 q, float t, vec4 s) {
  vec2 grad = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.04 + fi * 0.01) + fi * 2.4 + s.z), cos(t * (0.035 + fi * 0.012) + fi * 1.7 + s.w))
             * vec2(uAspect * 0.4, 0.4) * uScale;
    vec2 d = q - c;
    float r = length(d) + 1e-3;
    float ph = 11.0 * r - t * 2.2 + fi * 2.0;
    grad += cos(ph) * (d / r) / sqrt(r + 0.12);
  }
  vec2 v = perp(grad) + grad * 0.2;
  return soften(v * 1.4, 0.6);
}

vec2 cellHash(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

// 9 — a foam of cells (Voronoi): each cell turns on its own, and strands
//     slide along the membranes where neighbours meet.
vec2 fieldCells(vec2 q, float t, vec4 s) {
  vec2 g = q * 2.3 + s.xy * 0.05;
  vec2 ip = floor(g);
  float d1 = 1e9;
  float d2 = 1e9;
  vec2 c1 = vec2(0.0);
  vec2 c2 = vec2(0.0);
  float spin = 1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = ip + vec2(float(i), float(j));
      vec2 h = cellHash(cell + floor(s.zw * 7.0));
      vec2 c = cell + 0.5 + 0.38 * sin(t * 0.25 + h * 6.2831);
      float d = length(g - c);
      if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = c; spin = h.x < 0.5 ? 1.0 : -1.0; }
      else if (d < d2) { d2 = d; c2 = c; }
    }
  }
  vec2 r1 = g - c1;
  vec2 swirl = perp(r1) / (length(r1) + 0.08) * spin;
  vec2 along = perp(normalize(c2 - c1 + 1e-6));
  along *= sign(dot(along, swirl) + 1e-6);
  float onEdge = exp(-(d2 - d1) * 7.0);
  return mix(swirl, along * 1.3, onEdge * 0.75);
}

// 10 — two spiral galaxies, turning opposite ways. A rotating density wave
//      bends the flow in and out along logarithmic spiral arms.
vec2 fieldGalaxy(vec2 q, float t, vec4 s) {
  vec2 v = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * 0.03 + fi * 3.1 + s.z) * 0.42 * uAspect, cos(t * 0.025 + fi * 2.3 + s.w) * 0.28)
             * uScale * (fi < 0.5 ? 0.45 : 1.0);
    vec2 d = q - c;
    float r = length(d) + 1e-3;
    float th = atan(d.y, d.x);
    float spin = fi < 0.5 ? 1.0 : -1.0;
    float arms = 2.0 + fi;
    float wave = sin(arms * (th * spin - log(r) * 2.6) - t * 0.5 + s.z);
    // The arms alternately squeeze strands in and let them out, so they
    // bunch up along the spiral instead of draining into the core.
    float a = 0.08 + 0.5 * wave;
    vec2 dir = perp(d / r) * spin * cos(a) - (d / r) * sin(a);
    float weight = 1.0 / (1.0 + r * r / (0.12 * uScale * uScale));
    v += dir * weight;
  }
  return soften(v * 1.2, 0.6);
}

// 11 — smoke: a smooth rising column that breaks into curls as it climbs.
vec2 fieldSmoke(vec2 q, float t, vec4 s) {
  float sway = 0.25 * sin(t * 0.09 + s.z);
  vec2 up = vec2(sin(sway), cos(sway));
  vec2 side = perp(up);
  float height = dot(q, up) / max(uScale, 0.3);
  float across = dot(q, side) - 0.25 * uScale * sin(s.z * 3.0 + t * 0.04);
  float turb = 0.12 + 1.1 * smoothstep(-0.35, 0.5, height);
  // Low down, everything is drawn into the column; higher up it billows out.
  float draw = (1.0 - smoothstep(-0.4, 0.3, height)) * 1.4;
  vec2 c = curlNoise(q * 1.5 + s.xy - up * t * 0.08, t * 0.15) * 0.3;
  return soften(up * 0.85 - side * across * draw + c * turb, 0.7);
}

vec2 fieldById(int id, vec2 q, float t, vec4 s) {
  if (id == 0) return fieldCurl(q, t, s);
  if (id == 1) return fieldWarp(q, t, s);
  if (id == 2) return fieldVortex(q, t, s);
  if (id == 3) return fieldCharge(q, t, s);
  if (id == 4) return fieldOrbit(q, t, s);
  if (id == 5) return fieldOrigin(q, t, s);
  if (id == 6) return fieldStream(q, t, s);
  if (id == 7) return fieldSilk(q, t, s);
  if (id == 8) return fieldWaves(q, t, s);
  if (id == 9) return fieldCells(q, t, s);
  if (id == 10) return fieldGalaxy(q, t, s);
  return fieldSmoke(q, t, s);
}

// The field itself, including any cross-fade between two fields.
vec2 baseFlow(vec2 p) {
  vec2 q = (p - vec2(uAspect * 0.5, 0.5)) * uScale;
  vec2 v = fieldById(uFieldA, q, uTime, uSeedA);
  if (uFieldMix > 0.0) {
    v = mix(v, fieldById(uFieldB, q, uTime, uSeedB), uFieldMix);
  }
  return v;
}

// With many particles the field is pre-baked once per frame into a fine
// grid (uFieldTex) and sampled bilinearly, instead of being evaluated twice
// per particle. The pointer force is always evaluated exactly.
uniform sampler2D uFieldTex;
uniform float uUseGrid;

vec2 flow(vec2 p) {
  vec2 v;
  if (uUseGrid > 0.5) {
    v = texture(uFieldTex, p / vec2(uAspect, 1.0)).xy;
  } else {
    v = baseFlow(p);
  }

  // Pointer: moving drags the fluid along, pressing adds a vortex.
  if (uMouseOn > 0.001) {
    vec2 d = p - uMouse;
    float r = 0.11 + 0.07 * uMouseDown;
    float f = exp(-dot(d, d) / (r * r));
    float dl = length(d) + 1e-4;
    vec2 m = uMouseVel / max(uSpeed, 0.01) * 0.55;
    m += perp(d) / dl * 2.6 * uMouseDown;
    v += m * f * uMouseOn;
  }

  float l = length(v);
  return l > 14.0 ? v * (14.0 / l) : v;
}
`;

  const PALETTE = `
uniform vec3 uPal[5];
vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  int i = min(int(floor(t)), 3);
  float f = t - float(i);
  f = f * f * (3.0 - 2.0 * f);
  return mix(uPal[i], uPal[i + 1], f);
}
`;

  const HASH = `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 rand3(uvec3 v) { return vec3(pcg3d(v)) * (1.0 / 4294967296.0); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

  const UPDATE_FS = HEADER + NOISE + COMMON + FLOW + PALETTE + HASH + `
uniform sampler2D uState;
uniform float uDt;
uniform float uLife;
uniform int uFrame;
uniform float uReset;
uniform float uHueShift;
uniform float uSpread;
layout(location = 0) out vec4 outState;
// rgb: this frame's segment color (before global intensity), a: 0 = don't draw
layout(location = 1) out vec4 outColor;

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, ij, 0);
  vec2 p0 = s.xy;
  vec2 p = p0;
  float age = s.z;
  float seed = s.w;

  // Midpoint (RK2) integration keeps curves smooth at high speed.
  float h = uSpeed * uDt * paceOf(seed);
  vec2 v1 = flow(p);
  vec2 v2 = flow(p + v1 * h * 0.5);
  p += v2 * h;
  age += uDt;

  float life = lifeOf(seed, uLife);
  const float margin = 0.03;
  bool outside = p.x < -margin || p.x > uAspect + margin || p.y < -margin || p.y > 1.0 + margin;
  bool reborn = age > life || outside || uReset > 0.5;
  if (reborn) {
    vec3 r = rand3(uvec3(uvec2(ij), uint(uFrame)));
    p = r.xy * vec2(uAspect, 1.0);
    age = uReset > 0.5 ? r.z * life : 0.0;
  }
  outState = vec4(p, age, seed);

  // Segment color, computed once here rather than per line vertex.
  vec2 dv = p - p0;
  bool broken = reborn || dot(dv, dv) > 0.0064;
  float fade = smoothstep(0.0, min(0.9, life * 0.3), age) * (1.0 - smoothstep(life * 0.7, life, age));

  // Hue follows the direction of travel, blended with a per-particle tint.
  // A triangle wave keeps the palette seamless as the angle wraps around.
  float ang = atan(dv.y, dv.x + 1e-9);
  float hue = ang / TAU + uHueShift + (fract(seed * 13.17) - 0.5) * uSpread;
  vec3 c = palette(abs(fract(hue) * 2.0 - 1.0));

  // A few "hero" strands burn much brighter than the rest, giving depth.
  float hero = 0.07 + 3.6 * pow(fract(seed * 91.71), 10.0);

  outColor = vec4(c * fade * hero, broken ? 0.0 : 1.0);
}`;

  const FIELD_FS = HEADER + NOISE + COMMON + FLOW + `
uniform vec2 uGridSize;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy / uGridSize * vec2(uAspect, 1.0);
  o = vec4(baseFlow(p), 0.0, 1.0);
}`;

  const FADE_FS = HEADER + `
uniform float uDecay;
out vec4 o;
void main() { o = vec4(0.0, 0.0, 0.0, uDecay); }`;

  // Each segment is a small quad with box-filtered (anti-aliased) edges. The
  // ends ramp over one pixel so consecutive segments sum seamlessly, with no
  // bright beads at the joints. Color is divided by the width so a strand
  // carries the same energy at any width.
  const LINES_VS = HEADER + `
uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uColor;
uniform int uSide;
uniform float uAspect;
uniform float uIntensity;
uniform float uWidth;
uniform vec2 uRes;
out vec3 vColor;
out vec2 vLocal;
out float vLen;

// One instance per particle, drawn as a 4-vertex triangle strip.
const vec2 CORNERS[4] = vec2[4](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0), vec2(1.0, 1.0));

void main() {
  int id = gl_InstanceID;
  ivec2 ij = ivec2(id % uSide, id / uSide);
  vec4 c = texelFetch(uColor, ij, 0);
  vColor = vec3(0.0);
  vLocal = vec2(0.0);
  vLen = 0.0;
  if (c.a < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 toPx = uRes / vec2(uAspect, 1.0);
  vec2 a = texelFetch(uPrev, ij, 0).xy * toPx;
  vec2 b = texelFetch(uCur, ij, 0).xy * toPx;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);

  // The coverage falloff reaches zero half a pixel past the segment, so the
  // quad needs no more margin than that.
  vec2 corner = CORNERS[gl_VertexID];
  float along = corner.x < 0.5 ? -0.5 : len + 0.5;
  float across = corner.y * (uWidth * 0.5 + 0.5);
  vec2 px = a + dir * along + n * across;

  vLocal = vec2(along, across);
  vLen = len;
  vColor = c.rgb * uIntensity / uWidth;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

  const LINES_FS = HEADER + `
uniform float uWidth;
in vec3 vColor;
in vec2 vLocal;
in float vLen;
out vec4 o;
void main() {
  float t = vLocal.x;
  float ca = clamp(t + 0.5, 0.0, 1.0) - clamp(t - vLen + 0.5, 0.0, 1.0);
  float cs = clamp(uWidth * 0.5 + 0.5 - abs(vLocal.y), 0.0, 1.0);
  o = vec4(vColor * (ca * cs), 1.0);
}`;

  // Box-filters a factor x factor block (factor = 2 * uTaps) with uTaps^2
  // bilinear taps, each of which already averages a 2x2 block.
  const DOWN_BOX_FS = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform int uTaps;
in vec2 vUv;
out vec4 o;
void main() {
  float n = float(uTaps);
  vec3 s = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    if (j >= uTaps) break;
    for (int i = 0; i < 4; i++) {
      if (i >= uTaps) break;
      vec2 off = vec2(float(2 * i), float(2 * j)) - (n - 1.0);
      s += texture(uSrc, vUv + off * uTexel).rgb;
    }
  }
  o = vec4(s / (n * n), 1.0);
}`;

  const DOWN_FS = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv - h).rgb;
  s += texture(uSrc, vUv + h).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb;
  s += texture(uSrc, vUv - vec2(h.x, -h.y)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

  const UP_FS = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0, 1.0);
}`;

  // The view: how a point on screen maps to a point of the simulation. A
  // mirror (book, quad, prism) folds the screen first, then a space warp
  // (tunnel, tiles, swirl), then the kaleidoscope folds the result, so tiles
  // become tiles of kaleidoscopes and a mirrored tunnel stays a tunnel. Shared by the composite,
  // the sound scan and the field arrows, so what you see, hear and read agree.
  // Expects uAspect and TAU to be declared already.
  const VIEW = `
uniform float uSymA;
uniform float uSymB;
uniform float uSymMix;   // cross-fade from view A to view B
uniform float uSymRot;
uniform float uWarpA;    // 0 none, 1 tunnel, 2 tiles, 3 swirl
uniform float uWarpB;
uniform float uWarpT;    // warp clock (seconds, scaled by speed)
uniform float uMirA;     // 0 none, 1 book, 2 quad, 3 prism
uniform float uMirB;

vec2 foldEdges(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }

vec2 kaleido(vec2 uv, float sym) {
  if (sym < 1.5) return uv;
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  float seg = TAU / sym;
  float a = mod(atan(p.y, p.x) + uSymRot, seg);
  a = abs(a - seg * 0.5) + 1.5708 - seg * 0.5;
  p = r * vec2(cos(a), sin(a));
  return foldEdges(p / vec2(uAspect, 1.0) + 0.5);
}

vec2 warp(vec2 uv, float w) {
  if (w < 0.5) return uv;
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  if (w < 1.5) {
    // Tunnel: angle around the screen and 1/distance from its centre become
    // the two image axes, so the picture lines a tube you fly down.
    // The far end is capped (and faded out by viewShade): past that, the
    // picture would only shimmer and thrash the texture cache.
    float r = max(length(p), 0.03);
    float a = atan(p.y, p.x);
    return foldEdges(vec2(a / TAU * 2.0 + uWarpT * 0.004, 0.2 / r + uWarpT * 0.05));
  }
  if (w < 2.5) {
    // Tiles: mirrored repeats, turning very slowly.
    float c = cos(uWarpT * 0.015);
    float s = sin(uWarpT * 0.015);
    p = mat2(c, s, -s, c) * p * 2.6;
    return foldEdges(p / vec2(uAspect, 1.0) + 0.5);
  }
  // Swirl: the middle twists around the centre, winding and unwinding slowly.
  float r2 = dot(p, p);
  float ang = 2.4 * sin(uWarpT * 0.12) * exp(-r2 / 0.22);
  float c = cos(ang);
  float s = sin(ang);
  p = mat2(c, s, -s, c) * p;
  return p / vec2(uAspect, 1.0) + 0.5;
}

// Mirrors fold the screen itself. Prism is a three-mirror kaleidoscope (the
// toy): repeated reflections into one equilateral triangle, which tiles the
// screen with mirrored copies.
vec2 mirror(vec2 uv, float m) {
  if (m < 0.5) return uv;
  if (m < 1.5) return vec2(0.5 - abs(uv.x - 0.5), uv.y);
  if (m < 2.5) return 0.5 - abs(uv - 0.5);
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float c = cos(uWarpT * 0.01);
  float s = sin(uWarpT * 0.01);
  p = mat2(c, s, -s, c) * p;
  const float h = 0.16; // the triangle's inradius
  const vec2 n0 = vec2(0.0, 1.0);
  const vec2 n1 = vec2(-0.8660254, -0.5);
  const vec2 n2 = vec2(0.8660254, -0.5);
  for (int i = 0; i < 14; i++) {
    float d0 = dot(p, n0) - h;
    if (d0 > 0.0) p -= 2.0 * d0 * n0;
    float d1 = dot(p, n1) - h;
    if (d1 > 0.0) p -= 2.0 * d1 * n1;
    float d2 = dot(p, n2) - h;
    if (d2 > 0.0) p -= 2.0 * d2 * n2;
  }
  return p / vec2(uAspect, 1.0) + 0.5;
}

vec2 viewOf(vec2 uv, float sym, float w, float m) { return kaleido(warp(mirror(uv, m), w), sym); }

// The view that dominates right now (for things that can't cross-fade).
vec2 viewNow(vec2 uv) {
  return uSymMix > 0.5 ? viewOf(uv, uSymB, uWarpB, uMirB) : viewOf(uv, uSymA, uWarpA, uMirA);
}

// Light of a view: the tunnel's far end fades into darkness (measured after
// the mirror, so every mirrored copy of it fades too).
float viewShade(vec2 uv, float w, float m) {
  if (w < 0.5 || w > 1.5) return 1.0;
  float r = length((mirror(uv, m) - 0.5) * vec2(uAspect, 1.0));
  return smoothstep(0.03, 0.2, r);
}

// A direction in the simulation, as it appears on screen at uv: through the
// inverse of the view's local stretch (mirrors flip it, the lens shrinks it).
vec2 toScreenDir(vec2 uv, vec2 src, vec2 v) {
  const float e = 0.0015;
  vec2 sx = (viewNow(uv + vec2(e, 0.0)) - src) / e;
  vec2 sy = (viewNow(uv + vec2(0.0, e)) - src) / e;
  vec2 A = vec2(uAspect, 1.0);
  mat2 J = mat2(sx * A / uAspect, sy * A); // d(src world) / d(screen world)
  float det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
  if (abs(det) < 1e-4) return v;            // on a fold seam
  return inverse(J) * v;
}
`;

  const VIEW_ALONE = `
uniform float uAspect;
const float TAU = 6.28318530718;
`;

  const COMPOSITE_FS = HEADER + HASH + VIEW_ALONE + VIEW + `
uniform sampler2D uAccum;
uniform sampler2D uBloom;
uniform vec2 uBloomTexel;
uniform float uExposure;
uniform float uBloomStr;
uniform float uTime;
uniform vec3 uBg;
// Sound: up to 8 recent notes as (u, v, intensity, radius). A positive radius
// means the note sits on a strand (source space, so kaleidoscope copies flare
// too); a negative one means a fixed spot on screen.
uniform vec4 uNotes[8];
uniform float uNoteAge[8];
uniform vec3 uNoteTint;
uniform float uRipple;     // 0..1: notes send rings through the image
// Feedback: the previous frame, zoomed and turned, echoes behind this one.
uniform sampler2D uPrev;
uniform float uFeedback;   // per-frame persistence (0 = off)
uniform float uFbZoom;
uniform float uFbRot;
in vec2 vUv;
out vec4 o;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 sampleHdr(vec2 uv) {
  vec3 acc = texture(uAccum, uv).rgb;
  // 4-tap tent filter: a smooth upscale of the low-resolution bloom.
  vec2 bh = uBloomTexel * 0.5;
  vec3 bloom = 0.25 * (texture(uBloom, uv + vec2(-bh.x, -bh.y)).rgb + texture(uBloom, uv + vec2(bh.x, -bh.y)).rgb
                     + texture(uBloom, uv + vec2(-bh.x, bh.y)).rgb + texture(uBloom, uv + vec2(bh.x, bh.y)).rgb);
  return acc * uExposure + bloom * uBloomStr;
}

// Rings spreading out from notes on strands (source space).
vec2 rippleAt(vec2 src) {
  vec2 off = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 nt = uNotes[i];
    if (nt.z <= 0.0 || nt.w <= 0.0) continue;
    float age = uNoteAge[i];
    vec2 d = (src - nt.xy) * vec2(uAspect, 1.0);
    float dist = length(d);
    float R = 0.03 + age * 0.3;
    float ring = exp(-pow((dist - R) / 0.03, 2.0));
    off += d / (dist + 1e-4) * ring * cos((dist - R) * 90.0) * 0.007 * exp(-age * 1.8);
  }
  return off / vec2(uAspect, 1.0) * uRipple;
}

void main() {
  // While the view changes, both are rendered and cross-faded.
  vec2 uvA = viewOf(vUv, uSymA, uWarpA, uMirA);
  if (uRipple > 0.0) uvA += rippleAt(uvA);
  vec3 hdr = sampleHdr(uvA);
  float shade = viewShade(vUv, uWarpA, uMirA);
  vec2 uvB = uvA;
  if (uSymMix > 0.0) {
    uvB = viewOf(vUv, uSymB, uWarpB, uMirB);
    if (uRipple > 0.0) uvB += rippleAt(uvB);
    hdr = mix(hdr, sampleHdr(uvB), uSymMix);
    shade = mix(shade, viewShade(vUv, uWarpB, uMirB), uSymMix);
  }

  // Sound: a brief flare wherever a note is struck.
  vec2 src = uSymMix > 0.5 ? uvB : uvA;
  for (int i = 0; i < 8; i++) {
    vec4 nt = uNotes[i];
    if (nt.z <= 0.0) continue;
    vec2 d = ((nt.w > 0.0 ? src : vUv) - nt.xy) * vec2(uAspect, 1.0);
    hdr += uNoteTint * nt.z * exp(-dot(d, d) / (nt.w * nt.w));
  }

  hdr *= shade;

  // Contrast curve carves dark channels between strands; then win back the
  // saturation that additive blending of many hues washes out.
  hdr = pow(hdr, vec3(1.3)) * 1.15;
  float luma = dot(hdr, LUMA);
  hdr = max(mix(vec3(luma), hdr, 1.35), 0.0);

  vec3 col = uBg + (1.0 - uBg) * (1.0 - exp(-hdr));

  vec2 vq = (vUv - 0.5) * vec2(1.0, 1.0 / max(uAspect, 0.6)) * 1.6;
  float vig = 1.0 - smoothstep(0.35, 1.25, length(vq));
  col *= mix(0.62, 1.0, vig);

  // Feedback: last frame, slightly zoomed and turned, persists behind this
  // one (the brighter of the two wins, so it never blows out).
  if (uFeedback > 0.0) {
    vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
    float c = cos(uFbRot);
    float s = sin(uFbRot);
    q = mat2(c, s, -s, c) * q * uFbZoom;
    vec2 fuv = q / vec2(uAspect, 1.0) + 0.5;
    float inside = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
    vec3 prev = texture(uPrev, fuv).rgb;
    float k = uFeedback * inside;
    col = max(col, prev * k);
  }

  // Triangular dither: just enough to hide banding, not visible as grain.
  vec2 seed = gl_FragCoord.xy + fract(uTime * 7.31) * 517.0;
  float n = hash12(seed) + hash12(seed + 71.3) - 1.0;
  col += n / 255.0;
  o = vec4(col, 1.0);
}`;

  // Sound scan: the image as you see it (through the view), averaged into a
  // small grid and read back asynchronously. Two outputs: the light (where
  // chimes ring) and the wind (moving mass: which way and how fast the
  // visible strands travel, weighted by how many there are).
  const SOUND_GRID_FS = HEADER + NOISE + COMMON + FLOW + VIEW + `
uniform sampler2D uSrc;
uniform vec2 uGridRes;
in vec2 vUv;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oWind;
void main() {
  vec2 q = 0.25 / uGridRes;
  vec3 light = vec3(0.0);
  vec4 wind = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    vec2 uv = vUv + vec2(k % 2 == 0 ? -q.x : q.x, k < 2 ? -q.y : q.y);
    vec2 src = viewNow(uv);
    vec3 c = texture(uSrc, src).rgb;
    light += c;
    float d = dot(c, vec3(0.3, 0.6, 0.1));
    vec2 v = toScreenDir(uv, src, flow(src * vec2(uAspect, 1.0)));
    wind += vec4(v * d, length(v) * d, d);
  }
  o = vec4(light * 0.25, 1.0);
  oWind = wind * 0.25;
}`;

  // Field arrows on a screen grid, read through the view: with the
  // kaleidoscope or a warp on, they mirror and bend exactly like the image.
  const ARROWS_VS = HEADER + NOISE + COMMON + FLOW + VIEW + `
uniform int uCols;
uniform float uCell;
out float vShade;
void main() {
  int id = gl_VertexID / 6;
  int k = gl_VertexID - id * 6;
  vec2 base = (vec2(float(id % uCols), float(id / uCols)) + 0.5) * uCell; // screen, world units
  vec2 uv = base / vec2(uAspect, 1.0);
  vec2 src = viewNow(uv);
  vec2 v = toScreenDir(uv, src, flow(src * vec2(uAspect, 1.0)));
  float m = length(v);
  vec2 dir = v / (m + 1e-6);
  vec2 side = perp(dir);
  float L = uCell * 0.38 * clamp(m, 0.45, 1.25);
  vec2 tip = base + dir * L;
  vec2 p;
  if (k == 0) p = base - dir * L;
  else if (k == 1 || k == 2 || k == 4) p = tip;
  else if (k == 3) p = tip - dir * L * 0.55 + side * L * 0.38;
  else p = tip - dir * L * 0.55 - side * L * 0.38;
  vShade = clamp(m, 0.3, 1.0) * (uSymMix > 0.5 ? viewShade(uv, uWarpB, uMirB) : viewShade(uv, uWarpA, uMirA));
  gl_Position = vec4(p.x / uAspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}`;

  const ARROWS_FS = HEADER + `
uniform vec3 uArrowCol;
uniform float uAlpha;
in float vShade;
out vec4 o;
void main() { o = vec4(uArrowCol, (0.32 + 0.4 * vShade) * uAlpha); }`;

  window.FL_SHADERS = {
    fullscreenVS: FULLSCREEN_VS,
    updateFS: UPDATE_FS,
    fieldFS: FIELD_FS,
    fadeFS: FADE_FS,
    linesVS: LINES_VS,
    linesFS: LINES_FS,
    downBoxFS: DOWN_BOX_FS,
    downFS: DOWN_FS,
    upFS: UP_FS,
    compositeFS: COMPOSITE_FS,
    soundGridFS: SOUND_GRID_FS,
    arrowsVS: ARROWS_VS,
    arrowsFS: ARROWS_FS,
  };
})();
