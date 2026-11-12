// Sun Street's vignette, a LAYER_KIND.SCREEN pass after the grading: the corners darker by uAmount, round on any
// canvas (uCanvasSize is one of the engine's look uniforms).

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, in.vTextureCoord);
  var d = in.vTextureCoord - vec2<f32>(0.5, 0.5);
  d.x = d.x * customUniforms.uCanvasSize.x / max(customUniforms.uCanvasSize.y, 1.0);
  let v = 1.0 - customUniforms.uAmount * smoothstep(0.3, 0.95, length(d));
  return vec4<f32>(c.rgb * v, c.a);
}
