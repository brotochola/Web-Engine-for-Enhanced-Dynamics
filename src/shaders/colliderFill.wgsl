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

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vColor: vec4<f32>,
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
  out.vColor = vec4<f32>(rgb * instA, instA);
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  if (in.vColor.a < 0.01) { discard; }
  return in.vColor;
}
