struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct CustomUniforms {
  uRise: f32,
  uSmokeSplit: f32,
  uPressureIters: f32,
  uTime: f32,
  uDrawCutoff: f32,
  uFireCool: f32,
  uSmokeCool: f32,
  uDiffusion: f32,
  uSwirlForce: f32,
  uEmberOn: f32,
}
@group(2) @binding(0) var<uniform> customUniforms: CustomUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vTextureCoord: vec2<f32>,
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(aPosition, 0.0, 1.0);
  out.vTextureCoord = aUV;
  return out;
}

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

fn layerN(uv: vec2<f32>, freq: f32, amp: f32, scroll: f32) -> f32 {
  return noise21(uv * freq + vec2<f32>(0.0, -customUniforms.uTime * scroll)) * amp;
}

fn smokeN(uv: vec2<f32>) -> f32 {
  return layerN(uv, 8.0, 0.5, 0.35)
    + layerN(uv, 16.0, 0.25, 0.7)
    + layerN(uv, 32.0, 0.125, 1.2);
}

fn fireGrain(uv: vec2<f32>) -> f32 {
  return layerN(uv, 12.0, 0.5, 1.0)
    + layerN(uv, 24.0, 0.25, 1.8)
    + layerN(uv, 48.0, 0.125, 2.8);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let heat = textureSample(uTexture, uSampler, in.vTextureCoord);
  let t = heat.r;
  let cutoff = max(0.002, customUniforms.uDrawCutoff);
  if (t <= cutoff) {
    return vec4<f32>(0.0);
  }
  let split = customUniforms.uSmokeSplit;
  var rgb: vec3<f32>;
  var a: f32;

  if (t < split) {
    let s = select(0.0, t / split, split > 0.0);
    let puff = pow(max(s, 0.0), 1.55);
    let n = smokeN(in.vTextureCoord);
    let lumps = 0.32 + 0.95 * n;
    let holes = smoothstep(0.2, 0.82, n);
    let grain = mix(1.0, lumps * holes, 0.55);
    let dens = clamp(puff * 1.3 * grain, 0.0, 1.0);
    a = 0.68 * dens;
    let soot = vec3<f32>(0.05, 0.05, 0.055);
    let ash = mix(vec3<f32>(0.36, 0.34, 0.32), vec3<f32>(0.5, 0.48, 0.45), n);
    let pale = mix(vec3<f32>(0.07, 0.075, 0.08), ash, clamp(s * 1.25, 0.0, 1.0));
    rgb = mix(pale, soot, 0.35);
  } else {
    let fireN = fireGrain(in.vTextureCoord);
    var f = (t - split) / max(1.0 - split, 0.0001);
    f = clamp(f + 0.4 * (fireN - 0.5) * 0.85, 0.0, 1.0);
    let shadeK = mix(1.0, 0.12 + 1.15 * fireN, 0.4);
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
    a = 0.85 * min(1.0, 0.7 + 0.3 * f);
    rgb *= shadeK;
    a *= shadeK;
  }

  a = clamp(a, 0.0, 1.0);
  return vec4<f32>(rgb * a, a);
}
