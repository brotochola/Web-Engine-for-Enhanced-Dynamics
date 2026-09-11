struct SimParams {
  dt: f32,
  h: f32,
  numX: f32,
  numY: f32,
  originX: f32,
  originY: f32,
  shapeCount: f32,
  shiftX: f32,
  shiftY: f32,
  pad0: f32,
  rise: f32,
  smokeSplit: f32,
  pressureIters: f32,
  emberT: f32,
  drawCutoff: f32,
  fireCool: f32,
  smokeCool: f32,
  diffusion: f32,
  swirlForce: f32,
  emberOn: f32,
  overRelax: f32,
  bodyDrive: f32,
  sourcePad: f32,
  swirlDamp: f32,
  stampPad: f32,
  swirlChance: f32,
  swirlSpin: f32,
  swirlLife: f32,
  swirlRadius: f32,
  maxSwirls: f32,
  pad1: f32,
  pad2: f32,
}
@group(0) @binding(0) var<uniform> sim: SimParams;
@group(1) @binding(0) var tRead: texture_2d<f32>;
@group(1) @binding(1) var stampTex: texture_2d<f32>;
@group(1) @binding(2) var uRead: texture_2d<f32>;
@group(1) @binding(3) var vRead: texture_2d<f32>;
@group(2) @binding(0) var heatWrite: texture_storage_2d<rgba8unorm, write>;

fn pack_in_grid(c: vec2<i32>) -> bool {
  return c.x >= 0 && c.y >= 0 && c.x < i32(sim.numX) && c.y < i32(sim.numY);
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
  if (id.x >= i32(sim.numX) || id.y >= i32(sim.numY)) { return; }
  let mark = textureLoad(stampTex, id, 0);
  var heat = textureLoad(tRead, id, 0).x;
  heat = max(heat, mark.b);
  if (mark.r < 0.5 && mark.b <= 0.0) {
    heat = 0.0;
  }
  heat = clamp(heat, 0.0, 1.0);
  let u = 0.5 * (pack_load_u(id) + pack_load_u(id + vec2<i32>(1, 0)));
  let v = 0.5 * (pack_load_v(id) + pack_load_v(id + vec2<i32>(0, 1)));
  let scale = 0.12;
  let g = 0.5 + 0.5 * tanh(u * scale);
  let b = 0.5 + 0.5 * tanh(v * scale);
  textureStore(heatWrite, id, vec4<f32>(heat, g, b, 1.0));
}

@compute @workgroup_size(8, 8)
fn clear_heat(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (id.x >= i32(sim.numX) || id.y >= i32(sim.numY)) { return; }
  textureStore(heatWrite, id, vec4<f32>(0.0, 0.5, 0.5, 0.0));
}
