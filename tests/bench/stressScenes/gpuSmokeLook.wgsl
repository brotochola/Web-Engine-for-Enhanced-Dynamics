// gpuParticlesStressScene `?look=1` on WebGPU: gpuSmokeLook.frag's twin. Its density target holds GPU particles
// (premultiplied gray puffs, added); this bands them into three grays with a dark edge.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let k = textureSample(uTexture, uSampler, in.vTextureCoord).a;
  if (k < 0.18) {
    return vec4<f32>(0.0);
  }
  let c = select(select(vec3<f32>(0.66), vec3<f32>(0.42), k < 0.6), vec3<f32>(0.16), k < 0.3);
  let a = select(0.95, 0.85, k < 0.3);
  return vec4<f32>(c * a, a);
}
