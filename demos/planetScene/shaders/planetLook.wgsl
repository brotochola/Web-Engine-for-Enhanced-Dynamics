// Engine prelude provides GlobalUniforms, LocalUniforms, CustomUniforms,
// VertexOut.vWorld, and the cells texture. This file does not rebuild the camera.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let cp = in.vWorld / customUniforms.uCell;
  let cpp = max(length(dpdx(cp)), 1e-6);
  let q = cp - 0.5;
  let b0 = vec2<i32>(floor(q));
  let f = q - vec2<f32>(b0);
  let a = cellAt(b0);
  let b = cellAt(b0 + vec2<i32>(1, 0));
  let c = cellAt(b0 + vec2<i32>(0, 1));
  let d = cellAt(b0 + vec2<i32>(1, 1));
  let n = a + b + c + d;
  let K = 0.70710678;
  var s: f32;
  if (n == 0) { s = -1.0; }
  else if (n == 4) { s = 1.0; }
  else if (n == 1) {
    var t: f32;
    if (a == 1) { t = f.x + f.y; }
    else if (b == 1) { t = (1.0 - f.x) + f.y; }
    else if (c == 1) { t = f.x + (1.0 - f.y); }
    else { t = (1.0 - f.x) + (1.0 - f.y); }
    s = (0.5 - t) * K;
  } else if (n == 3) {
    var t: f32;
    if (a == 0) { t = f.x + f.y; }
    else if (b == 0) { t = (1.0 - f.x) + f.y; }
    else if (c == 0) { t = f.x + (1.0 - f.y); }
    else { t = (1.0 - f.x) + (1.0 - f.y); }
    s = (t - 0.5) * K;
  } else if (a == b) {
    s = select(f.y - 0.5, 0.5 - f.y, a == 1);
  } else if (a == c) {
    s = select(f.x - 0.5, 0.5 - f.x, a == 1);
  } else {
    var t1: f32;
    var t2: f32;
    if (a == 1) {
      t1 = (1.0 - f.x) + f.y;
      t2 = f.x + (1.0 - f.y);
    } else {
      t1 = f.x + f.y;
      t2 = (1.0 - f.x) + (1.0 - f.y);
    }
    s = min(t1 - 0.5, t2 - 0.5) * K;
  }
  let ep = s / cpp;
  let alpha = clamp(ep + 0.5, 0.0, 1.0);
  if (alpha <= 0.0) { discard; }
  let id = floor(cp);
  let nz = hash2(id);
  let pc = vec2<f32>(customUniforms.uPCX, customUniforms.uPCY);
  let depth = customUniforms.uPR - length(id + 0.5 - pc) + (nz - 0.5) * 3.0;
  var col: vec3<f32>;
  if (depth < 5.0) { col = vec3<f32>(0.42, 0.62, 0.28); }
  else if (depth < 26.0) { col = vec3<f32>(0.48, 0.34, 0.21); }
  else { col = vec3<f32>(0.40, 0.42, 0.47); }
  col = col * (0.9 + 0.1 * nz);
  col = col * mix(0.68, 1.0, smoothstep(0.0, 2.5, ep));
  return vec4<f32>(col * alpha, alpha);
}

fn cellAt(p: vec2<i32>) -> i32 {
  let gw = i32(customUniforms.uGW);
  if (p.x < 0 || p.y < 0 || p.x >= gw || p.y >= gw) { return 0; }
  let texel = textureLoad(cells, vec2<i32>(p.x >> 3, p.y), 0);
  let b = i32(texel.r * 255.0 + 0.5);
  return (b >> u32(p.x & 7)) & 1;
}

fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}
