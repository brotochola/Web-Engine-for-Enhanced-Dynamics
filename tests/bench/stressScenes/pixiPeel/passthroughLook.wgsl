@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(uTexture, uSampler, in.vTextureCoord);
}
