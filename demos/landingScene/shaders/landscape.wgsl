// landscape.wgsl – the landing page's backdrop, painted per world pixel: sky, sun and moon, stars, clouds, three
// mountain ridges and the ground. The time of day (uDay: 0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk) sets every
// colour; the ridges and the clouds move with parallax from the drawn camera (the engine's uCameraPos, uViewSize);
// the ground's top is TerrainMap's heights (terrain.js), one per uTerrain.x world px.
//
// Uniforms: uDay, uTerrain (step px, samples, world width, world height), and the engine's uTime. Texture: heights
// (rgba8unorm, samples x 1: the height as a 16-bit fraction of the world's height in r and g).

const TAU: f32 = 6.28318530718;

fn hash1(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise1(x: f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(hash1(vec2<f32>(i, 0.0)), hash1(vec2<f32>(i + 1.0, 0.0)), u);
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash1(i);
  let b = hash1(i + vec2<f32>(1.0, 0.0));
  let c = hash1(i + vec2<f32>(0.0, 1.0));
  let d = hash1(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm1(x0: f32) -> f32 {
  var x = x0;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < 5; i++) {
    s += a * noise1(x);
    x = x * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

// Ridged: sharp peaks for the far mountains.
fn ridged1(x0: f32) -> f32 {
  var x = x0;
  var a = 0.55;
  var s = 0.0;
  for (var i = 0; i < 5; i++) {
    let n = 1.0 - abs(noise1(x) * 2.0 - 1.0);
    s += a * n * n;
    x = x * 2.1 + 9.3;
    a *= 0.48;
  }
  return s;
}

fn fbm2(p0: vec2<f32>) -> f32 {
  var p = p0;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < 4; i++) {
    s += a * noise2(p);
    p = p * 2.02 + vec2<f32>(3.1, 7.7);
    a *= 0.5;
  }
  return s;
}

// The ground's top at world x, from the heights texture.
fn groundTop(x: f32) -> f32 {
  let stepPx = customUniforms.uTerrain.x;
  let last = i32(customUniforms.uTerrain.y) - 1;
  let fx = max(x, 0.0) / stepPx;
  let i = min(i32(floor(fx)), last - 1);
  let f = fx - f32(i);
  let a = textureLoad(heights, vec2<i32>(i, 0), 0);
  let b = textureLoad(heights, vec2<i32>(i + 1, 0), 0);
  let ha = (round(a.r * 255.0) * 256.0 + round(a.g * 255.0)) / 65535.0;
  let hb = (round(b.r * 255.0) * 256.0 + round(b.g * 255.0)) / 65535.0;
  return mix(ha, hb, f) * customUniforms.uTerrain.w;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let p = in.vWorld;
  let view = vec4<f32>(customUniforms.uCameraPos, customUniforms.uViewSize);
  let s = (p - view.xy) / view.zw; // 0..1 across the screen
  let px = s * view.zw; // screen px
  let clock = customUniforms.uTime;

  // The sun's path: rises at the left at dawn, highest at noon, sets at the right at dusk; the moon opposite.
  let phase = fract(customUniforms.uDay);
  let ang = (phase - 0.25) * TAU;
  let e = sin(ang); // the sun's elevation, -1..1
  let dayW = smoothstep(-0.18, 0.35, e);
  let twilight = exp(-(e * e) / 0.05);
  let night = 1.0 - smoothstep(-0.32, 0.02, e);
  let horizonY = 0.66;

  // Sky gradient, with a warm band near the horizon at dawn and dusk.
  let zenith = mix(vec3<f32>(0.012, 0.02, 0.06), vec3<f32>(0.16, 0.42, 0.82), dayW);
  var horizon = mix(vec3<f32>(0.04, 0.06, 0.14), vec3<f32>(0.7, 0.85, 0.97), dayW);
  let dusk = select(vec3<f32>(1.0, 0.55, 0.32), vec3<f32>(1.0, 0.42, 0.3), phase > 0.5);
  horizon = mix(horizon, dusk, twilight * 0.85);
  let gy = clamp(s.y / horizonY, 0.0, 1.0);
  var col = mix(zenith, horizon, pow(gy, 1.6));
  col = mix(col, vec3<f32>(0.55, 0.3, 0.45), twilight * (1.0 - gy) * 0.25);

  // Sun and moon, fixed on the screen (far away), with a glow.
  let aspect = view.z / view.w;
  let sunUV = vec2<f32>(0.5 - 0.4 * cos(ang), horizonY - 0.58 * e);
  let moonUV = vec2<f32>(0.5 + 0.4 * cos(ang), horizonY + 0.58 * e);
  let dSun = length((s - sunUV) * vec2<f32>(aspect, 1.0));
  let dMoon = length((s - moonUV) * vec2<f32>(aspect, 1.0));
  let sunCol = mix(vec3<f32>(1.0, 0.55, 0.25), vec3<f32>(1.0, 0.96, 0.85), smoothstep(0.0, 0.5, e));
  col += sunCol * (exp(-dSun * 9.0) * 0.55 + exp(-dSun * 2.5) * 0.18 * (0.4 + twilight)) * smoothstep(-0.12, 0.05, e);
  col = mix(col, sunCol * 1.25, (1.0 - smoothstep(0.028, 0.034, dSun)) * smoothstep(-0.12, 0.0, e));
  let moonLit = (1.0 - smoothstep(-0.25, -0.05, e));
  col += vec3<f32>(0.6, 0.7, 0.9) * exp(-dMoon * 14.0) * 0.25 * moonLit;
  let crater = 0.85 + 0.15 * noise2((s - moonUV) * 220.0);
  col = mix(col, vec3<f32>(0.9, 0.92, 0.98) * crater, (1.0 - smoothstep(0.018, 0.022, dMoon)) * moonLit);

  // Stars at night, almost fixed, twinkling.
  let starCell = floor(px / 3.0 + view.xy * 0.02);
  let star = hash1(starCell);
  let tw = 0.6 + 0.4 * sin(clock * (1.5 + star * 4.0) + star * 40.0);
  col += vec3<f32>(0.9, 0.95, 1.0) * step(0.9975, star) * tw * night * (1.0 - gy * 0.7);

  // Clouds drifting high, lit by the sun (warm at dawn and dusk, grey-blue at night).
  let cloudP = vec2<f32>((view.x * 0.07 + px.x) * 0.0021 + clock * 0.012, px.y * 0.0062);
  let cloud = smoothstep(0.5, 0.82, fbm2(cloudP)) * (1.0 - smoothstep(0.12, 0.62, s.y));
  let cloudLit = mix(vec3<f32>(0.12, 0.13, 0.2), mix(vec3<f32>(1.0, 0.98, 0.95), vec3<f32>(1.0, 0.62, 0.45), twilight), dayW);
  col = mix(col, cloudLit, cloud * 0.85);

  // Light on the land: full by day, warm at the ends of it, blue and low at night.
  let lightTint = mix(vec3<f32>(0.32, 0.38, 0.6), mix(vec3<f32>(1.0, 1.0, 1.0), vec3<f32>(1.0, 0.72, 0.55), twilight), dayW);
  let light = mix(0.3, 1.0, dayW) * lightTint;

  // Three ridges, back to front: parallax, height, roughness, colour; each fades toward the horizon colour.
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let par = 0.08 + 0.15 * fk;
    let base = (0.5 + 0.075 * fk) * view.w;
    let amp = (0.2 - 0.05 * fk) * view.w;
    let xr = view.x * par + px.x;
    var ridge: f32;
    if (k == 0) {
      ridge = base - amp * ridged1(xr * 0.0016 + 3.0);
    } else {
      ridge = base - amp * fbm1(xr * (0.0022 + 0.0012 * fk) + fk * 31.7);
    }
    if (k == 2) {
      ridge -= 9.0 * pow(noise1(xr * 0.11), 3.0) + 4.0 * noise1(xr * 0.35); // a line of trees on the nearest ridge
    }
    if (px.y > ridge) {
      let hazeK = 0.55 - 0.2 * fk;
      let ridgeCol = select(select(vec3<f32>(0.25, 0.38, 0.46), vec3<f32>(0.12, 0.27, 0.17), k == 2), vec3<f32>(0.42, 0.45, 0.64), k == 0);
      let depth = (px.y - ridge) / view.w;
      let grain = 0.88 + 0.12 * noise2(vec2<f32>(xr * 0.02, px.y * 0.05));
      var m = mix(ridgeCol * grain * light, horizon, hazeK * (1.0 - depth * 1.2));
      // Snow on the far peaks, the sun's rim on every ridge.
      if (k == 0) {
        let snow = smoothstep(0.0, 0.025, 0.33 - ridge / view.w) * (1.0 - smoothstep(0.0, 0.03, depth));
        m = mix(m, vec3<f32>(0.92, 0.94, 1.0) * light, snow * 0.8);
      }
      let rim = (1.0 - smoothstep(0.0, 3.0, px.y - ridge)) * (0.25 + twilight * 0.4);
      m += sunCol * rim * dayW;
      col = m;
    }
  }

  // Mist where the mountains meet the land.
  let mist = smoothstep(0.6, 0.9, s.y) * 0.12;
  col = mix(col, horizon * light * 1.1, mist);

  // The ground: grass, soil, rock in strata, darker deeper, its edge anti-aliased.
  let top = groundTop(p.x);
  let depth = p.y - top;
  if (depth > -1.5) {
    let n = noise2(p * vec2<f32>(0.9, 0.25));
    let grassH = 7.0 + 4.0 * noise1(p.x * 0.15);
    let grass = mix(vec3<f32>(0.2, 0.52, 0.16), vec3<f32>(0.42, 0.7, 0.2), n * 0.8 + 0.1 * noise1(p.x * 0.05));
    let soil = mix(vec3<f32>(0.33, 0.22, 0.13), vec3<f32>(0.42, 0.29, 0.17), noise2(p * 0.08));
    let strata = fbm2(vec2<f32>(p.x * 0.004, p.y * 0.03));
    let rock = mix(vec3<f32>(0.3, 0.25, 0.22), vec3<f32>(0.47, 0.41, 0.36), strata);
    var g = select(select(rock, soil, depth < 40.0 + 10.0 * n), grass, depth < grassH);
    if (depth >= grassH && depth < grassH + 2.0) { g = g * 0.7; } // the grass's shadow line
    g = g * (1.0 - smoothstep(30.0, 260.0, depth) * 0.35);
    let ground = g * light;
    col = mix(col, ground, smoothstep(-1.5, 1.0, depth));
  }

  return vec4<f32>(col, 1.0);
}
