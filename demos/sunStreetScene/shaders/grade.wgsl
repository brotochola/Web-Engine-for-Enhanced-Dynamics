// Sun Street's grading, a LAYER_KIND.SCREEN pass over the whole frame: warmer at golden hour, cooler and less
// saturated at night. uWarm and uNight (0 to 1) come from the scene's update, by the hour.
// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms, VertexOut, uTexture/uSampler.

const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, in.vTextureCoord);
  var rgb = c.rgb;
  var warm = rgb * vec3<f32>(1.10, 0.96, 0.78);
  warm = mix(warm, warm * warm * 1.3, 0.2);
  rgb = mix(rgb, warm, customUniforms.uWarm);
  let l = dot(rgb, LUMA);
  let night = mix(vec3<f32>(l), rgb, 0.55) * vec3<f32>(0.80, 0.92, 1.15) + vec3<f32>(0.0, 0.008, 0.025);
  rgb = mix(rgb, night, customUniforms.uNight);
  return vec4<f32>(rgb, c.a);
}
