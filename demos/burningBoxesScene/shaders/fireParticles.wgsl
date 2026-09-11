// Engine prelude provides: struct FrameData + var<uniform> frame, struct LfParticle.

@group(0) @binding(1) var<storage, read> particles: array<LfParticle>;
@group(1) @binding(0) var fuelWrite: texture_storage_2d<rgba32float, write>;

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

@compute @workgroup_size(64)
fn raster_particles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = i32(gid.x);
  let n = i32(frame.particleCount);
  if (i >= n) { return; }
  let heat = clamp(frame.uLfHeat, 0.0, 1.0);
  if (heat <= 0.0) { return; }
  let p = particles[i];
  let h = cell_h();
  let r = max(frame.uLfRadius, h);
  let reach = i32(ceil(r / h));
  let cx = i32(floor(p.x / h));
  let cy = i32(floor(p.y / h));
  for (var oy = -reach; oy <= reach; oy++) {
    for (var ox = -reach; ox <= reach; ox++) {
      let id = vec2<i32>(cx + ox, cy + oy);
      if (!in_grid(id) || !cell_active(id)) { continue; }
      let wpos = (vec2<f32>(id) + vec2<f32>(0.5)) * h;
      let dx = wpos.x - p.x;
      let dy = wpos.y - p.y;
      if (dx * dx + dy * dy > r * r) { continue; }
      textureStore(fuelWrite, id, vec4<f32>(heat, p.vx, p.vy, 1.0));
    }
  }
}
