// DX-POST measurement pass: the frame below, darkened toward the corners by uAmount (0 = a copy).
// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms, VertexOut, uTexture/uSampler.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, in.vTextureCoord);
  let d = in.vTextureCoord - vec2<f32>(0.5, 0.5);
  let v = 1.0 - customUniforms.uAmount * dot(d, d) * 2.0;
  return vec4<f32>(c.rgb * v, c.a);
}
