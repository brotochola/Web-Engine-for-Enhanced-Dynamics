// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.

const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);
const STACKBLUR_MAX_R: i32 = 8;
const PAIR_TAPS: i32 = 4; // STACKBLUR_MAX_R / 2: texel pairs each side of the centre

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

// One of the 9 taps that cover a 17-texel row of the kernel: tap 0 is the centre texel; tap k (1 to 4 each side)
// reads texels 2k-1 and 2k at once, at the point between them where their weights split, so the texture's linear
// filter returns their weighted average in one fetch. Returns (weight, offset in texels).
fn pairTap(k: f32, rad: f32) -> vec2<f32> {
  let ak = abs(k);
  if (ak < 0.5) { return vec2<f32>(rad + 1.0, 0.0); }
  let a = 2.0 * ak - 1.0;
  let b = 2.0 * ak;
  let wa = triWeight(a, rad);
  let wb = triWeight(b, rad);
  let w = wa + wb;
  var o = 0.0;
  if (w > 0.0) { o = (a * wa + b * wb) / w; }
  return vec2<f32>(w, sign(k) * o);
}

// The whole 2D triangular kernel ((2 x 8 + 1)^2 = 289 texels) in 9 x 9 = 81 bilinear fetches (E-450: the 289-fetch
// loop took 11 ms of GPU a frame at 1080p). The colour of each 2 x 2 group is exact; the bright extract then runs on
// the group's average instead of on each texel, which a blur this wide does not show.
fn stackBlurHV(uv: vec2<f32>, px: vec2<f32>, rad: f32) -> vec3<f32> {
  var acc = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var j = -PAIR_TAPS; j <= PAIR_TAPS; j++) {
    let ty = pairTap(f32(j), rad);
    if (ty.x <= 0.0) { continue; }
    for (var i = -PAIR_TAPS; i <= PAIR_TAPS; i++) {
      let tx = pairTap(f32(i), rad);
      if (tx.x <= 0.0) { continue; }
      let w = tx.x * ty.x;
      acc += brightAt(uv + vec2<f32>(tx.y, ty.y) * px) * w;
      wsum += w;
    }
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
