// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.
// Sprite-density RT: acc.a = blob field, acc.rgb = particle tint.

fn fireRamp(t: f32) -> vec3<f32> {
  let h = clamp(t, 0.0, 1.0);
  if (h < 0.35) {
    let k = h / 0.35;
    return vec3<f32>(0.45 + 0.55 * k, 0.04 + 0.12 * k, 0.01);
  }
  if (h < 0.7) {
    let k = (h - 0.35) / 0.35;
    return vec3<f32>(1.0, 0.18 + 0.55 * k, 0.02 + 0.08 * k);
  }
  let k = (h - 0.7) / 0.3;
  return vec3<f32>(1.0, 0.75 + 0.25 * k, 0.12 + 0.7 * k);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let acc = textureSample(uTexture, uSampler, in.vTextureCoord);
  let density = acc.a;
  let thresh = customUniforms.uThreshold;
  let edge = smoothstep(thresh - 0.03, thresh + 0.03, density);
  if (edge <= 0.0) {
    return vec4<f32>(0.0);
  }
  let tint = select(vec3<f32>(1.0), acc.rgb / max(density, 0.001), density > 0.001);
  let heat = clamp((density - thresh) / max(1.0 - thresh, 0.001), 0.0, 1.0);
  let rgb = mix(tint, fireRamp(heat), 0.55) * edge;
  let alpha = clamp(edge * customUniforms.uOpacity, 0.0, 1.0);
  return vec4<f32>(rgb * alpha, alpha);
}
