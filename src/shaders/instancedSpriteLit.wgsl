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

struct BumpUniforms {
  uTileWorld: vec4<f32>,
  uAlphaCut: vec4<f32>,
  uSunDir: vec4<f32>,
  uLightTexWidth: f32,
  uLightCount: i32,
  uBaseAmbient: f32,
  uSunIntensity: f32,
  uSunR: f32,
  uSunG: f32,
  uSunB: f32,
  uNormalLightZ: f32,
  uNormalStrength: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var uTexLut: texture_2d<f32>;
@group(2) @binding(3) var<uniform> uniforms: BumpUniforms;
@group(2) @binding(4) var uNormalMap: texture_2d<f32>;
@group(2) @binding(5) var uLightData: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vWorld: vec2<f32>,
  @location(3) vAtlasUV: vec4<f32>,
  @location(4) vTileInv: vec2<f32>,
  @location(5) vTileOff: vec2<f32>,
  @location(6) vTangent: vec4<f32>,
}

fn weedUv(vLocal: vec2<f32>, vWorld: vec2<f32>, vAtlasUV: vec4<f32>, vTileInv: vec2<f32>, vTileOff: vec2<f32>) -> vec2<f32> {
  var t = vLocal;
  if (vTileInv.x > 0.0) { t.x = fract(vWorld.x * vTileInv.x + vTileOff.x); }
  else if (vTileInv.x < 0.0) { t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x); }
  if (vTileInv.y > 0.0) { t.y = fract(vWorld.y * vTileInv.y + vTileOff.y); }
  else if (vTileInv.y < 0.0) { t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y); }
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}

fn wrapNL(n: vec3<f32>, L: vec3<f32>) -> f32 {
  let denom = max(L.z, 0.0001);
  return clamp(dot(n, L) / denom, 0.0, 4.0);
}

fn bumpLightRatio(nWorld: vec3<f32>, vWorld: vec2<f32>) -> vec3<f32> {
  var Lflat = vec3<f32>(uniforms.uBaseAmbient);
  let sunColor = vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB);
  Lflat += sunColor * uniforms.uSunIntensity;
  var Lbump = vec3<f32>(uniforms.uBaseAmbient);
  Lbump += sunColor * uniforms.uSunIntensity * wrapNL(nWorld, uniforms.uSunDir.xyz);
  let nLights = uniforms.uLightCount;
  let texW = i32(uniforms.uLightTexWidth);
  for (var i = 0; i < MAX_LIGHTS; i++) {
    if (i >= nLights || i >= texW) { break; }
    let posInt = textureLoad(uLightData, vec2<i32>(i, 0), 0);
    let col = textureLoad(uLightData, vec2<i32>(i, 1), 0);
    let intensity = posInt.z;
    if (intensity <= 0.0) { continue; }
    let DISTANCE_SCALE = 1.0 / 1024.0;
    let deltaScaled = (vWorld - posInt.xy) * DISTANCE_SCALE;
    let d2Scaled = dot(deltaScaled, deltaScaled);
    let intensityScaled = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
    let attenuation = intensityScaled / (intensityScaled + d2Scaled);
    let L = normalize(vec3<f32>(posInt.xy - vWorld, uniforms.uNormalLightZ));
    Lflat += col.rgb * attenuation;
    Lbump += col.rgb * attenuation * wrapNL(nWorld, L);
  }
  return Lbump / max(Lflat, vec3<f32>(0.0001));
}

fn tangentFrom(scale: vec2<f32>, rotCS: vec2<f32>, tileInv: vec2<f32>) -> vec4<f32> {
  if (tileInv.x > 0.0 || tileInv.y > 0.0) {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
  }
  let sx = select(1.0, -1.0, scale.x < 0.0);
  let sy = select(1.0, -1.0, scale.y < 0.0);
  let c = rotCS.x;
  let s = rotCS.y;
  return vec4<f32>(c * sx, s * sx, -s * sy, c * sy);
}

@vertex
fn mainVert(
  @location(0) aQuad: vec2<f32>,
  @location(1) aInstXY: vec2<f32>,
  @location(2) aInstScale: vec2<f32>,
  @location(3) aInstAnchor: vec2<f32>,
  @location(4) aInstRotCS: vec2<f32>,
  @location(5) aInstDepth: f32,
  @location(6) aInstTintBits: f32,
  @location(7) aInstTexId: f32,
  @location(8) aInstTileInv: vec2<f32>,
  @location(9) aInstTileOff: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  let tid = i32(aInstTexId + 0.5);
  let lutSize = textureDimensions(uTexLut);
  var aInstSize = vec2<f32>(0.0);
  var aInstUV = vec4<f32>(0.0);
  var aInstTrim = vec4<f32>(0.0);
  if (tid >= 0 && tid < i32(lutSize.y)) {
    let t0 = textureLoad(uTexLut, vec2<i32>(0, tid), 0);
    let t1 = textureLoad(uTexLut, vec2<i32>(1, tid), 0);
    let t2 = textureLoad(uTexLut, vec2<i32>(2, tid), 0);
    aInstSize = t0.xy;
    aInstUV = vec4<f32>(t0.zw, t1.xy);
    aInstTrim = vec4<f32>(t1.zw, t2.xy);
  }
  let tintBits = bitcast<u32>(aInstTintBits);
  let rgb = vec3<f32>(
    f32((tintBits >> 16u) & 255u),
    f32((tintBits >> 8u) & 255u),
    f32(tintBits & 255u)
  ) / 255.0;
  let instA = f32((tintBits >> 24u) & 255u) / 255.0;
  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  let local = (content - aInstAnchor * aInstSize) * aInstScale;
  let c = aInstRotCS.x;
  let s = aInstRotCS.y;
  let rotated = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = rotated + aInstXY;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(world, 1.0);
  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);
  out.vLocal = aQuad;
  out.vColor = vec4<f32>(rgb, instA);
  out.vWorld = select(world, world * uniforms.uTileWorld.z + uniforms.uTileWorld.xy, uniforms.uTileWorld.w > 0.5);
  out.vAtlasUV = aInstUV;
  out.vTileInv = aInstTileInv;
  out.vTileOff = aInstTileOff;
  out.vTangent = tangentFrom(aInstScale, aInstRotCS, aInstTileInv);
  return out;
}

fn litAlbedo(in: VertexOut, discardAlpha: bool) -> vec4<f32> {
  let uv = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let t = textureSample(uTexture, uSampler, uv);
  let a = t.a * in.vColor.a;
  let cut = uniforms.uAlphaCut;
  if (discardAlpha && a < cut.x) { discard; }
  if (discardAlpha && cut.y > 0.0 && a >= cut.y) { discard; }
  let albedo = t.rgb * in.vColor.rgb * in.vColor.a;
  var nxy = textureSample(uNormalMap, uSampler, uv).xy * 2.0 - 1.0;
  nxy *= uniforms.uNormalStrength;
  if (dot(nxy, nxy) < 1e-6) {
    return vec4<f32>(albedo, a);
  }
  let nLocal = normalize(vec3<f32>(nxy, 1.0));
  let nWorld = normalize(vec3<f32>(
    nLocal.x * in.vTangent.x + nLocal.y * in.vTangent.z,
    nLocal.x * in.vTangent.y + nLocal.y * in.vTangent.w,
    nLocal.z
  ));
  return vec4<f32>(albedo * bumpLightRatio(nWorld, in.vWorld), a);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  return litAlbedo(in, true);
}

@fragment
fn mainFragBlend(in: VertexOut) -> @location(0) vec4<f32> {
  return litAlbedo(in, false);
}
