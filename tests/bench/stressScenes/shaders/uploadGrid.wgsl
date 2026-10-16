@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let texel = textureLoad(cells, vec2<i32>(i32(in.vWorld.x), i32(in.vWorld.y)), 0);
  return vec4<f32>(texel.r, texel.r, texel.r, 1.0);
}
