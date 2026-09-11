// Engine prelude provides: struct FrameData + var<uniform> frame, struct Body.
// Frame prefix: dt, texW/H, cameraX/Y, zoom, shapeCount, canvasW/H, worldW/H,
// time, prevCameraX/Y, prevZoom. Scene tail: config uniforms (frame.uRise, ...).

struct Swirl {
  x: f32,
  y: f32,
  omega: f32,
  radius: f32,
  vx: f32,
  life: f32,
  pad0: f32,
  pad1: f32,
}

@group(0) @binding(1) var<storage, read_write> swirls: array<Swirl>;
@group(0) @binding(2) var<storage, read> shapes: array<Body>;

@group(1) @binding(0) var uRead: texture_2d<f32>;
@group(1) @binding(1) var vRead: texture_2d<f32>;
@group(1) @binding(2) var tRead: texture_2d<f32>;
@group(1) @binding(3) var pRead: texture_2d<f32>;
@group(1) @binding(4) var stampTex: texture_2d<f32>;
@group(1) @binding(5) var velTex: texture_2d<f32>;

@group(2) @binding(0) var uWrite: texture_storage_2d<r32float, write>;
@group(2) @binding(1) var vWrite: texture_storage_2d<r32float, write>;
@group(2) @binding(2) var tWrite: texture_storage_2d<r32float, write>;
@group(2) @binding(3) var pWrite: texture_storage_2d<r32float, write>;

// World-fixed lattice: texel (i,j) = world cell (i,j), origin always (0,0).
// Texture covers the whole world (scene sizes compute.size.{width,height}
// from worldWidth/worldHeight/FIRE_CELL_SIZE) so panning/zoom never shift or
// resize it — no shift_fields, no wipe. `cell_active` bounds the *simulated*
// window to camera view + a margin (uLatticePad, in cells); cells outside
// stay zeroed (empty).
fn cell_h() -> f32 {
  return max(frame.uCellSize, 1e-6);
}

fn cell_active(id: vec2<i32>) -> bool {
  let h = cell_h();
  let pad = max(frame.uLatticePad, 0.0) * h;
  let view = vec2<f32>(frame.canvasW, frame.canvasH) / max(frame.zoom, 1e-6);
  let cam = vec2<f32>(frame.cameraX, frame.cameraY);
  let lo = cam - vec2<f32>(pad, pad);
  let hi = cam + view + vec2<f32>(pad, pad);
  let wpos = (vec2<f32>(id) + vec2<f32>(0.5)) * h;
  return wpos.x >= lo.x && wpos.y >= lo.y && wpos.x <= hi.x && wpos.y <= hi.y;
}

fn in_grid(c: vec2<i32>) -> bool {
  return c.x >= 0 && c.y >= 0 && c.x < i32(frame.texW) && c.y < i32(frame.texH);
}

fn load_u(c: vec2<i32>) -> f32 {
  if (!in_grid(c)) { return 0.0; }
  return textureLoad(uRead, c, 0).x;
}

fn load_v(c: vec2<i32>) -> f32 {
  if (!in_grid(c)) { return 0.0; }
  return textureLoad(vRead, c, 0).x;
}

fn load_t(c: vec2<i32>) -> f32 {
  if (!in_grid(c)) { return 0.0; }
  return textureLoad(tRead, c, 0).x;
}

fn load_p(c: vec2<i32>) -> f32 {
  if (!in_grid(c)) { return 0.0; }
  return textureLoad(pRead, c, 0).x;
}

fn open_cell(c: vec2<i32>) -> f32 {
  if (!in_grid(c)) { return 0.0; }
  return textureLoad(stampTex, c, 0).r;
}

fn inert_solid(c: vec2<i32>) -> bool {
  if (!in_grid(c)) { return false; }
  let mark = textureLoad(stampTex, c, 0);
  return mark.r < 0.5 && mark.a < 0.5;
}

fn load_body_vel(c: vec2<i32>) -> vec4<f32> {
  if (!in_grid(c)) { return vec4<f32>(0.0); }
  return textureLoad(velTex, c, 0);
}

fn interior(id: vec2<i32>) -> bool {
  let nx = i32(frame.texW);
  let ny = i32(frame.texH);
  return id.x > 0 && id.y > 0 && id.x < nx - 1 && id.y < ny - 1;
}

fn sample_bilinear(field: i32, x: f32, y: f32) -> f32 {
  let h = cell_h();
  let nx = frame.texW;
  let ny = frame.texH;
  if (x < h || y < h || x > nx * h || y > ny * h) {
    return 0.0;
  }
  var px = x;
  var py = y;
  var dx = 0.0;
  var dy = 0.0;
  if (field == 0) {
    dy = 0.5 * h;
  } else if (field == 1) {
    dx = 0.5 * h;
  } else {
    dx = 0.5 * h;
    dy = 0.5 * h;
  }
  let h1 = 1.0 / h;
  let fx = (px - dx) * h1;
  let fy = (py - dy) * h1;
  let x0 = i32(clamp(floor(fx), 0.0, nx - 1.0));
  let y0 = i32(clamp(floor(fy), 0.0, ny - 1.0));
  let x1 = min(x0 + 1, i32(nx) - 1);
  let y1 = min(y0 + 1, i32(ny) - 1);
  let tx = clamp(fx - f32(x0), 0.0, 1.0);
  let ty = clamp(fy - f32(y0), 0.0, 1.0);
  let sx = 1.0 - tx;
  let sy = 1.0 - ty;
  var a: f32;
  var b: f32;
  var c: f32;
  var d: f32;
  if (field == 0) {
    a = load_u(vec2<i32>(x0, y0));
    b = load_u(vec2<i32>(x1, y0));
    c = load_u(vec2<i32>(x0, y1));
    d = load_u(vec2<i32>(x1, y1));
  } else if (field == 1) {
    a = load_v(vec2<i32>(x0, y0));
    b = load_v(vec2<i32>(x1, y0));
    c = load_v(vec2<i32>(x0, y1));
    d = load_v(vec2<i32>(x1, y1));
  } else {
    a = load_t(vec2<i32>(x0, y0));
    b = load_t(vec2<i32>(x1, y0));
    c = load_t(vec2<i32>(x0, y1));
    d = load_t(vec2<i32>(x1, y1));
  }
  return sx * sy * a + tx * sy * b + sx * ty * c + tx * ty * d;
}

@compute @workgroup_size(8, 8)
fn clear_fields(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  textureStore(uWrite, id, vec4<f32>(0.0));
  textureStore(vWrite, id, vec4<f32>(0.0));
  textureStore(tWrite, id, vec4<f32>(0.0));
  textureStore(pWrite, id, vec4<f32>(0.0));
}

@compute @workgroup_size(8, 8)
fn clear_pressure(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  textureStore(pWrite, id, vec4<f32>(0.0));
}

@compute @workgroup_size(8, 8)
fn jacobi_pressure(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(pWrite, id, vec4<f32>(0.0));
    return;
  }
  if (!interior(id) || open_cell(id) < 0.5) {
    textureStore(pWrite, id, vec4<f32>(0.0));
    return;
  }
  let sx0 = open_cell(id + vec2<i32>(-1, 0));
  let sx1 = open_cell(id + vec2<i32>(1, 0));
  let sy0 = open_cell(id + vec2<i32>(0, -1));
  let sy1 = open_cell(id + vec2<i32>(0, 1));
  let s = sx0 + sx1 + sy0 + sy1;
  if (s == 0.0) {
    textureStore(pWrite, id, vec4<f32>(0.0));
    return;
  }
  let div = load_u(id + vec2<i32>(1, 0)) - load_u(id) + load_v(id + vec2<i32>(0, 1)) - load_v(id);
  let sum_p = load_p(id + vec2<i32>(-1, 0)) * sx0
    + load_p(id + vec2<i32>(1, 0)) * sx1
    + load_p(id + vec2<i32>(0, -1)) * sy0
    + load_p(id + vec2<i32>(0, 1)) * sy1;
  let jacobi = (sum_p - div) / s;
  let next = mix(load_p(id), jacobi, frame.uOverRelax);
  textureStore(pWrite, id, vec4<f32>(next, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn project_velocity(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(uWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  var u = load_u(id);
  var v = load_v(id);
  if (open_cell(id) < 0.5) {
    let vel0 = load_body_vel(id);
    if (vel0.z > 0.5) {
      textureStore(uWrite, id, vec4<f32>(vel0.x, 0.0, 0.0, 0.0));
      textureStore(vWrite, id, vec4<f32>(vel0.y, 0.0, 0.0, 0.0));
    } else {
      textureStore(uWrite, id, vec4<f32>(0.0));
      textureStore(vWrite, id, vec4<f32>(0.0));
    }
    return;
  }
  let p = load_p(id);
  if (id.x > 0 && open_cell(id + vec2<i32>(-1, 0)) > 0.5) {
    u -= (p - load_p(id + vec2<i32>(-1, 0)));
  }
  if (id.y > 0 && open_cell(id + vec2<i32>(0, -1)) > 0.5) {
    v -= (p - load_p(id + vec2<i32>(0, -1)));
  }
  textureStore(uWrite, id, vec4<f32>(u, 0.0, 0.0, 0.0));
  textureStore(vWrite, id, vec4<f32>(v, 0.0, 0.0, 0.0));
}


@compute @workgroup_size(8, 8)
fn advect_velocity(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(uWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  let h = cell_h();
  let i = id.x;
  let j = id.y;
  var nu = load_u(id);
  var nv = load_v(id);
  if (open_cell(id) > 0.5 && open_cell(id + vec2<i32>(-1, 0)) > 0.5 && j < i32(frame.texH) - 1) {
    let u = load_u(id);
    let vv = 0.25 * (
      load_v(id + vec2<i32>(-1, 0)) + load_v(id) +
      load_v(id + vec2<i32>(-1, 1)) + load_v(id + vec2<i32>(0, 1))
    );
    let x = f32(i) * h - frame.dt * u;
    let y = f32(j) * h + 0.5 * h - frame.dt * vv;
    nu = sample_bilinear(0, x, y);
  }
  if (open_cell(id) > 0.5 && open_cell(id + vec2<i32>(0, -1)) > 0.5 && i < i32(frame.texW) - 1) {
    let uu = 0.25 * (
      load_u(id + vec2<i32>(0, -1)) + load_u(id) +
      load_u(id + vec2<i32>(1, -1)) + load_u(id + vec2<i32>(1, 0))
    );
    let v = load_v(id);
    let x = f32(i) * h + 0.5 * h - frame.dt * uu;
    let y = f32(j) * h - frame.dt * v;
    nv = sample_bilinear(1, x, y);
  }
  textureStore(uWrite, id, vec4<f32>(nu, 0.0, 0.0, 0.0));
  textureStore(vWrite, id, vec4<f32>(nv, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn advect_temperature(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(tWrite, id, vec4<f32>(0.0));
    return;
  }
  if (!interior(id) || open_cell(id) < 0.5) {
    textureStore(tWrite, id, vec4<f32>(0.0));
    return;
  }
  let h = cell_h();
  let u = 0.5 * (load_u(id) + load_u(id + vec2<i32>(1, 0)));
  let v = 0.5 * (load_v(id) + load_v(id + vec2<i32>(0, 1)));
  let x = f32(id.x) * h + 0.5 * h - frame.dt * u;
  let y = f32(id.y) * h + 0.5 * h - frame.dt * v;
  textureStore(tWrite, id, vec4<f32>(sample_bilinear(2, x, y), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn cool_rise(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(tWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  var t = load_t(id);
  var v = load_v(id);
  if (open_cell(id) < 0.5) {
    textureStore(tWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  let cool = select(frame.uFireCool, frame.uSmokeCool, t < frame.uSmokeSplit) * frame.dt;
  t = max(t - cool, 0.0);
  let accel = 6.0 * frame.dt;
  v += (t * frame.uRise - v) * accel;
  textureStore(tWrite, id, vec4<f32>(t, 0.0, 0.0, 0.0));
  textureStore(vWrite, id, vec4<f32>(v, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn apply_swirls(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(uWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  var u = load_u(id);
  var v = load_v(id);
  let h = cell_h();
  let count = i32(frame.uMaxSwirls);
  let force = max(0.0, frame.uSwirlForce);
  if (count <= 0 || force <= 0.0) {
    textureStore(uWrite, id, vec4<f32>(u, 0.0, 0.0, 0.0));
    textureStore(vWrite, id, vec4<f32>(v, 0.0, 0.0, 0.0));
    return;
  }
  let vx = f32(id.x) * h;
  let vy = (f32(id.y) + 0.5) * h;
  let hx = (f32(id.x) + 0.5) * h;
  let hy = f32(id.y) * h;
  for (var n = 0; n < count; n++) {
    let s = swirls[n];
    if (s.life <= 0.0 || s.radius <= 0.0) { continue; }
    let r0 = vx - s.x;
    let r1 = vy - s.y;
    let ru = sqrt(r0 * r0 + r1 * r1);
    if (ru < s.radius && s.radius > 0.0) {
      var w = 1.0;
      if (ru > 0.7 * s.radius) {
        w = max(0.0, (s.radius - ru) / (0.3 * s.radius));
      }
      let aim_u = -r1 * s.omega;
      u += (aim_u - u) * (w * force);
    }

    let q0 = hx - s.x;
    let q1 = hy - s.y;
    let rv = sqrt(q0 * q0 + q1 * q1);
    if (rv < s.radius && s.radius > 0.0) {
      var w = 1.0;
      if (rv > 0.7 * s.radius) {
        w = max(0.0, (s.radius - rv) / (0.3 * s.radius));
      }
      let aim_v = q0 * s.omega;
      v += (aim_v - v) * (w * force);
    }
  }
  textureStore(uWrite, id, vec4<f32>(u, 0.0, 0.0, 0.0));
  textureStore(vWrite, id, vec4<f32>(v, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn apply_stamp(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(tWrite, id, vec4<f32>(0.0));
    return;
  }
  let mark = textureLoad(stampTex, id, 0);
  var t = load_t(id);
  if (mark.r < 0.5) {
    t = mark.b;
  } else if (mark.g > 0.5) {
    t = 1.0;
  }
  textureStore(tWrite, id, vec4<f32>(t, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn apply_body_vel(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(uWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  let vel0 = load_body_vel(id);
  if (open_cell(id) < 0.5 && vel0.z < 0.5) {
    textureStore(uWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  var u = load_u(id);
  var v = load_v(id);
  let velL = load_body_vel(id + vec2<i32>(-1, 0));
  let velR = load_body_vel(id + vec2<i32>(1, 0));
  let velD = load_body_vel(id + vec2<i32>(0, -1));
  let velU = load_body_vel(id + vec2<i32>(0, 1));
  let k = clamp(frame.uBodyDrive, 0.0, 1.0);
  if (vel0.z > 0.5) {
    u = mix(u, vel0.x, k);
    v = mix(v, vel0.y, k);
  } else {
    if (velL.z > 0.5) { u = mix(u, velL.x, k); }
    if (velR.z > 0.5) { u = mix(u, velR.x, k); }
    if (velD.z > 0.5) { v = mix(v, velD.y, k); }
    if (velU.z > 0.5) { v = mix(v, velU.y, k); }
  }
  textureStore(uWrite, id, vec4<f32>(u, 0.0, 0.0, 0.0));
  textureStore(vWrite, id, vec4<f32>(v, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn push_from_solid(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(uWrite, id, vec4<f32>(0.0));
    textureStore(vWrite, id, vec4<f32>(0.0));
    return;
  }
  var u = load_u(id);
  var v = load_v(id);
  let push = max(frame.uSolidPush, 0.0);
  let t = load_t(id);
  if (open_cell(id) > 0.5 && push > 0.0 && t > 0.0) {
    var nx = 0.0;
    var ny = 0.0;
    if (inert_solid(id + vec2<i32>(-1, 0))) { nx += 1.0; }
    if (inert_solid(id + vec2<i32>(1, 0))) { nx -= 1.0; }
    if (inert_solid(id + vec2<i32>(0, -1))) { ny += 1.0; }
    if (inert_solid(id + vec2<i32>(0, 1))) { ny -= 1.0; }
    let len = sqrt(nx * nx + ny * ny);
    if (len > 1e-4) {
      let k = push * frame.dt / len;
      u += nx * k;
      v += ny * k;
    }
  }
  textureStore(uWrite, id, vec4<f32>(u, 0.0, 0.0, 0.0));
  textureStore(vWrite, id, vec4<f32>(v, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn diffuse_temperature(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (!in_grid(id)) { return; }
  if (!cell_active(id)) {
    textureStore(tWrite, id, vec4<f32>(0.0));
    return;
  }
  let t = load_t(id);
  if (!interior(id) || frame.uDiffusion <= 0.0) {
    textureStore(tWrite, id, vec4<f32>(t, 0.0, 0.0, 0.0));
    return;
  }
  let wL = open_cell(id + vec2<i32>(-1, 0));
  let wR = open_cell(id + vec2<i32>(1, 0));
  let wD = open_cell(id + vec2<i32>(0, -1));
  let wU = open_cell(id + vec2<i32>(0, 1));
  let wSum = wL + wR + wD + wU;
  if (wSum <= 0.0) {
    textureStore(tWrite, id, vec4<f32>(t, 0.0, 0.0, 0.0));
    return;
  }
  let avg = (
    load_t(id + vec2<i32>(-1, 0)) * wL + load_t(id + vec2<i32>(1, 0)) * wR +
    load_t(id + vec2<i32>(0, -1)) * wD + load_t(id + vec2<i32>(0, 1)) * wU
  ) / wSum;
  if (t <= 0.0 && avg <= 0.0) {
    textureStore(tWrite, id, vec4<f32>(0.0));
    return;
  }
  let a = min(1.0, frame.uDiffusion);
  textureStore(tWrite, id, vec4<f32>(t * (1.0 - a) + avg * a, 0.0, 0.0, 0.0));
}

fn hash11(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453123);
}

fn swirl_bound(s: Body) -> f32 {
  let kind = i32(s.shapeKind + 0.5);
  if (kind == 0 || kind == 2) {
    return length(vec2<f32>(s.halfW, s.halfH));
  }
  return s.halfW;
}

fn shape_burning(s: Body) -> bool {
  let flags = i32(s.flags);
  return (flags & 1) != 0 && (flags & 2) == 0 && (flags & 4) == 0;
}

@compute @workgroup_size(64)
fn step_swirls(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = i32(gid.x);
  let cap = i32(arrayLength(&swirls));
  if (i >= cap) { return; }
  let maxN = i32(frame.uMaxSwirls);
  if (i >= maxN || frame.uSwirlLife <= 0.0 || frame.uSwirlChance <= 0.0) {
    swirls[i] = Swirl(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    return;
  }

  var s = swirls[i];
  let dt = frame.dt;
  let damp = max(0.0, 1.0 - frame.uSwirlDamp * dt);
  if (s.life > 0.0) {
    s.life -= dt;
    s.vx *= damp;
    s.omega *= damp;
    s.y += frame.uRise * 0.35 * dt;
    s.x += s.vx * dt;
    if (s.life <= 0.0 || abs(s.omega) < 0.5) {
      s.life = 0.0;
      s.radius = 0.0;
    }
  }

  if (s.life <= 0.0) {
    var nBurn = 0;
    let nShapes = i32(frame.shapeCount);
    for (var k = 0; k < nShapes; k++) {
      if (shape_burning(shapes[k])) { nBurn++; }
    }
    if (nBurn > 0) {
      let pick = min(i32(floor(hash11(f32(i) * 19.7 + frame.time * 3.1) * f32(nBurn))), nBurn - 1);
      var seen = 0;
      var body: Body;
      var found = false;
      for (var k = 0; k < nShapes; k++) {
        if (shape_burning(shapes[k])) {
          if (seen == pick) {
            body = shapes[k];
            found = true;
            break;
          }
          seen++;
        }
      }
      if (found) {
        let bound = max(swirl_bound(body), cell_h());
        let p = min(1.0, frame.uSwirlChance * bound * cell_h() * 8.0);
        let pSlot = p * f32(nBurn) / max(frame.uMaxSwirls, 1.0);
        let roll = hash11(f32(i) * 91.7 + frame.time * 8.3);
        if (roll < pSlot) {
          let ang = hash11(f32(i) * 4.1 + frame.time * 1.9) * 6.2831853;
          let rad = bound * (0.8 + 0.3 * hash11(f32(i) * 11.3 + frame.time * 2.7));
          let spinSign = select(-1.0, 1.0, hash11(f32(i) * 2.3 + frame.time) < 0.5);
          // World-fixed grid: swirl position is a true world position, no origin offset.
          s.x = body.posX + cos(ang) * rad;
          s.y = body.posY + sin(ang) * rad;
          s.vx = (-0.5 + hash11(f32(i) * 6.6 + frame.time * 5.2)) * 0.4;
          s.omega = spinSign * frame.uSwirlSpin * (0.8 + 0.4 * hash11(f32(i) * 3.9 + frame.time * 4.4));
          s.radius = max(cell_h() * frame.uSwirlRadius, 0.12);
          s.life = frame.uSwirlLife * (0.4 + hash11(f32(i) * 7.2 + frame.time * 6.1));
        }
      }
    }
  }
  swirls[i] = s;
}
