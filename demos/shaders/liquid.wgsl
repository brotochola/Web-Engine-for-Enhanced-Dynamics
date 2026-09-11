// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let sample = textureSample(uTexture, uSampler, in.vTextureCoord);
  let dens = sample.a;
  if (dens < customUniforms.uCutoff) {
    discard;
  }
  if (dens < customUniforms.uFoam) {
    return vec4<f32>(1.0);
  }
  let depth = smoothstep(customUniforms.uFoam, customUniforms.uFoam + max(customUniforms.uDepth, 0.001), dens);
  let edgeCol = sample.rgb * vec3<f32>(0.85, 1.05, 1.35);
  let coreCol = sample.rgb * vec3<f32>(0.35, 0.55, 1.05);
  let col = mix(edgeCol, coreCol, depth);
  let a = mix(customUniforms.uEdgeAlpha, customUniforms.uBodyAlpha, depth);
  return vec4<f32>(col, a);
}
