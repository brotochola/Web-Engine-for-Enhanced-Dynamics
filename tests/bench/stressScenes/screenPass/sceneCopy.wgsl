// DX-POST measurement pass: uScene, the frame before the first pass, whatever the passes before did.
// The prelude binds uScene (with uTexture and uSampler) for a SCREEN layer whose shader names it.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(uScene, uSampler, in.vTextureCoord);
}
