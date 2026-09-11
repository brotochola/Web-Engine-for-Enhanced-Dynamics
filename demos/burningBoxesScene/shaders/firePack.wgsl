// Engine prelude provides: struct FrameData + var<uniform> frame, struct Body.

@group(1) @binding(0) var tRead: texture_2d<f32>;
@group(1) @binding(1) var stampTex: texture_2d<f32>;
@group(1) @binding(2) var uRead: texture_2d<f32>;
@group(1) @binding(3) var vRead: texture_2d<f32>;
@group(2) @binding(0) var packWrite: texture_storage_2d<rgba8unorm, write>;

fn pack_in_grid(c: vec2<i32>) -> bool {
  return c.x >= 0 && c.y >= 0 && c.x < i32(frame.texW) && c.y < i32(frame.texH);
}

fn pack_load_u(c: vec2<i32>) -> f32 {
  if (!pack_in_grid(c)) { return 0.0; }
  return textureLoad(uRead, c, 0).x;
}

fn pack_load_v(c: vec2<i32>) -> f32 {
  if (!pack_in_grid(c)) { return 0.0; }
  return textureLoad(vRead, c, 0).x;
}

@compute @workgroup_size(8, 8)
fn pack_heat(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (id.x >= i32(frame.texW) || id.y >= i32(frame.texH)) { return; }
  let mark = textureLoad(stampTex, id, 0);
  var heat = textureLoad(tRead, id, 0).x;
  if (mark.r < 0.5) {
    heat = 0.0;
  }
  heat = clamp(heat, 0.0, 1.0);
  let ember = clamp(mark.b, 0.0, 1.0);
  let u = 0.5 * (pack_load_u(id) + pack_load_u(id + vec2<i32>(1, 0)));
  let v = 0.5 * (pack_load_v(id) + pack_load_v(id + vec2<i32>(0, 1)));
  let scale = 0.12;
  let g = 0.5 + 0.5 * tanh(u * scale);
  let b = 0.5 + 0.5 * tanh(v * scale);
  textureStore(packWrite, id, vec4<f32>(heat, g, b, ember));
}

@compute @workgroup_size(8, 8)
fn clear_heat(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (id.x >= i32(frame.texW) || id.y >= i32(frame.texH)) { return; }
  textureStore(packWrite, id, vec4<f32>(0.0, 0.5, 0.5, 0.0));
}
