// Sun Street's vignette, a pointwise LAYER_KIND.SCREEN pass after the grading: the corners darker by uAmount, round on any
// canvas (uCanvasSize is one of the engine's look uniforms).

fn weedPass(color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
  var d = uv - vec2<f32>(0.5, 0.5);
  d.x = d.x * customUniforms.uCanvasSize.x / max(customUniforms.uCanvasSize.y, 1.0);
  let v = 1.0 - customUniforms.uAmount * smoothstep(0.3, 0.95, length(d));
  return vec4<f32>(color.rgb * v, color.a);
}
