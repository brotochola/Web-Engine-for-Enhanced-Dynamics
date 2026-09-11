// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.
// Scene uniforms (config) are fields of customUniforms; uTime/uDt/uZoom/
// uCameraPos/uCanvasSize/uWorldSize/uViewSize/uTexSize are engine-fed.
//
// Lattice UV (Y-down, view top-left). Pack is not Y-flipped. Kindling
// negatives + +uTime*scroll crawl toward smaller uv.y = screen up.

fn hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise21(p: vec2<f32>) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn latticeUv(quad: vec2<f32>) -> vec2<f32> {
  let h = (customUniforms.uCanvasSize.x / max(customUniforms.uZoom, 1e-6)) / max(customUniforms.uTexSize.x, 1.0);
  let origin = floor(customUniforms.uCameraPos / h) * h;
  let extent = customUniforms.uTexSize * h;
  let world = customUniforms.uCameraPos + quad * customUniforms.uViewSize;
  return (world - origin) / extent;
}

fn layerN(uv: vec2<f32>, freq: f32, amp: f32, scroll: f32) -> f32 {
  return noise21(uv * freq + vec2<f32>(0.0, customUniforms.uTime * scroll)) * amp;
}

fn smokeN(uv: vec2<f32>) -> f32 {
  return layerN(uv, 8.0, 0.5, customUniforms.uSmokeScroll0)
    + layerN(uv, 16.0, 0.25, customUniforms.uSmokeScroll1)
    + layerN(uv, 32.0, 0.125, customUniforms.uSmokeScroll2);
}

fn fireGrain(uv: vec2<f32>) -> f32 {
  return layerN(uv, 12.0, 0.5, customUniforms.uFireScroll0)
    + layerN(uv, 24.0, 0.25, customUniforms.uFireScroll1)
    + layerN(uv, 48.0, 0.125, customUniforms.uFireScroll2);
}

fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let k = vec3<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let p = abs(fract(vec3<f32>(h) + k) * 6.0 - 3.0);
  return v * mix(vec3<f32>(1.0), clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), s);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let uv = latticeUv(in.vTextureCoord);
  let heat = textureSample(uTexture, uSampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)));
  let t = heat.r;
  let view = i32(customUniforms.uView + 0.5);

  if (view == 1) {
    return vec4<f32>(vec3<f32>(t), 1.0);
  }
  if (view == 2) {
    let n = smokeN(uv);
    return vec4<f32>(vec3<f32>(n), 1.0);
  }
  if (view == 3) {
    let vel = heat.gb * 2.0 - 1.0;
    let mag = length(vel);
    let ang = atan2(vel.y, vel.x);
    let hue = ang / 6.2831853 + 0.5;
    let rgbFlow = hsv2rgb(hue, 1.0, clamp(mag * 1.35, 0.0, 1.0));
    let aFlow = select(0.0, 1.0, mag > 0.02);
    return vec4<f32>(rgbFlow * aFlow, aFlow);
  }

  let cutoff = max(0.002, customUniforms.uDrawCutoff);
  if (t <= cutoff) {
    return vec4<f32>(0.0);
  }
  let split = customUniforms.uSmokeSplit;
  var rgb: vec3<f32>;
  var a: f32;

  if (t < split) {
    let s = select(0.0, t / split, split > 0.0);
    let puff = pow(max(s, 0.0), max(customUniforms.uSmokePuff, 0.2));
    let n = smokeN(uv);
    let noiseAmt = clamp(customUniforms.uSmokeNoise, 0.0, 1.0);
    let lumps = 0.32 + 0.95 * n;
    let holes = smoothstep(0.2, 0.82, n);
    let grain = mix(1.0, lumps * holes, noiseAmt);
    let dens = clamp(puff * max(customUniforms.uSmokeDens, 0.0) * grain, 0.0, 1.0);
    a = customUniforms.uSmokeOn * customUniforms.uSmokeAlpha * dens;
    let soot = vec3<f32>(0.05, 0.05, 0.055);
    let ash = mix(vec3<f32>(0.36, 0.34, 0.32), vec3<f32>(0.5, 0.48, 0.45), n);
    let pale = mix(vec3<f32>(0.07, 0.075, 0.08), ash, clamp(s * 1.25, 0.0, 1.0));
    let sootMix = clamp((customUniforms.uSmokeDens - 0.4) / 2.1, 0.0, 1.0);
    rgb = mix(pale, soot, sootMix * 0.82);
  } else if (customUniforms.uFireOn < 0.5) {
    return vec4<f32>(0.0);
  } else {
    let nAmt = clamp(customUniforms.uFireNoise, 0.0, 1.0);
    let fireN = fireGrain(uv);
    var f = (t - split) / max(1.0 - split, 0.0001);
    f = clamp(f + nAmt * (fireN - 0.5) * 0.85, 0.0, 1.0);
    let alphaScale = customUniforms.uFireAlpha;
    let shadeK = mix(1.0, 0.12 + 1.15 * fireN, nAmt);

    if (f < 0.25) {
      let k = f / 0.25;
      rgb = vec3<f32>(0.45 + 0.55 * k, 0.05 + 0.12 * k, 0.02);
    } else if (f < 0.65) {
      let k = (f - 0.25) / 0.40;
      rgb = vec3<f32>(1.0, 0.17 + 0.60 * k, 0.02 + 0.08 * k);
    } else {
      let k = (f - 0.65) / 0.35;
      rgb = vec3<f32>(1.0, 0.77 + 0.23 * k, 0.10 + 0.75 * k);
    }
    a = alphaScale * min(1.0, 0.7 + 0.3 * f);
    rgb *= shadeK;
    a *= shadeK;
  }

  a = clamp(a, 0.0, 1.0);
  return vec4<f32>(rgb * a, a);
}
