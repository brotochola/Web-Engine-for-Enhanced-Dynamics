// Cheap ping-pong iterate. Engine prelude provides FrameData + frame.
// Bright UV field so L2 headed screenshots are not a black canvas.

@group(1) @binding(0) var tRead: texture_2d<f32>;
@group(2) @binding(0) var tWrite: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn jacobi(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (id.x >= i32(frame.texW) || id.y >= i32(frame.texH)) {
    return;
  }
  let n = textureLoad(tRead, id, 0);
  let u = f32(id.x) / max(frame.texW, 1.0);
  let v = f32(id.y) / max(frame.texH, 1.0);
  let pulse = 0.5 + 0.5 * sin(frame.time * 1.7 + u * 6.283185);
  textureStore(tWrite, id, vec4<f32>(
    u * 0.75 + n.r * 0.08,
    pulse * 0.65 + n.g * 0.05,
    v * 0.85,
    1.0
  ));
}
