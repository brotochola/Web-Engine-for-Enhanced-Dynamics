// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.

const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);
const STACKBLUR_MAX_R: i32 = 8;

fn texelStep() -> vec2<f32> {
  if (customUniforms.uTexelSize.x > 1e-6 && customUniforms.uTexelSize.y > 1e-6) {
    return customUniforms.uTexelSize;
  }
  return vec2<f32>(1.0 / 1024.0, 1.0 / 768.0);
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, LUMA);
}

fn extractBright(c: vec3<f32>) -> vec3<f32> {
  let b = luma(c);
  let knee = max(customUniforms.uThreshold * 0.35, 0.005);
  let w = smoothstep(customUniforms.uThreshold - knee, customUniforms.uThreshold + knee, b);
  let excess = max(b - customUniforms.uThreshold, 0.0) / max(b, 0.001);
  return c * w * excess;
}

fn brightAt(uv: vec2<f32>) -> vec3<f32> {
  return extractBright(textureSample(uTexture, uSampler, uv).rgb);
}

fn triWeight(i: f32, rad: f32) -> f32 {
  return max(rad + 1.0 - abs(i), 0.0);
}

fn stackBlurH(uv: vec2<f32>, px: vec2<f32>, rad: f32) -> vec3<f32> {
  var acc = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var i = -STACKBLUR_MAX_R; i <= STACKBLUR_MAX_R; i++) {
    let fi = f32(i);
    let w = triWeight(fi, rad);
    if (w <= 0.0) { continue; }
    acc += brightAt(uv + vec2<f32>(fi, 0.0) * px) * w;
    wsum += w;
  }
  return acc / max(wsum, 0.001);
}

fn stackBlurHV(uv: vec2<f32>, px: vec2<f32>, rad: f32) -> vec3<f32> {
  var acc = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var j = -STACKBLUR_MAX_R; j <= STACKBLUR_MAX_R; j++) {
    let fj = f32(j);
    let w = triWeight(fj, rad);
    if (w <= 0.0) { continue; }
    acc += stackBlurH(uv + vec2<f32>(0.0, fj) * px, px, rad) * w;
    wsum += w;
  }
  return acc / max(wsum, 0.001);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let scene = textureSample(uTexture, uSampler, in.vTextureCoord);
  let rad = clamp(floor(customUniforms.uBlurSize + 0.5), 1.0, f32(STACKBLUR_MAX_R));
  var glow = stackBlurHV(in.vTextureCoord, texelStep(), rad);
  glow *= customUniforms.uIntensity;
  return vec4<f32>(scene.rgb + glow, scene.a);
}
