// GPU particles (LAYER_KIND.GPU_PARTICLES), WebGPU: the same evaluation as gpuParticle.vert.glsl, from the spawn
// record (src/util/gpuParticleLayout.js GPU_REC) and the particle's age. src/util/gpuParticleEval.js is the JS twin.
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

struct GpuParticleUniforms {
  uGpuParticles: vec4<f32>, // x: now (ms on this ring's epoch), y: pixel snap
}
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var uTexLut: texture_2d<f32>;
@group(2) @binding(3) var<uniform> uniforms: GpuParticleUniforms;
@group(2) @binding(4) var uAnimStart: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vAtlasUV: vec4<f32>,
}

fn easeOf(t: f32, id: u32) -> f32 {
  if (t <= 0.0) { return 0.0; }
  if (t >= 1.0) { return 1.0; }
  switch id {
    case 0u: { return t; }
    case 1u: { return t * t; }
    case 2u: { return t * (2.0 - t); }
    case 3u: { return select(-1.0 + (4.0 - 2.0 * t) * t, 2.0 * t * t, t < 0.5); }
    case 4u: { return t * t * t; }
    case 5u: { let c5 = t - 1.0; return c5 * c5 * c5 + 1.0; }
    case 6u: {
      if (t < 0.5) { return 4.0 * t * t * t; }
      let c6 = 2.0 * t - 2.0;
      return (t - 1.0) * c6 * c6 + 1.0;
    }
    case 7u: { return pow(2.0, 10.0 * (t - 1.0)); }
    case 8u: { return 1.0 - pow(2.0, -10.0 * t); }
    case 9u: {
      if (t < 0.5) { return 0.5 * pow(2.0, 20.0 * t - 10.0); }
      return 1.0 - 0.5 * pow(2.0, -20.0 * t + 10.0);
    }
    case 10u: { return t * t * (2.70158 * t - 1.70158); }
    case 11u: { let c11 = t - 1.0; return c11 * c11 * (2.70158 * c11 + 1.70158) + 1.0; }
    case 12u: {
      let s12 = 1.70158 * 1.525;
      let h12 = t * 2.0;
      if (t < 0.5) { return 0.5 * (h12 * h12 * ((s12 + 1.0) * h12 - s12)); }
      let k12 = h12 - 2.0;
      return 0.5 * (k12 * k12 * ((s12 + 1.0) * k12 + s12) + 2.0);
    }
    case 13u: {
      if (t < 1.0 / 2.75) { return 7.5625 * t * t; }
      if (t < 2.0 / 2.75) { let b1 = t - 1.5 / 2.75; return 7.5625 * b1 * b1 + 0.75; }
      if (t < 2.5 / 2.75) { let b2 = t - 2.25 / 2.75; return 7.5625 * b2 * b2 + 0.9375; }
      let b3 = t - 2.625 / 2.75;
      return 7.5625 * b3 * b3 + 0.984375;
    }
    default: { return t; }
  }
}

fn travel(p0: f32, v0: f32, a: f32, d: f32, t: f32) -> f32 {
  if (d < 1e-5) { return p0 + v0 * t + a * (t * t + t) * 0.5; }
  let terminal = a / d;
  return p0 + terminal * t + (v0 - terminal) * (1.0 - exp(-d * t)) / d;
}

fn rgbOf(bits: u32) -> vec3<f32> {
  return vec3<f32>(f32((bits >> 16u) & 255u), f32((bits >> 8u) & 255u), f32(bits & 255u)) / 255.0;
}

@vertex
fn mainVert(
  @location(0) aQuad: vec2<f32>,
  @location(1) aMove: vec4<f32>,
  @location(2) aHeight: vec4<f32>,
  @location(3) aTime: vec4<f32>,
  @location(4) aScale: vec4<f32>,
  @location(5) aColor: vec4<f32>,
  @location(6) aSpin: vec4<f32>,
  @location(7) aFrames: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.vLocal = aQuad;
  out.vColor = vec4<f32>(0.0);
  out.vAtlasUV = vec4<f32>(0.0);
  let age = uniforms.uGpuParticles.x - aTime.x;
  if (age < 0.0 || age >= aTime.y) {
    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let bits = bitcast<u32>(aSpin.z);
  let lp = age / aTime.y;
  let t = age / 16.67;
  let heighted = (bits & 0x1000000u) != 0u;
  let d = aHeight.w;
  let g = aHeight.z;
  let x = travel(aMove.x, aMove.z, 0.0, d, t);
  let y = travel(aMove.y, aMove.w, select(g, 0.0, heighted), d, t);
  let z = select(0.0, min(travel(aHeight.x, aHeight.y, g, d, t), 0.0), heighted);

  var sx = mix(aScale.x, aScale.y, easeOf(lp, (bits >> 4u) & 15u));
  var sy = mix(aScale.z, aScale.w, easeOf(lp, (bits >> 8u) & 15u));
  if ((bits & 0x2000000u) != 0u) { sx = -sx; }
  if ((bits & 0x4000000u) != 0u) { sy = -sy; }
  let alpha = mix(aColor.x, aColor.y, easeOf(lp, bits & 15u));
  let rgb = mix(rgbOf(bitcast<u32>(aColor.z)), rgbOf(bitcast<u32>(aColor.w)), easeOf(lp, (bits >> 12u) & 15u));
  let angle = mix(aTime.z, aTime.w, easeOf(lp, (bits >> 16u) & 15u))
    + mix(aSpin.x, aSpin.y, easeOf(lp, (bits >> 20u) & 15u)) * age;

  let frames = ((bits >> 27u) & 7u) + 1u;
  let f = min(u32(lp * f32(frames)), frames - 1u);
  var word = bitcast<u32>(aSpin.w);
  if (f >= 2u) { word = bitcast<u32>(aFrames.x); }
  if (f >= 4u) { word = bitcast<u32>(aFrames.y); }
  if (f >= 6u) { word = bitcast<u32>(aFrames.z); }
  let anim = i32(select(word & 65535u, word >> 16u, (f & 1u) == 1u));
  let animSize = vec2<i32>(textureDimensions(uAnimStart));
  var tid = -1;
  if (anim < animSize.x * animSize.y) {
    tid = i32(textureLoad(uAnimStart, vec2<i32>(anim % animSize.x, anim / animSize.x), 0).r + 0.5);
  }
  let lutSize = textureDimensions(uTexLut);
  var size = vec2<f32>(0.0);
  var uv = vec4<f32>(0.0);
  var trim = vec4<f32>(0.0);
  if (tid >= 0 && tid < i32(lutSize.y)) {
    let t0 = textureLoad(uTexLut, vec2<i32>(0, tid), 0);
    let t1 = textureLoad(uTexLut, vec2<i32>(1, tid), 0);
    let t2 = textureLoad(uTexLut, vec2<i32>(2, tid), 0);
    size = t0.xy;
    uv = vec4<f32>(t0.zw, t1.xy);
    trim = vec4<f32>(t1.zw, t2.xy);
  }

  var center = vec2<f32>(x, y + z);
  if (uniforms.uGpuParticles.y > 0.5) { center = floor(center) + 0.5; }
  let content = trim.xy + aQuad * trim.zw;
  let local = (content - 0.5 * size) * vec2<f32>(sx, sy);
  let c = cos(angle);
  let s = sin(angle);
  let world = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c) + center;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(world, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  out.vColor = vec4<f32>(rgb, alpha);
  out.vAtlasUV = uv;
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, mix(in.vAtlasUV.xy, in.vAtlasUV.zw, in.vLocal));
  return vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a, t.a * in.vColor.a);
}

@fragment
fn mainFragAdd(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, mix(in.vAtlasUV.xy, in.vAtlasUV.zw, in.vLocal));
  return vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a, 0.0);
}
