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
@group(2) @binding(3) var uPoseTable: texture_2d<f32>;

// DX-SUNMESH: xy, L · (shadowDirX, shadowDirY) on a sunProjected layer, whose U holds each vertex's height; 0 on any other.
// DX-VOLUME: z, 1 on the volumes' layer.
struct SunShadowUniforms {
  uSunShadow: vec4<f32>,
}
@group(2) @binding(4) var<uniform> sunShadow: SunShadowUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vColor: vec4<f32>,
  @location(1) vLocal: vec2<f32>,
  @location(2) vWorld: vec2<f32>,
  @location(3) vAtlasUV: vec4<f32>,
  @location(4) vTileInv: vec2<f32>,
  @location(5) vTileOff: vec2<f32>,
  @location(6) vHasTex: f32,
  @location(7) vMeshUV: vec2<f32>,
}

fn meshUv(vMeshUV: vec2<f32>, vAtlasUV: vec4<f32>) -> vec2<f32> {
  return mix(vAtlasUV.xy, vAtlasUV.zw, vMeshUV);
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
  @location(11) aInstBody: f32,
  @location(12) aUV0: vec2<f32>,
  @location(13) aUV1: vec2<f32>,
  @location(14) aUV2: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  let local = aV0 + aTri.x * (aV1 - aV0) + aTri.y * (aV2 - aV0);
  var xy = aInstXY;
  var cs = aInstRotCS;
  let id = i32(aInstBody + 0.5);
  let pose = textureLoad(uPoseTable, vec2<i32>(id % 256, id / 256), 0);
  if (pose.z != 0.0 || pose.w != 0.0) {
    xy = pose.xy;
    cs = pose.zw;
  }
  let c = cs.x;
  let s = cs.y;
  var rotated = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let f = aInstTileOff.x;
  if (sunShadow.uSunShadow.z > 0.0 && f > 0.0 && f != 1.0) {
    // meshUvFill.vert.glsl: the floor under a volume, and its heading on it.
    if (s == 0.0) {
      rotated.y *= f;
    } else {
      let heading = normalize(vec2<f32>(f * c, s));
      rotated = vec2<f32>(local.x * heading.x - local.y * heading.y, f * (local.x * heading.y + local.y * heading.x));
    }
  }
  let height = aUV0.x + aTri.x * (aUV1.x - aUV0.x) + aTri.y * (aUV2.x - aUV0.x);
  let world = rotated + xy + height * sunShadow.uSunShadow.xy;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(world, 1.0);
  let tintBits = bitcast<u32>(aInstTintBits);
  var rgb = vec3<f32>(
    f32((tintBits >> 16u) & 255u),
    f32((tintBits >> 8u) & 255u),
    f32(tintBits & 255u)
  ) / 255.0;
  let instA = f32((tintBits >> 24u) & 255u) / 255.0;
  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);
  // A volume's shadow is black whatever its entity's tint: GameObject.tint reaches the mesh too.
  if (sunShadow.uSunShadow.z > 0.0) {
    rgb = vec3<f32>(0.0);
  }
  out.vColor = vec4<f32>(rgb, instA * localUniforms.uColor.a); // the layer's alpha
  out.vLocal = local;
  out.vWorld = world;
  out.vTileOff = aInstTileOff;
  out.vMeshUV = aUV0 + aTri.x * (aUV1 - aUV0) + aTri.y * (aUV2 - aUV0);

  let tid = i32(aInstTexId + 0.5);
  let lutSize = textureDimensions(uTexLut);
  // N-111: lutPerRow textureIds a row, so no side of the LUT passes the device's limit (instancedSpriteBatch.js).
  let lutPerRow = i32(lutSize.x) / 3;
  var orig = vec2<f32>(0.0);
  var atlasUV = vec4<f32>(0.0);
  var hasTex = 0.0;
  if (aInstTexId >= 0.0 && tid >= 0 && tid < lutPerRow * i32(lutSize.y)) {
    let lutAt = vec2<i32>(3 * (tid % lutPerRow), tid / lutPerRow);
    let t0 = textureLoad(uTexLut, lutAt, 0);
    let t1 = textureLoad(uTexLut, lutAt + vec2<i32>(1, 0), 0);
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
  let t = textureSample(uTexture, uSampler, meshUv(in.vMeshUV, in.vAtlasUV));
  let useTex = in.vHasTex >= 0.5;
  let a = select(in.vColor.a, t.a * in.vColor.a, useTex);
  let rgb = select(in.vColor.rgb * in.vColor.a, t.rgb * in.vColor.rgb * in.vColor.a, useTex);
  if (a < 0.01) { discard; }
  return vec4<f32>(rgb, a);
}
