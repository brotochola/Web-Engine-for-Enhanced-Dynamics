#version 300 es
// blastGround.frag – the ground layer (blastGround.js), per world pixel.
//
// The ground is Blastforge's paintGround with its own hash and noise: grass with dirt patches, dirt, stone tiles or
// a dark void (uGround). Over it, the ground half of Blastforge's composite:
//   - shockwave rings shift whole pixels around them (uWave0-5),
//   - the haze over a hot fireball wobbles rows sideways (uHeat0-3),
//   - the scorch picture darkens the ground in three dithered steps,
//   - blast and fire lights brighten it, posterized in four dithered steps, in the palette's light color
//     (uLight0-7, uLightCol).
precision highp float;
precision highp int;

in vec2 vWorld;
out vec4 finalColor;

uniform sampler2D scorch;   // one texel per uScorchCell world px
uniform float uScorchCell;
uniform float uGround;      // 0 grass, 1 dirt, 2 stone tiles, 3 dark void
uniform float uBlastTime;   // game seconds
uniform vec3 uLightCol;
uniform vec4 uLight0; uniform vec4 uLight1; uniform vec4 uLight2; uniform vec4 uLight3;
uniform vec4 uLight4; uniform vec4 uLight5; uniform vec4 uLight6; uniform vec4 uLight7; // x, y, radius, intensity
uniform vec4 uWave0; uniform vec4 uWave1; uniform vec4 uWave2; uniform vec4 uWave3;
uniform vec4 uWave4; uniform vec4 uWave5;                                                 // x, y, ring radius, strength
uniform vec4 uHeat0; uniform vec4 uHeat1; uniform vec4 uHeat2; uniform vec4 uHeat3;       // x, y, radius, strength

const float BAYER[16] = float[16](
  -0.47, 0.03, -0.345, 0.155, 0.28, -0.22, 0.405, -0.095,
  -0.2825, 0.2175, -0.4075, 0.0925, 0.4675, -0.0325, 0.3425, -0.1575
);
const int GRASS[5] = int[5](0x2f5229, 0x3b6531, 0x47763a, 0x548843, 0x64994d);
const int GRASS_DIRT[3] = int[3](0x4e3b2b, 0x614a35, 0x755a40);
const int DIRT[5] = int[5](0x4a3727, 0x5a4330, 0x6b5039, 0x7c5e43, 0x8e6d4e);
const int STONE[5] = int[5](0x3b3940, 0x4c4a52, 0x5b5962, 0x6a6871, 0x7a7881);

vec3 rgb(int c) { return vec3(float((c >> 16) & 255), float((c >> 8) & 255), float(c & 255)) / 255.0; }

// Blastforge's hash2: the same 32-bit integer mixing (Math.imul wraps as uint multiplication does).
float hash2(int x, int y, int s) {
  uint h = (uint(x) * 374761393u) ^ (uint(y) * 668265263u) ^ (uint(s) * 1442695041u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return float(h) / 4294967296.0;
}

float vnoise(vec2 p, int s) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  int x = int(i.x);
  int y = int(i.y);
  float a = hash2(x, y, s);
  float b = hash2(x + 1, y, s);
  float c = hash2(x, y + 1, s);
  float d = hash2(x + 1, y + 1, s);
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}

float fbm(vec2 p, int s) {
  return vnoise(p, s) * 0.55 + vnoise(p * 2.1, s + 7) * 0.3 + vnoise(p * 4.3, s + 13) * 0.15;
}

vec3 groundAt(ivec2 p) {
  int x = p.x;
  int y = p.y;
  float b = BAYER[(y & 3) * 4 + (x & 3)];
  vec2 w = vec2(p);
  int type = int(uGround + 0.5);
  if (type == 0) {
    float m = fbm(w * 0.013, 5);
    float n = fbm(w * 0.045, 1);
    if (m + b * 0.06 < 0.34) return rgb(GRASS_DIRT[clamp(int(floor((n + b * 0.2) * 3.4 - 0.4)), 0, 2)]);
    int k = clamp(int(floor((n - 0.22 + b * 0.16) * 8.5)), 0, 4);
    if (hash2(x, y, 9) > 0.975) k = min(4, k + 1);
    return rgb(GRASS[k]);
  }
  if (type == 1) {
    float n = fbm(w * 0.05, 3);
    int k = clamp(int(floor((n - 0.2 + b * 0.18) * 8.0)), 0, 4);
    if (hash2(x, y, 4) > 0.993) k = 4;
    else if (hash2(x, y - 1, 4) > 0.993) k = 0;
    return rgb(DIRT[k]);
  }
  if (type == 2) {
    int lx = x & 31;
    int ly = y & 31;
    float tone = hash2(x >> 5, y >> 5, 2);
    float n = vnoise(w * 0.2, 6);
    int k = 1 + int(floor(tone * 2.99));
    if (n + b * 0.2 > 0.78) k = min(4, k + 1);
    else if (n + b * 0.2 < 0.2) k = max(0, k - 1);
    if (lx == 0 || ly == 0) k = 0;
    else if (lx == 1 || ly == 1) k = min(4, k + 1);
    else if (lx == 31 || ly == 31) k = max(0, k - 1);
    return rgb(STONE[k]);
  }
  if ((x & 31) == 0 && (y & 31) == 0) return rgb(0x34303c);
  return rgb(hash2(x, y, 1) > 0.996 ? 0x24212b : 0x1c1a22);
}

// 4×4 ordered dither for the composite, as the field's look uses.
float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

// A shockwave's push at px: along the ring, falling off a few pixels either side.
vec2 wavePush(vec4 w, vec2 px) {
  if (w.w <= 0.0) return vec2(0.0);
  vec2 dv = (px - w.xy) * vec2(1.0, 1.18);
  float d = length(dv);
  float k = (d - w.z) / 5.0;
  return (dv / max(d, 0.001)) * w.w * exp(-k * k);
}

float lightAt(vec4 l, vec2 px) {
  if (l.w <= 0.0 || l.z <= 0.0) return 0.0;
  float q = max(0.0, 1.0 - length((px - l.xy) * vec2(1.0, 1.18)) / l.z);
  return l.w * q * q;
}

// The scorch at world pixel px, bilinear between cells (each holds the scorch at its center): the lab keeps one texel
// per pixel, and its bands follow the soft circles, not the cells.
float scorchAt(vec2 px) {
  ivec2 last = textureSize(scorch, 0) - 1;
  vec2 c = (px + 0.5) / uScorchCell - 0.5;
  vec2 f = fract(c);
  ivec2 lo = clamp(ivec2(floor(c)), ivec2(0), last);
  ivec2 hi = min(lo + 1, last);
  float top = mix(texelFetch(scorch, lo, 0).r, texelFetch(scorch, ivec2(hi.x, lo.y), 0).r, f.x);
  float bottom = mix(texelFetch(scorch, ivec2(lo.x, hi.y), 0).r, texelFetch(scorch, hi, 0).r, f.x);
  return mix(top, bottom, f.y);
}

float heatAt(vec4 h, vec2 px) {
  if (h.w <= 0.0 || h.z <= 0.0) return 0.0;
  return h.w * max(0.0, 1.0 - length((px - h.xy) * vec2(1.0, 1.18)) / h.z);
}

void main() {
  vec2 px = floor(vWorld);
  float dth = bayer4(px) - 0.46875;

  vec2 push = wavePush(uWave0, px) + wavePush(uWave1, px) + wavePush(uWave2, px) + wavePush(uWave3, px)
            + wavePush(uWave4, px) + wavePush(uWave5, px);
  vec2 cpx = px - floor(push + 0.5);

  float heat = heatAt(uHeat0, cpx) + heatAt(uHeat1, cpx) + heatAt(uHeat2, cpx) + heatAt(uHeat3, cpx);
  float haze = smoothstep(0.015, 0.09, heat);
  vec2 gpx = cpx + vec2(floor(sin(px.y * 0.9 + uBlastTime * 15.0) * haze * 1.6 + 0.5), 0.0);
  vec3 g = groundAt(ivec2(gpx));

  float sc = scorchAt(gpx) + dth * 0.22;
  g *= sc > 0.78 ? vec3(0.22, 0.2, 0.2) : sc > 0.5 ? vec3(0.42, 0.38, 0.36) : sc > 0.24 ? vec3(0.68, 0.64, 0.6) : vec3(1.0);

  float lt = lightAt(uLight0, px) + lightAt(uLight1, px) + lightAt(uLight2, px) + lightAt(uLight3, px)
           + lightAt(uLight4, px) + lightAt(uLight5, px) + lightAt(uLight6, px) + lightAt(uLight7, px);
  float lq = floor(clamp(lt + dth * 0.3, 0.0, 1.25) * 4.0) / 4.0;
  g += g * uLightCol * lq * 1.7 + uLightCol * lq * 0.05;

  finalColor = vec4(g, 1.0);
}
