// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, in.vTextureCoord);
  if (c.a < customUniforms.uCutoff) {
    discard;
  }
  let aL = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(-customUniforms.uRimWidth, 0.0)).a;
  let aR = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(customUniforms.uRimWidth, 0.0)).a;
  let aT = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(0.0, -customUniforms.uRimWidth)).a;
  let aB = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(0.0, customUniforms.uRimWidth)).a;
  let edge = step(aL, customUniforms.uCutoff) + step(aR, customUniforms.uCutoff)
    + step(aT, customUniforms.uCutoff) + step(aB, customUniforms.uCutoff);
  let rgb = mix(c.rgb, customUniforms.uRimColor, min(edge, 1.0) * customUniforms.uRimAlpha);
  return vec4<f32>(rgb, c.a);
}
