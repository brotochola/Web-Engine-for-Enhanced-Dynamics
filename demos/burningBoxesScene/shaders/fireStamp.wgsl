// Engine prelude provides: struct FrameData + var<uniform> frame, struct Body.

@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> verts: array<vec2<f32>>;
@group(1) @binding(0) var stampWrite: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(1) var velWrite: texture_storage_2d<rgba32float, write>;
@group(1) @binding(2) var fuelWrite: texture_storage_2d<rgba32float, write>;

// World-fixed lattice (see fireFluid.wgsl): texel (i,j) = world cell (i,j),
// origin always (0,0). WGSL doesn't share code across files, so cell_h/
// cell_active are redefined here to match fireFluid.wgsl exactly.
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
  if (!cell_active(id)) {
    textureStore(stampWrite, id, vec4<f32>(1.0, 0.0, 0.0, 0.0));
    textureStore(velWrite, id, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    textureStore(fuelWrite, id, vec4<f32>(0.0));
    return;
  }

  let h = cell_h();
  let wx = (f32(id.x) + 0.5) * h;
  let wy = (f32(id.y) + 0.5) * h;

  var openCell = 1.0;
  var isSource = 0.0;
  var maxEmber = 0.0;
  var burnSolid = 0.0;
  var bodyVx = 0.0;
  var bodyVy = 0.0;
  var hasBody = 0.0;
  // vel.w: 0 none, 1 = rigid wall, 2 = forced wind (blow/jet).
  var velKind = 0.0;
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
    let isBlow = (i32(s.flags) & 8) != 0;
    let isJet = (i32(s.flags) & 16) != 0;
    let inner = max(frame.uStampInner, 0.0) * h;
    let outer = frame.uStampOuter * h;
    let skin = frame.uStampPad * h;

    if (isBlow && !isSweep) {
      let reach = max(frame.uBlowReach, 0.0) * h;
      if (lx > s.halfW && lx < s.halfW + reach && abs(ly) < s.halfH) {
        let force = frame.uBlowForce;
        bodyVx = s.cosA * force;
        bodyVy = s.sinA * force;
        hasBody = 1.0;
        velKind = 2.0;
      }
    }

    if (d <= skin && !isBlow) {
      if (isStatic) {
        openCell = 0.0;
        hasBody = 0.0;
        bodyVx = 0.0;
        bodyVy = 0.0;
        velKind = 0.0;
      } else {
        hasBody = 1.0;
        velKind = 1.0;
        bodyVx = s.velX - s.omega * (wy - s.posY);
        bodyVy = s.velY + s.omega * (wx - s.posX);
        if (!isSweep && (!isBurning || d <= -inner)) {
          openCell = 0.0;
        }
        if (isBurning) {
          burnSolid = 1.0;
        }
      }
    }
    let emberSkin = frame.uEmberPad * h;
    if (d <= emberSkin && isBurning && !isStatic && !isSweep && frame.uEmberOn > 0.5) {
      let n = fract(abs(sin(f32(id.x) * 12.9898 + f32(id.y) * 78.233) * 43758.5453));
      let flickAmt = clamp(frame.uEmberFlick, 0.0, 1.0);
      let flick = mix(1.0, 0.84 + 0.16 * sin(frame.time * 9.0 + f32(id.x) * 1.7 + f32(id.y) * 2.3), flickAmt);
      let bright = clamp(frame.uEmberBright, 0.0, 1.0);
      let heat = clamp(bright * (0.75 + 0.25 * n) * (0.7 + 0.3 * depth) * flick, 0.0, 1.0);
      maxEmber = max(maxEmber, heat);
    }
    if (isJet && isBurning && !isStatic && !isSweep) {
      if (lx > s.halfW - h && lx < s.halfW + max(outer, h) && abs(ly) < s.halfH) {
        isSource = 1.0;
        hasBody = 1.0;
        velKind = 2.0;
        let force = frame.uJetForce;
        bodyVx = s.cosA * force;
        bodyVy = s.sinA * force;
      }
    } else if (isBurning && !isStatic && !isSweep && d <= outer) {
      isSource = 1.0;
    }
  }
  if (openCell < 0.5) {
    isSource = 0.0;
  }

  textureStore(stampWrite, id, vec4<f32>(openCell, isSource, maxEmber, burnSolid));
  textureStore(velWrite, id, vec4<f32>(bodyVx, bodyVy, hasBody, velKind));
  textureStore(fuelWrite, id, vec4<f32>(0.0));
}
