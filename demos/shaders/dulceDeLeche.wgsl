// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let sample = textureSample(uTexture, uSampler, in.vTextureCoord);
  let dens = sample.a;
  if (dens < customUniforms.uCutoff) {
    discard;
  }
  if (dens < customUniforms.uRim) {
    let t = smoothstep(customUniforms.uCutoff, customUniforms.uRim, dens);
    let rimCol = mix(vec3<f32>(1.0, 0.92, 0.72), sample.rgb * vec3<f32>(1.15, 1.0, 0.75), t);
    let a = mix(customUniforms.uEdgeAlpha * 0.55, customUniforms.uEdgeAlpha, t);
    return vec4<f32>(rimCol, a);
  }
  let depth = smoothstep(customUniforms.uRim, customUniforms.uRim + max(customUniforms.uDepth, 0.001), dens);
  let edgeCol = sample.rgb * vec3<f32>(1.2, 1.05, 0.7);
  let midCol = sample.rgb * vec3<f32>(1.05, 0.75, 0.4);
  let coreCol = sample.rgb * vec3<f32>(0.55, 0.32, 0.12);
  let warm = mix(edgeCol, midCol, depth);
  let col = mix(warm, coreCol, depth * depth);
  let a = mix(customUniforms.uEdgeAlpha, customUniforms.uBodyAlpha, depth);
  return vec4<f32>(col, a);
}
