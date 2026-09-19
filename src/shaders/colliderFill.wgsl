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

@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var uTexLut: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vColor: vec4<f32>,
  @location(1) vLocal: vec2<f32>,
  @location(2) vWorld: vec2<f32>,
  @location(3) vAtlasUV: vec4<f32>,
  @location(4) vTileInv: vec2<f32>,
  @location(5) vTileOff: vec2<f32>,
  @location(6) vHasTex: f32,
}

fn weedUv(vLocal: vec2<f32>, vWorld: vec2<f32>, vAtlasUV: vec4<f32>, vTileInv: vec2<f32>, vTileOff: vec2<f32>) -> vec2<f32> {
  var t = vLocal;
  if (vTileInv.x > 0.0) { t.x = fract(vWorld.x * vTileInv.x + vTileOff.x); }
  else if (vTileInv.x < 0.0) { t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x); }
  if (vTileInv.y > 0.0) { t.y = fract(vWorld.y * vTileInv.y + vTileOff.y); }
  else if (vTileInv.y < 0.0) { t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y); }
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}

@vertex
fn mainVert(
  @location(0) aTri: vec2<f32>,
  @location(1) aV0: vec2<f32>,
  @location(2) aV1: vec2<f32>,
  @location(3) aV2: vec2<f32>,
  @location(4) aInstXY: vec2<f32>,
  @location(5) aInstRotCS: vec2<f32>,
  @location(6) aInstTintBits: f32,
  @location(7) aInstDepth: f32,
  @location(8) aInstTexId: f32,
  @location(9) aInstTileInv: vec2<f32>,
  @location(10) aInstTileOff: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  let local = aV0 + aTri.x * (aV1 - aV0) + aTri.y * (aV2 - aV0);
  let c = aInstRotCS.x;
  let s = aInstRotCS.y;
  let rotated = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = rotated + aInstXY;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(world, 1.0);
  let tintBits = bitcast<u32>(aInstTintBits);
  let rgb = vec3<f32>(
    f32((tintBits >> 16u) & 255u),
    f32((tintBits >> 8u) & 255u),
    f32(tintBits & 255u)
  ) / 255.0;
  let instA = f32((tintBits >> 24u) & 255u) / 255.0;
  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);
  out.vColor = vec4<f32>(rgb, instA);
  out.vLocal = local;
  out.vWorld = world;
  out.vTileOff = aInstTileOff;

  let tid = i32(aInstTexId + 0.5);
  let lutSize = textureDimensions(uTexLut);
  var orig = vec2<f32>(0.0);
  var atlasUV = vec4<f32>(0.0);
  var hasTex = 0.0;
  if (aInstTexId >= 0.0 && tid >= 0 && tid < i32(lutSize.y)) {
    let t0 = textureLoad(uTexLut, vec2<i32>(0, tid), 0);
    let t1 = textureLoad(uTexLut, vec2<i32>(1, tid), 0);
    orig = t0.xy;
    atlasUV = vec4<f32>(t0.zw, t1.xy);
    hasTex = 1.0;
  }
  out.vAtlasUV = atlasUV;
  out.vHasTex = hasTex;
  if (hasTex > 0.5 && aInstTileInv.x == 0.0 && orig.x > 0.0) {
    out.vTileInv = 1.0 / orig;
  } else {
    out.vTileInv = aInstTileInv;
  }
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  // Sample first: WGSL forbids textureSample after a non-uniform vHasTex branch.
  let t = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff));
  let useTex = in.vHasTex >= 0.5;
  let a = select(in.vColor.a, t.a * in.vColor.a, useTex);
  let rgb = select(in.vColor.rgb * in.vColor.a, t.rgb * in.vColor.rgb * in.vColor.a, useTex);
  if (a < 0.01) { discard; }
  return vec4<f32>(rgb, a);
}
