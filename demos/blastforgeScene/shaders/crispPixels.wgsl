// crispPixels.wgsl – crispPixels.frag for WebGPU (the landing page runs Blastforge's explosions there).
//
// The layer draws sparks, embers and debris into a texture with one texel per
// world pixel. Sprite edges come out soft; this makes every texel fully on or
// fully off, so the pieces are hard pixels on the same grid as the field.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let color = textureSample(uTexture, uSampler, in.vTextureCoord);
  if (color.a < 0.5) {
    return vec4<f32>(0.0);
  }
  return vec4<f32>(color.rgb / color.a, 1.0); // un-premultiply, then draw opaque
}
