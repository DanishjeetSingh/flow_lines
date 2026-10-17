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
 *   composite tonemap, bloom, kaleidoscope fold, vignette, grain.
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

vec2 fieldById(int id, vec2 q, float t, vec4 s) {
  if (id == 0) return fieldCurl(q, t, s);
  if (id == 1) return fieldWarp(q, t, s);
  if (id == 2) return fieldVortex(q, t, s);
  if (id == 3) return fieldCharge(q, t, s);
  if (id == 4) return fieldOrbit(q, t, s);
  return fieldOrigin(q, t, s);
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
uniform float uPaper;
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
  c = mix(c, vec3(1.0) - c * 0.92, uPaper);

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

  const COMPOSITE_FS = HEADER + HASH + `
uniform sampler2D uAccum;
uniform sampler2D uBloom;
uniform vec2 uBloomTexel;
uniform float uExposure;
uniform float uBloomStr;
uniform float uPaper;
uniform float uSymA;
uniform float uSymB;
uniform float uSymMix;
uniform float uSymRot;
uniform float uTime;
uniform float uAspect;
uniform vec3 uBg;
uniform vec3 uPaperCol;
in vec2 vUv;
out vec4 o;

const float TAU = 6.28318530718;

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

vec3 sampleHdr(vec2 uv) {
  vec3 acc = texture(uAccum, uv).rgb;
  // 4-tap tent filter: a smooth upscale of the low-resolution bloom.
  vec2 bh = uBloomTexel * 0.5;
  vec3 bloom = 0.25 * (texture(uBloom, uv + vec2(-bh.x, -bh.y)).rgb + texture(uBloom, uv + vec2(bh.x, -bh.y)).rgb
                     + texture(uBloom, uv + vec2(-bh.x, bh.y)).rgb + texture(uBloom, uv + vec2(bh.x, bh.y)).rgb);
  return acc * uExposure + bloom * uBloomStr;
}

void main() {
  // While the kaleidoscope changes, both folds are rendered and cross-faded.
  vec3 hdr = sampleHdr(kaleido(vUv, uSymA));
  if (uSymMix > 0.0) hdr = mix(hdr, sampleHdr(kaleido(vUv, uSymB)), uSymMix);
  // Contrast curve carves dark channels between strands; then win back the
  // saturation that additive blending of many hues washes out.
  hdr = pow(hdr, vec3(1.3)) * 1.15;
  float luma = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
  hdr = max(mix(vec3(luma), hdr, 1.35), 0.0);

  vec3 dark = uBg + (1.0 - uBg) * (1.0 - exp(-hdr));
  vec3 paper = uPaperCol * exp(-hdr * 1.1);
  vec3 col = mix(dark, paper, uPaper);

  vec2 vq = (vUv - 0.5) * vec2(1.0, 1.0 / max(uAspect, 0.6)) * 1.6;
  float vig = 1.0 - smoothstep(0.35, 1.25, length(vq));
  col *= mix(1.0 - mix(0.38, 0.14, uPaper), 1.0, vig);

  // Triangular dither: just enough to hide banding, not visible as grain.
  vec2 seed = gl_FragCoord.xy + fract(uTime * 7.31) * 517.0;
  float n = hash12(seed) + hash12(seed + 71.3) - 1.0;
  col += n * mix(1.0, 1.5, uPaper) / 255.0;
  o = vec4(col, 1.0);
}`;

  const ARROWS_VS = HEADER + NOISE + COMMON + FLOW + `
uniform int uCols;
uniform float uCell;
out float vShade;
void main() {
  int id = gl_VertexID / 6;
  int k = gl_VertexID - id * 6;
  vec2 base = (vec2(float(id % uCols), float(id / uCols)) + 0.5) * uCell;
  vec2 v = flow(base);
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
  vShade = clamp(m, 0.3, 1.0);
  gl_Position = vec4(p.x / uAspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}`;

  const ARROWS_FS = HEADER + `
uniform vec3 uArrowCol;
in float vShade;
out vec4 o;
void main() { o = vec4(uArrowCol, 0.32 + 0.4 * vShade); }`;

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
    arrowsVS: ARROWS_VS,
    arrowsFS: ARROWS_FS,
  };
})();
