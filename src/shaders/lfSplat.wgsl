// #include pixiGroups.wgsl

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vColor: vec4<f32>,
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
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let d2 = dot(in.vLocal, in.vLocal);
  let a = max(0.0, 1.0 - d2) * in.vColor.a;
  if (a < 0.001) { discard; }
  return vec4<f32>(in.vColor.rgb * a, a);
}
