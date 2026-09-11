// Engine prelude provides: struct FrameData + var<uniform> frame, struct Body.

@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> verts: array<vec2<f32>>;
@group(1) @binding(0) var stampWrite: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(1) var velWrite: texture_storage_2d<rgba32float, write>;

fn cell_h() -> f32 {
  return max(frame.uCellSize, 1e-6);
}

fn lattice_origin_axis(cam: f32, view: f32, extent: f32, h: f32, padCells: f32) -> f32 {
  let minO = cam + view - extent;
  let kMin = ceil(minO / h);
  let kMax = floor(cam / h);
  if (kMin > kMax) {
    return kMin * h;
  }
  let want = cam - max(padCells, 0.0) * h;
  return clamp(floor(want / h), kMin, kMax) * h;
}

fn lattice_origin() -> vec2<f32> {
  let h = cell_h();
  let view = vec2<f32>(frame.canvasW, frame.canvasH) / max(frame.zoom, 1e-6);
  let extent = vec2<f32>(frame.texW, frame.texH) * h;
  return vec2<f32>(
    lattice_origin_axis(frame.cameraX, view.x, extent.x, h, frame.uLatticePad),
    lattice_origin_axis(frame.cameraY, view.y, extent.y, h, frame.uLatticePad)
  );
}

fn sdBox(p: vec2<f32>, b: vec2<f32>) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sdConvexPoly(p: vec2<f32>, start: i32, n: i32) -> f32 {
  if (n < 3) { return 1000.0; }
  var d2 = 1e9;
  var inside = 1.0;
  for (var i = 0; i < n; i++) {
    let a = verts[start + i];
    let b = verts[start + ((i + 1) % n)];
    let e = b - a;
    let w = p - a;
    let el2 = max(dot(e, e), 1e-8);
    let we = w - e * clamp(dot(w, e) / el2, 0.0, 1.0);
    d2 = min(d2, dot(we, we));
    if (e.x * w.y - e.y * w.x < 0.0) {
      inside = 0.0;
    }
  }
  let s = select(1.0, -1.0, inside > 0.5);
  return s * sqrt(d2);
}

@compute @workgroup_size(8, 8)
fn raster_stamp(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = vec2<i32>(i32(gid.x), i32(gid.y));
  if (id.x >= i32(frame.texW) || id.y >= i32(frame.texH)) { return; }

  let h = cell_h();
  let origin = lattice_origin();
  let wx = (f32(id.x) + 0.5) * h + origin.x;
  let wy = (f32(id.y) + 0.5) * h + origin.y;

  var openCell = 1.0;
  var isSource = 0.0;
  var maxEmber = 0.0;
  var bodyVx = 0.0;
  var bodyVy = 0.0;
  var hasBody = 0.0;
  let count = i32(frame.shapeCount);

  for (var i = 0; i < count; i++) {
    let s = bodies[i];
    let dx = wx - s.posX;
    let dy = wy - s.posY;
    let lx = s.cosA * dx + s.sinA * dy;
    let ly = -s.sinA * dx + s.cosA * dy;
    let p = vec2<f32>(lx, ly);

    var d = 1000.0;
    var depth = 0.0;
    var size = s.halfW;

    let kind = i32(s.shapeKind + 0.5);
    if (kind == 0) {
      d = sdBox(p, vec2<f32>(s.halfW, s.halfH));
      size = min(s.halfW, s.halfH);
      if (s.halfW > 0.0 && s.halfH > 0.0) {
        depth = clamp(1.0 - max(abs(lx) / s.halfW, abs(ly) / s.halfH), 0.0, 1.0);
      }
    } else if (kind == 1) {
      d = length(p) - s.halfW;
      if (s.halfW > 0.0) {
        depth = clamp(1.0 - length(p) / s.halfW, 0.0, 1.0);
      }
    } else if (kind == 2) {
      let n = i32(s.vertCount);
      let start = i32(s.vertStart);
      d = sdConvexPoly(p, start, n);
      size = max(s.halfW, s.halfH);
      if (size > 0.0) {
        depth = clamp(1.0 + d / size, 0.0, 1.0);
      }
    }

    let isBurning = (i32(s.flags) & 1) != 0;
    let isStatic = (i32(s.flags) & 2) != 0;
    let isSweep = (i32(s.flags) & 4) != 0;
    let pad = frame.uSourcePad;
    let band = max(0.0, max(2.0 * h, 0.15 * max(size, 0.0)) + pad);
    let skin = frame.uStampPad * h;

    if (d <= skin) {
      if (isStatic) {
        openCell = 0.0;
        hasBody = 0.0;
        bodyVx = 0.0;
        bodyVy = 0.0;
      } else {
        hasBody = 1.0;
        let dt = max(frame.dt, 1e-6);
        let vx = (s.posX - s.prevX) / dt;
        let vy = (s.posY - s.prevY) / dt;
        bodyVx = vx - s.omega * (wy - s.posY);
        bodyVy = vy + s.omega * (wx - s.posX);
        if (!isSweep && (!isBurning || d < -band)) {
          openCell = 0.0;
        }
      }
    }
    if (d <= 0.0 && isBurning && !isStatic && !isSweep && frame.uEmberOn > 0.5) {
      let n = fract(abs(sin(f32(id.x) * 12.9898 + f32(id.y) * 78.233) * 43758.5453));
      let flick = 0.84 + 0.16 * sin(frame.time * 9.0 + f32(id.x) * 1.7 + f32(id.y) * 2.3);
      let heat = clamp((0.7 + 0.3 * n) * (0.85 + 0.15 * depth) * flick, 0.0, 1.0);
      maxEmber = max(maxEmber, heat);
    }
    if (isBurning && !isStatic && d <= h + pad) {
      isSource = 1.0;
    }
  }
  if (openCell < 0.5) {
    isSource = 0.0;
  }

  textureStore(stampWrite, id, vec4<f32>(openCell, isSource, maxEmber, 1.0));
  textureStore(velWrite, id, vec4<f32>(bodyVx, bodyVy, hasBody, 1.0));
}
