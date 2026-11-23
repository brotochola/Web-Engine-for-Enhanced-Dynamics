// DX-LAYERPASSES measurement pass: uSource, what the look's first pass read, whatever the passes before drew.
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(uSource, uSampler, in.vTextureCoord);
}
