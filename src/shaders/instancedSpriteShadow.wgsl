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

struct ShadowUniforms {
  uTileWorld: vec4<f32>,
  uSun: vec4<f32>,
  uLight: vec4<f32>,
  uCam: vec4<f32>,
  uPointScale: f32,
}
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var uTexLut: texture_2d<f32>;
@group(2) @binding(3) var<uniform> uniforms: ShadowUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vWorld: vec2<f32>,
  @location(3) vAtlasUV: vec4<f32>,
  @location(4) vTileInv: vec2<f32>,
  @location(5) vTileOff: vec2<f32>,
}

fn clipOff(out: ptr<function, VertexOut>, aQuad: vec2<f32>, aInstXY: vec2<f32>, aInstUV: vec4<f32>, aInstTileInv: vec2<f32>, aInstTileOff: vec2<f32>) {
  (*out).position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  (*out).vColor = vec4<f32>(0.0);
  (*out).vLocal = aQuad;
  (*out).vWorld = aInstXY;
  (*out).vAtlasUV = aInstUV;
  (*out).vTileInv = aInstTileInv;
  (*out).vTileOff = aInstTileOff;
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
  @location(10) aInstShadow: vec3<f32>,
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
  let height = aInstShadow.x;
  if (height <= 0.0) {
    clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
    return out;
  }
  let anchor = aInstAnchor + aInstShadow.yz;
  var sy = aInstScale.y;
  var alpha = uniforms.uSun.w;
  var c = uniforms.uSun.x;
  var s = uniforms.uSun.y;
  if (uniforms.uLight.w > 0.0) {
    let d = aInstXY - uniforms.uLight.xy;
    let distSq = dot(d, d);
    let rangeSq = uniforms.uLight.w;
    if (distSq < 1.0 || distSq > rangeSq) {
      clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
      return out;
    }
    let invDist = inverseSqrt(distSq);
    let distRatio = clamp(distSq * invDist * 0.00390625, 0.0, 1.0);
    sy = -(0.3 + distRatio * 0.9) * abs(aInstScale.y) * height;
    c = d.y * invDist;
    s = -d.x * invDist;
    let fade = 1.0 - distSq / rangeSq;
    alpha = clamp(uniforms.uLight.z / (uniforms.uLight.z + distSq), 0.0, 1.0) * uniforms.uPointScale * fade;
    if (alpha < 0.003) {
      clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
      return out;
    }
  } else {
    sy = -abs(aInstScale.y) * height * uniforms.uSun.z;
  }
  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  let local = (content - anchor * aInstSize) * vec2<f32>(aInstScale.x, sy);
  let rotated = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = rotated + aInstXY;
  let screen = (world - uniforms.uCam.xy) * uniforms.uCam.z;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(screen, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  if (abs(aInstRotCS.x) > 2.0) {
    out.position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  }
  out.vLocal = aQuad;
  out.vColor = vec4<f32>(0.0, 0.0, 0.0, alpha);
  out.vWorld = world;
  out.vAtlasUV = aInstUV;
  out.vTileInv = aInstTileInv;
  out.vTileOff = aInstTileOff;
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff));
  let a = t.a * in.vColor.a;
  if (a < 0.01) { discard; }
  return vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a, a);
}
