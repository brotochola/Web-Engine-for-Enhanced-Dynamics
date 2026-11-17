// dxCaptureScene's ?worldFloor=1 (floorProbe.frag's WGSL): a checker of 16 px cells with two slow gradients.
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let cell = floor(in.vWorld / 16.0);
  let sum = cell.x + cell.y;
  let k = sum - 2.0 * floor(sum / 2.0);
  let t = textureLoad(cells, vec2<i32>(0, 0), 0).r;
  let f = fract(in.vWorld / 97.0);
  return vec4<f32>(0.25 + 0.5 * k * f.x, 0.3 + 0.4 * f.y, 0.35 + 0.3 * t, 1.0);
}
