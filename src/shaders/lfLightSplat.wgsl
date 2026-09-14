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

struct LightSplatUniforms {
  uInvScreenScale: f32,
}
@group(2) @binding(0) var<uniform> uniforms: LightSplatUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vInstRadius: f32,
}

@vertex
fn mainVert(
  @location(0) aQuad: vec2<f32>,
  @location(1) aInstXY: vec2<f32>,
  @location(2) aInstRadius: f32,
  @location(3) aInstColor: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  let world = aInstXY + aQuad * aInstRadius;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(world, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  out.vLocal = aQuad;
  out.vColor = aInstColor;
  out.vInstRadius = aInstRadius;
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let inv = uniforms.uInvScreenScale;
  if (inv <= 0.0) { discard; }
  let worldRadius = in.vInstRadius * inv;
  if (worldRadius <= 0.0) { discard; }
  // Same compact support as LightEmitter: R = 10 * sqrt(I) so I = (R/10)^2
  let intensity = (worldRadius * 0.1) * (worldRadius * 0.1);
  let d = length(in.vLocal) * worldRadius;
  let att = intensity / (intensity + d * d);
  let fade = in.vColor.a;
  let a = att * fade;
  if (a < 0.001) { discard; }
  return vec4<f32>(in.vColor.rgb * a, a);
}
