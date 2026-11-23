// The platformer's bloom, second of two passes: bloomRows' picture blurred along y and added to the layer's picture.
// The engine's look prelude gives the uniforms, VertexOut and the uTexture, uSampler and uSource bindings.

const STACKBLUR_MAX_R: i32 = 8;
const PAIR_TAPS: i32 = 4; // STACKBLUR_MAX_R / 2: texel pairs each side of the centre

fn triWeight(i: f32, rad: f32) -> f32 {
  return max(rad + 1.0 - abs(i), 0.0);
}

// As bloomRows': two texels a fetch.
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
  // The rows may be drawn at less than the layer's size (shader.passes' resolution): the radius in their texels.
  let texelPx = max(customUniforms.uTexelSize.y * customUniforms.uCanvasSize.y, 1.0);
  let rad = max(clamp(floor(customUniforms.uBlurSize + 0.5), 1.0, f32(STACKBLUR_MAX_R)) / texelPx, 1.0);
  var acc = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var j = -PAIR_TAPS; j <= PAIR_TAPS; j++) {
    let t = pairTap(f32(j), rad);
    if (t.x <= 0.0) { continue; }
    let uv = in.vTextureCoord + vec2<f32>(0.0, t.y * customUniforms.uTexelSize.y);
    acc += textureSampleLevel(uTexture, uSampler, uv, 0.0).rgb * t.x;
    wsum += t.x;
  }
  let scene = textureSampleLevel(uSource, uSampler, in.vTextureCoord, 0.0);
  return vec4<f32>(scene.rgb + acc / max(wsum, 0.001) * customUniforms.uIntensity, scene.a);
}
