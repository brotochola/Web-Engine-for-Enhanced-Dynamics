#version 300 es
// landscape.frag – landscape.wgsl for WebGL (worldRect fragments are GLSL ES 3.00), the same picture step for step:
// sky, sun and moon, stars, clouds, three mountain ridges and the ground, all keyed by the time of day (uDay).
precision highp float;

in vec2 vWorld;
out vec4 finalColor;

uniform float uDay;
uniform vec4 uTerrain;      // step px, samples, world width, world height
uniform vec2 uCameraPos;    // engine: the drawn view's top-left
uniform vec2 uViewSize;     // engine: the view in world px
uniform float uTime;        // engine: seconds
uniform sampler2D heights;  // rgba8: the ground's top as a 16-bit fraction of the world's height in r and g

const float TAU = 6.28318530718;

float hash1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hash1(vec2(i, 0.0)), hash1(vec2(i + 1.0, 0.0)), u);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash1(i);
  float b = hash1(i + vec2(1.0, 0.0));
  float c = hash1(i + vec2(0.0, 1.0));
  float d = hash1(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm1(float x) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * noise1(x);
    x = x * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

float ridged1(float x) {
  float a = 0.55;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    float n = 1.0 - abs(noise1(x) * 2.0 - 1.0);
    s += a * n * n;
    x = x * 2.1 + 9.3;
    a *= 0.48;
  }
  return s;
}

float fbm2(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * noise2(p);
    p = p * 2.02 + vec2(3.1, 7.7);
    a *= 0.5;
  }
  return s;
}

float heightAt(int i) {
  vec4 t = texelFetch(heights, ivec2(i, 0), 0);
  return (floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5)) / 65535.0;
}

float groundTop(float x) {
  int last = int(uTerrain.y) - 1;
  float fx = max(x, 0.0) / uTerrain.x;
  int i = min(int(floor(fx)), last - 1);
  float f = fx - float(i);
  return mix(heightAt(i), heightAt(i + 1), f) * uTerrain.w;
}

void main() {
  vec2 p = vWorld;
  vec4 view = vec4(uCameraPos, uViewSize);
  vec2 s = (p - view.xy) / view.zw;
  vec2 px = s * view.zw;
  float clock = uTime;

  float phase = fract(uDay);
  float ang = (phase - 0.25) * TAU;
  float e = sin(ang);
  float dayW = smoothstep(-0.18, 0.35, e);
  float twilight = exp(-(e * e) / 0.05);
  float night = 1.0 - smoothstep(-0.32, 0.02, e);
  float horizonY = 0.66;

  vec3 zenith = mix(vec3(0.012, 0.02, 0.06), vec3(0.16, 0.42, 0.82), dayW);
  vec3 horizon = mix(vec3(0.04, 0.06, 0.14), vec3(0.7, 0.85, 0.97), dayW);
  vec3 dusk = phase > 0.5 ? vec3(1.0, 0.42, 0.3) : vec3(1.0, 0.55, 0.32);
  horizon = mix(horizon, dusk, twilight * 0.85);
  float gy = clamp(s.y / horizonY, 0.0, 1.0);
  vec3 col = mix(zenith, horizon, pow(gy, 1.6));
  col = mix(col, vec3(0.55, 0.3, 0.45), twilight * (1.0 - gy) * 0.25);

  float aspect = view.z / view.w;
  vec2 sunUV = vec2(0.5 - 0.4 * cos(ang), horizonY - 0.58 * e);
  vec2 moonUV = vec2(0.5 + 0.4 * cos(ang), horizonY + 0.58 * e);
  float dSun = length((s - sunUV) * vec2(aspect, 1.0));
  float dMoon = length((s - moonUV) * vec2(aspect, 1.0));
  vec3 sunCol = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.96, 0.85), smoothstep(0.0, 0.5, e));
  col += sunCol * (exp(-dSun * 9.0) * 0.55 + exp(-dSun * 2.5) * 0.18 * (0.4 + twilight)) * smoothstep(-0.12, 0.05, e);
  col = mix(col, sunCol * 1.25, (1.0 - smoothstep(0.028, 0.034, dSun)) * smoothstep(-0.12, 0.0, e));
  float moonLit = 1.0 - smoothstep(-0.25, -0.05, e);
  col += vec3(0.6, 0.7, 0.9) * exp(-dMoon * 14.0) * 0.25 * moonLit;
  float crater = 0.85 + 0.15 * noise2((s - moonUV) * 220.0);
  col = mix(col, vec3(0.9, 0.92, 0.98) * crater, (1.0 - smoothstep(0.018, 0.022, dMoon)) * moonLit);

  vec2 starCell = floor(px / 3.0 + view.xy * 0.02);
  float star = hash1(starCell);
  float tw = 0.6 + 0.4 * sin(clock * (1.5 + star * 4.0) + star * 40.0);
  col += vec3(0.9, 0.95, 1.0) * step(0.9975, star) * tw * night * (1.0 - gy * 0.7);

  vec2 cloudP = vec2((view.x * 0.07 + px.x) * 0.0021 + clock * 0.012, px.y * 0.0062);
  float cloud = smoothstep(0.5, 0.82, fbm2(cloudP)) * (1.0 - smoothstep(0.12, 0.62, s.y));
  vec3 cloudLit = mix(vec3(0.12, 0.13, 0.2), mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.62, 0.45), twilight), dayW);
  col = mix(col, cloudLit, cloud * 0.85);

  vec3 lightTint = mix(vec3(0.32, 0.38, 0.6), mix(vec3(1.0), vec3(1.0, 0.72, 0.55), twilight), dayW);
  vec3 light = mix(0.3, 1.0, dayW) * lightTint;

  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float par = 0.08 + 0.15 * fk;
    float base = (0.5 + 0.075 * fk) * view.w;
    float amp = (0.2 - 0.05 * fk) * view.w;
    float xr = view.x * par + px.x;
    float ridge = k == 0 ? base - amp * ridged1(xr * 0.0016 + 3.0)
                         : base - amp * fbm1(xr * (0.0022 + 0.0012 * fk) + fk * 31.7);
    if (k == 2) ridge -= 9.0 * pow(noise1(xr * 0.11), 3.0) + 4.0 * noise1(xr * 0.35);
    if (px.y > ridge) {
      float hazeK = 0.55 - 0.2 * fk;
      vec3 ridgeCol = k == 0 ? vec3(0.42, 0.45, 0.64) : (k == 2 ? vec3(0.12, 0.27, 0.17) : vec3(0.25, 0.38, 0.46));
      float depth = (px.y - ridge) / view.w;
      float grain = 0.88 + 0.12 * noise2(vec2(xr * 0.02, px.y * 0.05));
      vec3 m = mix(ridgeCol * grain * light, horizon, hazeK * (1.0 - depth * 1.2));
      if (k == 0) {
        float snow = smoothstep(0.0, 0.025, 0.33 - ridge / view.w) * (1.0 - smoothstep(0.0, 0.03, depth));
        m = mix(m, vec3(0.92, 0.94, 1.0) * light, snow * 0.8);
      }
      float rim = (1.0 - smoothstep(0.0, 3.0, px.y - ridge)) * (0.25 + twilight * 0.4);
      m += sunCol * rim * dayW;
      col = m;
    }
  }

  float mist = smoothstep(0.6, 0.9, s.y) * 0.12;
  col = mix(col, horizon * light * 1.1, mist);

  float top = groundTop(p.x);
  float depth = p.y - top;
  if (depth > -1.5) {
    float n = noise2(p * vec2(0.9, 0.25));
    float grassH = 7.0 + 4.0 * noise1(p.x * 0.15);
    vec3 grass = mix(vec3(0.2, 0.52, 0.16), vec3(0.42, 0.7, 0.2), n * 0.8 + 0.1 * noise1(p.x * 0.05));
    vec3 soil = mix(vec3(0.33, 0.22, 0.13), vec3(0.42, 0.29, 0.17), noise2(p * 0.08));
    float strata = fbm2(vec2(p.x * 0.004, p.y * 0.03));
    vec3 rock = mix(vec3(0.3, 0.25, 0.22), vec3(0.47, 0.41, 0.36), strata);
    vec3 g = depth < grassH ? grass : (depth < 40.0 + 10.0 * n ? soil : rock);
    if (depth >= grassH && depth < grassH + 2.0) g *= 0.7;
    g *= 1.0 - smoothstep(30.0, 260.0, depth) * 0.35;
    col = mix(col, g * light, smoothstep(-1.5, 1.0, depth));
  }

  finalColor = vec4(col, 1.0);
}
