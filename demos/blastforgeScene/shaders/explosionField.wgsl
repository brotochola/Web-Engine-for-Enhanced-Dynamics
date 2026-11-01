// explosionField.wgsl – explosionField.frag for WebGPU (the landing page runs Blastforge's explosions there), the same
// pixel art step for step, and the same smooth mode (uSmooth).
//
// The layer draws every field puff additively into uTexture, one texel per
// world pixel. Each channel is an amount: red = heat, green = smoke,
// blue = dust (see fieldColor() in explosions.js). This shader turns those
// amounts into pixel art:
//   - each amount picks a color band from the palette (7 fire, 5 smoke, 4 dust),
//   - a 4×4 Bayer pattern dithers the band edges,
//   - the slope of each amount lights it from uLightDirection,
//   - thin smoke gets a dark outline, and smoke glows where hidden fire is,
//   - shockwave rings shift whole pixels, and blast lights lift smoke and dust, as on the ground (blastGround.js).
// The uniforms are explosionLayers()'s (explosions.js) and effectUniforms()'s (blastGround.js), plus the engine's
// uCanvasSize, uCameraPos and uViewSize.

// 4×4 ordered dither, -0.47..0.47
fn bayer2(a0: vec2<f32>) -> f32 {
  let a = floor(a0);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}

fn bayer4(a: vec2<f32>) -> f32 {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

fn fireColor(heat: f32) -> vec3<f32> {
  if (heat > 0.86) { return customUniforms.uFire6; }
  if (heat > 0.68) { return customUniforms.uFire5; }
  if (heat > 0.52) { return customUniforms.uFire4; }
  if (heat > 0.38) { return customUniforms.uFire3; }
  if (heat > 0.26) { return customUniforms.uFire2; }
  if (heat > 0.16) { return customUniforms.uFire1; }
  return customUniforms.uFire0;
}

fn smokeColor(shade: f32) -> vec3<f32> {
  if (shade < 0.2) { return customUniforms.uSmoke0; }
  if (shade < 0.4) { return customUniforms.uSmoke1; }
  if (shade < 0.6) { return customUniforms.uSmoke2; }
  if (shade < 0.8) { return customUniforms.uSmoke3; }
  return customUniforms.uSmoke4;
}

fn dustColor(shade: f32) -> vec3<f32> {
  if (shade < 0.25) { return customUniforms.uDust0; }
  if (shade < 0.5) { return customUniforms.uDust1; }
  if (shade < 0.75) { return customUniforms.uDust2; }
  return customUniforms.uDust3;
}

// Smooth mode (uSmooth): the palettes as continuous ramps, fire through its band thresholds.
fn fireRamp(h: f32) -> vec3<f32> {
  if (h < 0.16) { return customUniforms.uFire0; }
  if (h < 0.26) { return mix(customUniforms.uFire0, customUniforms.uFire1, (h - 0.16) / 0.10); }
  if (h < 0.38) { return mix(customUniforms.uFire1, customUniforms.uFire2, (h - 0.26) / 0.12); }
  if (h < 0.52) { return mix(customUniforms.uFire2, customUniforms.uFire3, (h - 0.38) / 0.14); }
  if (h < 0.68) { return mix(customUniforms.uFire3, customUniforms.uFire4, (h - 0.52) / 0.16); }
  if (h < 0.86) { return mix(customUniforms.uFire4, customUniforms.uFire5, (h - 0.68) / 0.18); }
  return mix(customUniforms.uFire5, customUniforms.uFire6, clamp((h - 0.86) / 0.3, 0.0, 1.0));
}

fn smokeRamp(shade: f32) -> vec3<f32> {
  let x = clamp(shade, 0.0, 1.0) * 4.0;
  if (x < 1.0) { return mix(customUniforms.uSmoke0, customUniforms.uSmoke1, x); }
  if (x < 2.0) { return mix(customUniforms.uSmoke1, customUniforms.uSmoke2, x - 1.0); }
  if (x < 3.0) { return mix(customUniforms.uSmoke2, customUniforms.uSmoke3, x - 2.0); }
  return mix(customUniforms.uSmoke3, customUniforms.uSmoke4, x - 3.0);
}

fn dustRamp(shade: f32) -> vec3<f32> {
  let x = clamp(shade, 0.0, 1.0) * 3.0;
  if (x < 1.0) { return mix(customUniforms.uDust0, customUniforms.uDust1, x); }
  if (x < 2.0) { return mix(customUniforms.uDust1, customUniforms.uDust2, x - 1.0); }
  return mix(customUniforms.uDust2, customUniforms.uDust3, x - 2.0);
}

// A shockwave's push at world px p: along the ring, falling off a few pixels either side.
fn wavePush(w: vec4<f32>, p: vec2<f32>) -> vec2<f32> {
  if (w.w <= 0.0) { return vec2<f32>(0.0); }
  let dv = (p - w.xy) * vec2<f32>(1.0, 1.18);
  let d = length(dv);
  let k = (d - w.z) / 5.0;
  return (dv / max(d, 0.001)) * w.w * exp(-k * k);
}

fn lightAt(l: vec4<f32>, p: vec2<f32>) -> f32 {
  if (l.w <= 0.0 || l.z <= 0.0) { return 0.0; }
  let q = max(0.0, 1.0 - length((p - l.xy) * vec2<f32>(1.0, 1.18)) / l.z);
  return l.w * q * q;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let texels = max(customUniforms.uCanvasSize * customUniforms.uLayerResolution, vec2<f32>(1.0));
  let texel = 1.0 / texels;
  let pixel = floor(in.vTextureCoord * texels);
  let dither = bayer4(pixel) - 0.46875;

  // The texel's world pixel: shockwaves shift the field there, and lights lift its smoke and dust.
  let world = floor(customUniforms.uCameraPos + (pixel + 0.5) * texel * customUniforms.uViewSize);
  let push = wavePush(customUniforms.uWave0, world) + wavePush(customUniforms.uWave1, world)
    + wavePush(customUniforms.uWave2, world) + wavePush(customUniforms.uWave3, world)
    + wavePush(customUniforms.uWave4, world) + wavePush(customUniforms.uWave5, world);
  let lit = lightAt(customUniforms.uLight0, world) + lightAt(customUniforms.uLight1, world)
    + lightAt(customUniforms.uLight2, world) + lightAt(customUniforms.uLight3, world)
    + lightAt(customUniforms.uLight4, world) + lightAt(customUniforms.uLight5, world)
    + lightAt(customUniforms.uLight6, world) + lightAt(customUniforms.uLight7, world);
  let groundLight = floor(clamp(lit + dither * 0.3, 0.0, 1.25) * 4.0) / 4.0;
  let uv = (pixel - floor(push * texels / customUniforms.uViewSize + 0.5) + 0.5) * texel;

  // Every sample first: WGSL wants textureSample in uniform control flow. Slopes are three texels apart.
  let scale = customUniforms.uFieldScale;
  let here = textureSample(uTexture, uSampler, uv).rgb * scale;
  let left = textureSample(uTexture, uSampler, uv - vec2<f32>(3.0 * texel.x, 0.0)).rgb * scale;
  let right = textureSample(uTexture, uSampler, uv + vec2<f32>(3.0 * texel.x, 0.0)).rgb * scale;
  let up = textureSample(uTexture, uSampler, uv - vec2<f32>(0.0, 3.0 * texel.y)).rgb * scale;
  let down = textureSample(uTexture, uSampler, uv + vec2<f32>(0.0, 3.0 * texel.y)).rgb * scale;
  if (customUniforms.uShowField > 0.5) {
    return vec4<f32>(clamp(here * 0.5, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
  }

  // Each amount lit from uLightDirection.
  let light = normalize(customUniforms.uLightDirection);
  let heat = here.r;
  let smoke = here.g;
  let dust = here.b;
  let heatLight = clamp(dot(-vec2<f32>(right.r - left.r, down.r - up.r), light) * 1.4, -0.3, 0.3);
  let smokeLight = clamp(dot(-vec2<f32>(right.g - left.g, down.g - up.g), light) / (0.3 + smoke) * 1.05, -0.4, 0.4);
  let dustLight = clamp(dot(-vec2<f32>(right.b - left.b, down.b - up.b), light) / (0.25 + dust) * 1.6, -0.5, 0.5);
  let dith = customUniforms.uDither;

  if (customUniforms.uSmooth > 0.5) {
    // No bands: each amount fades in softly and takes its color from a ramp, lit by the same slopes; dust, then
    // smoke, then fire composited over each other (premultiplied).
    var p = vec3<f32>(0.0);
    var a = 0.0;
    let dustA = smoothstep(0.05, 0.3, dust);
    let dustTone = dustRamp(0.58 + dustLight - (min(dust, 1.2) - 0.13) * 0.4 + lit * 0.15);
    p = dustTone * dustA;
    a = dustA;
    let smokeA = smoothstep(0.04, 0.4, smoke) * 0.95;
    let smokeShade = clamp(0.47 + smokeLight - (min(smoke, 1.2) - 0.14) * 0.22 + lit * 0.18, 0.0, 1.0);
    let ember = smoothstep(0.04, 0.35, heat); // fire inside the smoke glows through its shadow side
    let smokeTone = mix(smokeRamp(smokeShade), fireRamp(0.2 + 0.25 * ember), ember * (1.0 - smokeShade) * 0.9);
    p = smokeTone * smokeA + p * (1.0 - smokeA);
    a = smokeA + a * (1.0 - smokeA);
    let heatV = heat + heatLight * 0.12;
    let cover = select(1.0, clamp(heatV / max(smoke * 0.25, 0.0001), 0.0, 1.0), heatV < 0.3); // only thick smoke hides weak fire
    let fireA = smoothstep(0.02, 0.15, heatV) * cover;
    p = fireRamp(heatV) * fireA + p * (1.0 - fireA);
    a = fireA + a * (1.0 - fireA);
    return vec4<f32>(p, a);
  }

  var color = vec3<f32>(0.0);
  var alpha = 0.0;

  // Dust, at the bottom
  let dustEdge = dust + dither * dith * 0.28;
  if (dustEdge > 0.13) {
    let shade = clamp(0.58 + dustLight - (min(dust, 1.2) - 0.13) * 0.4 + dither * dith * 0.3 + groundLight * 0.15, 0.0, 0.999);
    color = dustColor(shade);
    if (customUniforms.uOutline > 0.5 && dustEdge < 0.17) { color = customUniforms.uDust0; }
    alpha = 1.0;
  }

  // Smoke over the dust
  let smokeEdge = smoke + dither * dith * 0.3;
  if (smokeEdge > 0.14) {
    let shade = clamp(0.47 + smokeLight - (min(smoke, 1.2) - 0.14) * 0.22 + dither * dith * 0.32 + groundLight * 0.18, 0.0, 0.999);
    var smokeTone = smokeColor(shade);
    if (customUniforms.uOutline > 0.5 && smokeEdge < 0.185) { smokeTone = customUniforms.uSmoke0; }
    // Fire hidden inside the smoke glows through its shadow side.
    let glow = smoothstep(0.06, 0.32, heat + dither * 0.06);
    if (glow > 0.0 && shade < 0.16 + glow * 0.3) { smokeTone = select(customUniforms.uFire0, customUniforms.uFire1, glow > 0.55); }
    color = smokeTone;
    alpha = 1.0;
  }

  // Fire on top, unless thick smoke covers it
  let heatEdge = heat + heatLight * 0.12 + dither * dith * 0.12;
  if (heatEdge > 0.08 && (heatEdge > smoke * 0.45 || heatEdge > 0.3)) {
    color = fireColor(heatEdge);
    alpha = 1.0;
  }

  return vec4<f32>(color * alpha, alpha);
}
