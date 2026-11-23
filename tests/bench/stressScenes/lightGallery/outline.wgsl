// DX-GBUFSHADER's example, a LAYER_KIND.SCREEN pass: a dark line where the entity under a pixel changes, read from the
// frame's G-buffer (the entity ids map, uGbufIds: R * 256 + G the entity, A 1 where written; uGbufSize its texels),
// read at gbufTexel(uv), the engine's: the G-buffer's texel for a screen uv.

fn entityAt(c: vec2<i32>) -> f32 {
  let t = textureLoad(uGbufIds, c, 0);
  return select(0.0, floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5), t.a > 0.5);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, in.vTextureCoord);
  let size = customUniforms.uGbufSize;
  if (size.x < 1.0) {
    return c;
  }
  let last = vec2<i32>(size) - vec2<i32>(1, 1);
  let p = gbufTexel(in.vTextureCoord);
  let here = entityAt(p);
  var edge = step(0.5, abs(entityAt(min(p + vec2<i32>(1, 0), last)) - here));
  edge = max(edge, step(0.5, abs(entityAt(min(p + vec2<i32>(0, 1), last)) - here)));
  return vec4<f32>(c.rgb * (1.0 - 0.8 * edge), c.a);
}
