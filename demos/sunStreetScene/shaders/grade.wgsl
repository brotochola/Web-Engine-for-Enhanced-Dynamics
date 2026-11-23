// Sun Street's grading, a pointwise LAYER_KIND.SCREEN pass over the whole frame: warmer at golden hour, cooler and less
// saturated at night. uWarm and uNight (0 to 1) come from the scene's update, by the hour. The engine reads the frame
// and writes the colour: the vignette after it runs in the same draw. customUniforms is the engine look prelude's.

const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

fn weedPass(color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
  var rgb = color.rgb;
  var warm = rgb * vec3<f32>(1.10, 0.96, 0.78);
  warm = mix(warm, warm * warm * 1.3, 0.2);
  rgb = mix(rgb, warm, customUniforms.uWarm);
  let l = dot(rgb, LUMA);
  let night = mix(vec3<f32>(l), rgb, 0.55) * vec3<f32>(0.80, 0.92, 1.15) + vec3<f32>(0.0, 0.008, 0.025);
  rgb = mix(rgb, night, customUniforms.uNight);
  return vec4<f32>(rgb, color.a);
}
