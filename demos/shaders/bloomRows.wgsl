// The platformer's bloom, first of two passes: what is bright in the layer's picture, blurred along x.
// bloomColumns blurs it along y and adds it to the picture. The engine's look prelude gives the uniforms, VertexOut and
// the uTexture and uSampler bindings.

const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);
const STACKBLUR_MAX_R: i32 = 8;
const PAIR_TAPS: i32 = 4; // STACKBLUR_MAX_R / 2: texel pairs each side of the centre

fn extractBright(c: vec3<f32>) -> vec3<f32> {
  let b = dot(c, LUMA);
  let knee = max(customUniforms.uThreshold * 0.35, 0.005);
  let w = smoothstep(customUniforms.uThreshold - knee, customUniforms.uThreshold + knee, b);
  let excess = max(b - customUniforms.uThreshold, 0.0) / max(b, 0.001);
  return c * w * excess;
}

// The kernel's shape (a triangle, as StackBlur's: radius + 1 - |i|).
fn triWeight(i: f32, rad: f32) -> f32 {
  return max(rad + 1.0 - abs(i), 0.0);
}

// One of the 9 taps that cover 17 texels: tap 0 is the centre texel; tap k (1 to 4 each side) reads texels 2k-1 and 2k
// at once, at the point between them where their weights split, so the texture's linear filter returns their weighted
// average in one fetch. Returns (weight, offset in texels).
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

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let rad = clamp(floor(customUniforms.uBlurSize + 0.5), 1.0, f32(STACKBLUR_MAX_R));
  var acc = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var i = -PAIR_TAPS; i <= PAIR_TAPS; i++) {
    let t = pairTap(f32(i), rad);
    if (t.x <= 0.0) { continue; }
    let uv = in.vTextureCoord + vec2<f32>(t.y * customUniforms.uTexelSize.x, 0.0);
    acc += extractBright(textureSampleLevel(uTexture, uSampler, uv, 0.0).rgb) * t.x;
    wsum += t.x;
  }
  return vec4<f32>(acc / max(wsum, 0.001), 1.0);
}
