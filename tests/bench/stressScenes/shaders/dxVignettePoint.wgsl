// DX-POSTFUSE measurement pass: dxVignette as a pointwise map (the engine reads the frame and writes the colour).
const WARM = vec3<f32>(1.1, 1.0, 0.85);

fn weedPass(color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
  var d = uv - vec2<f32>(0.5, 0.5);
  d.x = d.x * customUniforms.uCanvasSize.x / max(customUniforms.uCanvasSize.y, 1.0);
  let v = 1.0 - customUniforms.uAmount * smoothstep(0.2, 0.9, length(d));
  return vec4<f32>(mix(color.rgb, color.rgb * WARM, customUniforms.uAmount) * v, color.a);
}
