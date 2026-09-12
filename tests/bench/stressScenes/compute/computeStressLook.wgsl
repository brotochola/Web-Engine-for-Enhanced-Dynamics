// Engine look prelude provides VertexOut, uTexture, uSampler.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, in.vTextureCoord);
  return vec4<f32>(c.rgb, 1.0);
}
