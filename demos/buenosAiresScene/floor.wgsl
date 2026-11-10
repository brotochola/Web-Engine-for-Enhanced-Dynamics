// The barrio's floor for WebGPU: floor.frag line by line, the same algorithm and the same numbers (buenos-aires'
// shaders/piso.frag, the algorithm of its editor's ground.js). The engine's prelude declares the uniforms (customUniforms)
// and the pictures: cellA, cellB (0.5 m cells with up to 3 candidate streets, the sidewalk and yard kind), wealth (10 m cells),
// noiseT (three noises and a grain), segs (12 texels a street: 24 values of 16 bits) and pits (tree pits in 2 m cells).

var<private> PXM: f32 = 0.055;

fn b8(v: f32) -> i32 { return i32(v * 255.0 + 0.5); }
fn noiseAt(x: i32, y: i32) -> vec4f { return textureLoad(noiseT, vec2<i32>(x & 255, y & 255), 0); }
fn NA(x: i32, y: i32) -> f32 { return noiseAt(x, y).r; }
fn NB(x: i32, y: i32) -> f32 { return noiseAt(x, y).g; }
fn NC(x: i32, y: i32) -> f32 { return noiseAt(x, y).b; }
fn NG(x: i32, y: i32) -> f32 { return noiseAt(x, y).a; }
fn hash2(a: i32, b: i32) -> f32 {
  var h = (u32(a) * 374761393u) ^ (u32(b) * 668265263u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) / 4294967296.0;
}
fn fmod_(a: f32, m: f32) -> f32 { return a - m * floor(a / m); }

fn ramp5(c0: vec3f, c1: vec3f, c2: vec3f, c3: vec3f, c4: vec3f, t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 0.999) * 4.0;
  let i = i32(t);
  let f = t - f32(i);
  if (i == 0) { return mix(c0, c1, f); }
  if (i == 1) { return mix(c1, c2, f); }
  if (i == 2) { return mix(c2, c3, f); }
  return mix(c3, c4, f);
}
fn asphalt(ix: i32, iy: i32) -> vec3f {
  let v = 0.86 + 0.3 * (NC(ix >> 2u, iy >> 2u) - 0.5) + 0.16 * (NA(ix, iy) - 0.5) + 0.14 * (NG(ix, iy) - 0.5);
  if (NG(ix * 7, iy * 3) > 0.95) { return vec3f(118.0, 116.0, 112.0); }
  return vec3f(70.0, 71.0, 76.0) * v;
}
fn junta(x: f32, j: f32, w0: f32) -> f32 {
  let w = max(w0, 1e-4);
  let a = x - w * 0.5;
  let b = x + w * 0.5;
  return clamp((floor(b) * j + min(fract(b), j) - floor(a) * j - min(fract(a), j)) / w, 0.0, 1.0);
}
fn juntas(cu: f32, cv: f32) -> f32 { return 1.0 - (1.0 - cu) * (1.0 - cv); }
fn adoquin(u: f32, v: f32, ix: i32, iy: i32) -> vec3f {
  let bw = 0.3;
  let bh = 0.2;
  let row = floor(v / bh);
  let uu = u + fmod_(row, 2.0) * bw * 0.5;
  let cu = floor(uu / bw);
  let lu = uu / bw - cu;
  let lv = v / bh - row;
  let h = hash2(i32(cu) * 13 + 5, i32(row) * 7 + 11);
  let cj = juntas(junta(uu / bw, 0.13, PXM / bw), junta(v / bh, 0.17, PXM / bh));
  let f = (1.0 + (0.5 - lv) * 0.14 - (lu - 0.5) * 0.06) * (0.94 + 0.1 * NA(ix, iy));
  return mix(vec3f(96.0 + 36.0 * h, 98.0 + 30.0 * h, 104.0 + 18.0 * h) * f, vec3f(58.0, 56.0, 54.0) * (0.9 + 0.2 * NG(ix, iy)), cj);
}
fn grass(ix: i32, iy: i32, dry: f32) -> vec3f {
  let t = 0.45 + (NA(ix, iy) - 0.5) * 0.7 + (NB(ix, iy) - 0.5) * 0.3 + (NG(ix, iy) - 0.5) * 0.35;
  var c = ramp5(vec3f(46.0, 80.0, 40.0), vec3f(62.0, 102.0, 48.0), vec3f(80.0, 126.0, 58.0), vec3f(102.0, 150.0, 70.0), vec3f(132.0, 174.0, 86.0), t);
  if (dry > 0.0) {
    let d = clamp((NC(ix, iy) - 0.55) * 3.0, 0.0, 1.0) * dry;
    c = vec3f(c.r + (150.0 - c.r) * d, c.g + (140.0 - c.g) * d * 0.6, c.b + (80.0 - c.b) * d);
  }
  if (NG(ix * 3, iy * 5) > 0.965) { return vec3f(176.0, 204.0, 120.0); }
  return c;
}
fn dirt(ix: i32, iy: i32) -> vec3f {
  let t = 0.5 + (NA(ix, iy) - 0.5) * 0.5 + (NB(ix, iy) - 0.5) * 0.3 + (NG(ix, iy) - 0.5) * 0.2;
  let g = NG(ix * 5, iy * 7);
  if (g > 0.97) { return vec3f(196.0, 184.0, 160.0); }
  if (g < 0.015) { return vec3f(72.0, 56.0, 44.0); }
  return ramp5(vec3f(96.0, 72.0, 52.0), vec3f(118.0, 88.0, 62.0), vec3f(140.0, 106.0, 76.0), vec3f(160.0, 126.0, 90.0), vec3f(182.0, 150.0, 112.0), t);
}
// What a pixel is: a colour, or a surface that paint() draws at the end, each surface at one place only (floor.frag says why).
const M_RGB: i32 = 0;
const M_GRASS: i32 = 1;
const M_DIRT: i32 = 2;
const M_ASPHALT: i32 = 3;
const M_ADOQUIN: i32 = 4;
const M_TILES: i32 = 5;
const M_NONE: i32 = 6;
struct Mat { m: i32, rgb: vec3f, dry: f32, mul: f32, uv: vec2f, kind: i32, dmg: bool }
fn rgbM(c: vec3f) -> Mat { return Mat(M_RGB, c, 0.0, 1.0, vec2f(0.0), 0, false); }
fn grassM(dry: f32) -> Mat { return Mat(M_GRASS, vec3f(0.0), dry, 1.0, vec2f(0.0), 0, false); }
fn dirtM(mul: f32) -> Mat { return Mat(M_DIRT, vec3f(0.0), 0.0, mul, vec2f(0.0), 0, false); }
fn asphaltM(mul: f32) -> Mat { return Mat(M_ASPHALT, vec3f(0.0), 0.0, mul, vec2f(0.0), 0, false); }
fn adoquinM(u: f32, v: f32, mul: f32) -> Mat { return Mat(M_ADOQUIN, vec3f(0.0), 0.0, mul, vec2f(u, v), 0, false); }
fn tilesM(u: f32, v: f32, kind: i32, dmg: bool) -> Mat { return Mat(M_TILES, vec3f(0.0), 0.0, 1.0, vec2f(u, v), kind, dmg); }
fn noneM() -> Mat { return Mat(M_NONE, vec3f(0.0), 0.0, 1.0, vec2f(0.0), 0, false); }
fn yuyoM(ix: i32, iy: i32) -> Mat {
  if (NC(ix, iy) > 0.6) { return dirtM(1.0); }
  return grassM(0.8);
}
// The first tree pit (x, then y, over the 3 × 3 cells around) that holds the point decides, after the loop.
fn cazuelaM(wx: f32, wy: f32, ix: i32, iy: i32) -> Mat {
  let gx = i32(floor(wx / 2.0));
  let gy = i32(floor(wy / 2.0));
  var edge = 0.0;
  var tp = 0;
  for (var i = 0; i < 9; i++) {
    let x = gx - 1 + i / 3;
    let y = gy - 1 + i % 3;
    if (x < 0 || y < 0 || x >= i32(customUniforms.uPW) || y >= i32(customUniforms.uPH)) { continue; }
    let q = textureLoad(pits, vec2<i32>(x, y), 0);
    let t = b8(q.a);
    if (t == 0) { continue; }
    let c = vec2f(f32(x) * 2.0 + q.r * 2.0, f32(y) * 2.0 + q.g * 2.0);
    let a = q.b * 6.2831853 * 255.0 / 256.0;
    let d = vec2f(wx, wy) - c;
    let cs = cos(a);
    let sn = sin(a);
    let lx = d.x * cs + d.y * sn;
    let ly = -d.x * sn + d.y * cs;
    if (abs(lx) >= 0.7 || abs(ly) >= 0.7) { continue; }
    edge = 0.7 - max(abs(lx), abs(ly));
    tp = t;
    break;
  }
  if (tp == 0) { return noneM(); }
  let t = tp & 3;
  if (edge < 0.11 && t == 1) { return rgbM(vec3f(150.0, 74.0, 52.0) * (0.9 + 0.15 * NG(ix, iy))); }
  if (edge < 0.11 && t == 2) { return rgbM(vec3f(172.0, 170.0, 162.0) * (0.92 + 0.1 * NG(ix, iy))); }
  if (edge < 0.18) { return dirtM(0.72); }
  if ((tp & 4) != 0 && NB(ix * 2, iy * 2) > 0.5) { return grassM(0.6); }
  return dirtM(1.0);
}

fn wealthAt(x: f32, y: f32) -> f32 {
  let p = vec2<i32>(clamp(i32(x / 10.0), 0, i32(customUniforms.uWG) - 1), clamp(i32(y / 10.0), 0, i32(customUniforms.uHG) - 1));
  return textureLoad(wealth, p, 0).r;
}

// The sidewalk's and the yard's kind by a vote over the 4 x 4 cells around the pixel (floor.frag says why).
fn smoothKinds(wx: f32, wy: f32) -> vec2<i32> {
  let U = customUniforms;
  let g = vec2f(wx, wy) / U.uGC - 0.5;
  let c0 = vec2<i32>(floor(g));
  let f = g - vec2f(c0);
  let hi = vec2<i32>(i32(U.uCW) - 1, i32(U.uCH) - 1);
  var kb = vec4<i32>(0);
  var ka = vec4<i32>(0);
  for (var c = 0; c < 4; c++) {
    let t = textureLoad(cellB, clamp(c0 + vec2<i32>(c & 1, c >> 1u), vec2<i32>(0), hi), 0);
    kb[c] = b8(t.b);
    ka[c] = b8(t.a);
  }
  var sb = vec4f(0.0);
  var sa = vec4f(0.0);
  for (var n = 0; n < 16; n++) {
    let i = (n & 3) - 1;
    let j = (n >> 2u) - 1;
    let t = textureLoad(cellB, clamp(c0 + vec2<i32>(i, j), vec2<i32>(0), hi), 0);
    let b = b8(t.b);
    let a = b8(t.a);
    let w = max(0.0, 1.5 - abs(f32(i) - f.x)) * max(0.0, 1.5 - abs(f32(j) - f.y));
    if (b != 0) { sb += w * select(vec4f(0.0), vec4f(1.0), kb == vec4<i32>(b)); }
    sa += w * select(vec4f(0.0), vec4f(1.0), ka == vec4<i32>(a));
  }
  var bestB = 0;
  var bestA = ka.x;
  var vb = 0.0;
  var va = sa.x;
  for (var c = 0; c < 4; c++) {
    if (sb[c] > vb) { vb = sb[c]; bestB = kb[c]; }
    if (sa[c] > va) { va = sa[c]; bestA = ka[c]; }
  }
  return vec2<i32>(bestB, bestA);
}
struct Seg { a: vec2f, dir: vec2f, n: vec2f, len: f32, hw: f32, sw: f32, med: f32, cls: f32, w: f32, rtype: i32, mat: i32, cant: bool }
fn u16(id: i32, m: i32) -> f32 {
  let t = textureLoad(segs, vec2<i32>(m >> 1u, id), 0);
  if ((m & 1) == 0) { return f32(b8(t.r) + b8(t.g) * 256); }
  return f32(b8(t.b) + b8(t.a) * 256);
}
fn dPos(q: f32) -> f32 { return q / 50.0 - 20.0; }
fn dUnit(q: f32) -> f32 { return q / 32767.5 - 1.0; }
fn loadSeg(id: i32) -> Seg {
  var s: Seg;
  s.a = vec2f(dPos(u16(id, 0)), dPos(u16(id, 1)));
  s.dir = vec2f(dUnit(u16(id, 2)), dUnit(u16(id, 3)));
  s.n = vec2f(dUnit(u16(id, 4)), dUnit(u16(id, 5)));
  s.len = u16(id, 6) / 50.0;
  s.hw = u16(id, 7) / 1000.0;
  s.sw = u16(id, 8) / 1000.0;
  s.med = u16(id, 9) / 1000.0;
  s.cls = u16(id, 10);
  s.w = u16(id, 11) / 1000.0;
  s.rtype = i32(u16(id, 12));
  s.mat = i32(u16(id, 13));
  s.cant = u16(id, 14) > 0.5;
  return s;
}
fn nearCross(id: i32, t: f32, r: f32) -> bool {
  for (var m = 16; m < 24; m++) {
    let q = u16(id, m);
    if (q > 65534.5) { break; }
    if (abs(t - dPos(q)) < r) { return true; }
  }
  return false;
}


fn pixelMat(wx: f32, wy: f32, ix: i32, iy: i32) -> Mat {
  let U = customUniforms;
  if (wx < 0.0 || wy < 0.0 || wx > U.uMW || wy > U.uMH) { return rgbM(vec3f(40.0, 46.0, 36.0)); }
  let cc = vec2<i32>(clamp(i32(wx / U.uGC), 0, i32(U.uCW) - 1), clamp(i32(wy / U.uGC), 0, i32(U.uCH) - 1));
  var dr = 1e9;
  if (U.uRE > 0.0) { dr = length(vec2f(wx - U.uRX, wy - U.uRY)); }
  if (dr < U.uRI) {
    let e = U.uRI - dr;
    if (e < 0.16) { return rgbM(vec3f(222.0, 218.0, 208.0)); }
    if (e < 0.2) { return rgbM(vec3f(168.0, 164.0, 156.0)); }
    if (e < 1.5) { return tilesM(wx, wy, 6, false); }
    return grassM(0.3);
  }
  let A = textureLoad(cellA, cc, 0);
  let B = textureLoad(cellB, cc, 0);
  var ids = array<i32, 3>(b8(A.r) + b8(A.g) * 256 - 1, b8(A.b) + b8(A.a) * 256 - 1, b8(B.r) + b8(B.g) * 256 - 1);
  var rid = -1;
  var wid = -1;
  var rk = 0.0;
  var wk = 0.0;
  var rd = 0.0;
  var rt = 0.0;
  var rds = 0.0;
  var wd = 0.0;
  var wt = 0.0;
  var wds = 0.0;
  for (var k = 0; k < 3; k++) {
    let id = ids[k];
    if (id < 0) { continue; }
    let s = loadSeg(id);
    let p = vec2f(wx, wy) - s.a;
    let t = dot(p, s.dir);
    let tc = clamp(t, 0.0, s.len);
    let d = length(vec2f(wx, wy) - (s.a + s.dir * tc));
    let ds = dot(p, s.n);
    if (d < s.hw) {
      let kk = (d - s.hw) - s.cls * 0.01;
      if (rid < 0 || kk < rk) { rid = id; rk = kk; rd = d; rt = t; rds = ds; }
    } else if (s.sw > 0.0 && d < s.hw + s.sw) {
      let kk = d - s.hw - s.sw;
      if (wid < 0 || kk < wk) { wid = id; wk = kk; wd = d; wt = t; wds = ds; }
    }
  }
  if (dr < U.uRE) {
    let e = U.uRE - dr;
    if (rid < 0 && e < 0.07) { return rgbM(vec3f(112.0, 110.0, 104.0)); }
    if (rid < 0 && e < 0.4) { return rgbM(vec3f(160.0, 158.0, 152.0) * (0.95 + 0.08 * NG(ix, iy))); }
    return asphaltM(1.0);
  }
  if (rid >= 0) {
    let s = loadSeg(rid);
    let ad = abs(rds);
    let edge = s.hw - rd;
    if (s.sw > 0.0 && s.mat != 2 && s.mat != 3 && edge < 0.07) { return rgbM(vec3f(112.0, 110.0, 104.0)); }
    if (s.mat == 3) {
      if (wealthAt(wx, wy) > 0.18 || NB(ix, iy) > 0.5) { return tilesM(rt, ad, 4, true); }
      return dirtM(1.0);
    }
    if (s.mat == 2) {
      if (s.rtype != 3 && s.sw > 0.0 && edge < 1.4) {
        if (edge < 0.3) { return grassM(0.6); }
        if (edge > 1.15) { return dirtM(1.0); }
        let w = 0.5 + 0.5 * sin(f32(ix) * 0.3 + f32(iy) * 0.9);
        if (NG(ix, iy) > 0.985) { return rgbM(vec3f(220.0, 220.0, 210.0)); }
        return rgbM(vec3f(62.0 + 18.0 * w * 0.4, 76.0 + 14.0 * w * 0.4, 58.0 + 8.0 * w * 0.4));
      }
      let rut = min(abs(ad - 1.3), abs(ad - (s.hw - 1.9)));
      let mul = select(1.0, 0.86, rut < 0.35);
      if (NC(ix + 91, iy + 37) > 0.8 && NB(ix, iy) > 0.35) {
        let w = NC(ix + 91, iy + 37);
        return rgbM(select(vec3f(78.0, 62.0, 48.0), vec3f(96.0 + 40.0 * NG(ix, iy), 112.0 + 30.0 * NG(ix, iy), 120.0), w > 0.83));
      }
      return dirtM(mul);
    }
    if (s.rtype == 0 && ad < s.med) {
      if (s.med - ad < 0.15) { return rgbM(vec3f(214.0, 210.0, 200.0)); }
      return grassM(0.3);
    }
    if (s.rtype == 0 && ad < s.med + 0.12) { return rgbM(vec3f(150.0, 148.0, 142.0)); }
    if (s.sw > 0.0 && edge < 0.4) { return rgbM(vec3f(160.0, 158.0, 152.0) * (0.95 + 0.08 * NG(ix, iy))); }
    var mul = 1.0;
    if (s.mat == 1) {
      let ph = NC(ix + 300, iy + 120);
      let pb = NB(ix + 13, iy + 77);
      if (ph > 0.7 && pb > 0.45) {
        if (ph > 0.76 && pb > 0.6) { return rgbM(vec3f(80.0 + 40.0 * NG(ix, iy), 96.0 + 30.0 * NG(ix, iy), 104.0)); }
        return dirtM(1.0);
      }
      if (ph > 0.66 && pb > 0.4) { return rgbM(vec3f(38.0, 36.0, 36.0)); }
      if (NA(ix + 50, iy + 50) > 0.74) { mul = 0.8; }
      if (NB(ix * 2, iy * 2) > 0.82 && NG(ix, iy) > 0.5) { return rgbM(vec3f(32.0, 32.0, 36.0)); }
    }
    var col = asphaltM(mul);
    if (s.mat == 4) { col = adoquinM(rt, ad, mul); }
    if (nearCross(rid, rt, 1.5)) {
      if (fmod_(ad + 10.0, 1.0) < 0.55 && NG(ix, iy) > 0.1) { return rgbM(vec3f(210.0, 208.0, 198.0)); }
      return col;
    }
    if (s.rtype == 0) {
      let lane = abs(ad - (s.med + (s.hw - s.med) / 2.0));
      if (lane < 0.07 && fmod_(rt, 6.0) < 3.0) { return rgbM(vec3f(214.0, 212.0, 204.0)); }
    } else if (s.mat == 0 && s.w > 0.3 && ad < 0.07 && fmod_(rt, 5.0) < 2.5) {
      return rgbM(select(vec3f(214.0, 212.0, 204.0), vec3f(230.0, 200.0, 80.0), s.w > 0.6));
    }
    return col;
  }
  let sk = smoothKinds(wx, wy);
  if (wid >= 0) {
    let s = loadSeg(wid);
    let dd = wd - s.hw;
    if (s.mat == 2) {
      if (dd < 0.6) { return grassM(0.7); }
    } else {
      if (dd < 0.16) { return rgbM(vec3f(222.0, 218.0, 208.0)); }
      if (dd < 0.2) { return rgbM(vec3f(168.0, 164.0, 156.0)); }
    }
    let cz = cazuelaM(wx, wy, ix, iy);
    if (cz.m != M_NONE) { return cz; }
    let cant = s.cant && dd < 1.0 && !nearCross(wid, wt, 1.6);
    if (cant) { return grassM(0.2); }
    let vk = sk.x;
    var kind = vk & 15;
    var dmg = (vk & 16) != 0;
    if (kind == 0) {
      kind = select(2, 1, s.w < 0.3);
      dmg = s.w < 0.45;
    }
    return tilesM(wt, dd, kind, dmg);
  }
  let pk = sk.y;
  if (pk > 0) {
    let k = pk & 15;
    let d = (pk & 16) != 0;
    if (k == 1) { return grassM(0.3); }
    if (k == 2) {
      if (NB(ix, iy) > 0.6) { return grassM(0.8); }
      return dirtM(1.0);
    }
    if (k == 3) { return yuyoM(ix, iy); }
    if (k == 4) { return tilesM(wx, wy, 6, false); }
    return tilesM(wx, wy, 4, d);
  }
  let wv = wealthAt(wx, wy);
  if (wv < 0.15) {
    if (NB(ix, iy) > 0.5) {
      let f = 0.8 + 0.14 * (NA(ix, iy) - 0.5) + select(0.0, -0.12, NG(ix * 3, iy * 3) > 0.9);
      return rgbM(vec3f(156.0, 150.0, 140.0) * f);
    }
    if (NC(ix, iy) > 0.78) { return grassM(0.9); }
    return dirtM(1.0);
  }
  if (wv < 0.3) { return yuyoM(ix, iy); }
  return grassM(0.5);
}

// The surface, drawn once: tiles first turn into grass, dirt or their own colour (with the joint to lay over it).
fn paint(t: Mat, ix: i32, iy: i32) -> vec3f {
  var m = t.m;
  var dry = t.dry;
  var rgb = t.rgb;
  var cj = 0.0;
  var jc = vec3f(0.0);
  if (m == M_TILES) {
    let u = t.uv.x;
    let v = t.uv.y;
    let kind = t.kind;
    let dmg = t.dmg;
    if (kind == 5) {
      m = M_GRASS;
      dry = 0.4;
    } else if (kind == 1) {
      if (NB(ix, iy) > 0.55) { m = M_GRASS; dry = 0.9; } else { m = M_DIRT; }
    } else if (kind == 4) {
      let cj4 = juntas(junta(u / 1.5, 0.05 / 1.5, PXM / 1.5), junta(v / 1.5, 0.05 / 1.5, PXM / 1.5));
      let f = 0.95 + 0.1 * (NA(ix, iy) - 0.5) - 0.04 * junta(u * 8.0, 0.25, PXM * 8.0);
      m = M_RGB;
      rgb = mix(vec3f(190.0, 188.0, 180.0) * f, vec3f(138.0, 136.0, 128.0), cj4);
    } else {
      let size = select(0.4, 0.25, kind == 6);
      let tu = floor(u / size);
      let tv = floor(v / size);
      let lu = u / size - tu;
      let lv = v / size - tv;
      let w = PXM / size;
      let h = hash2(i32(tu) * 31 + 7, i32(tv) * 17 + 3);
      let base = select(select(vec3f(228.0, 212.0, 168.0), vec3f(188.0, 186.0, 178.0), kind == 3), vec3f(176.0, 86.0, 62.0), kind == 6);
      jc = select(vec3f(base.r * 0.74, base.g * 0.74, base.b * 0.72), vec3f(212.0, 196.0, 176.0), kind == 6);
      cj = juntas(junta(u / size, 0.07, w), junta(v / size, 0.07, w));
      let cerca = 1.0 - smoothstep(0.2, 0.5, w);
      if (dmg && h < 0.1) {
        m = M_DIRT;
      } else if (dmg && h < 0.2) {
        m = M_RGB;
        rgb = vec3f(176.0, 174.0, 166.0) * (0.95 + 0.1 * NG(ix, iy));
      } else {
        var f = 1.0 + (h - 0.5) * 0.08 + (NA(ix, iy) - 0.5) * 0.12 * select(1.0, 2.0, dmg);
        if (kind != 6) {
          let w3 = w * 3.0;
          let o1 = juntas(junta(u / size * 3.0, 0.12, w3), junta(v / size * 3.0, 0.12, w3));
          let o2 = juntas(junta(u / size * 3.0, 0.24, w3), junta(v / size * 3.0, 0.24, w3));
          f *= 1.0 - 0.1 * o1 + 0.04 * max(0.0, o2 - o1);
        }
        m = M_RGB;
        rgb = base * f;
        if (dmg && h < 0.3 && abs(lu - lv) < 0.04) { rgb = mix(rgb, vec3f(110.0, 98.0, 76.0), cerca); }
      }
    }
  }
  var c = rgb;
  if (m == M_GRASS) { c = grass(ix, iy, dry); }
  else if (m == M_DIRT) { c = dirt(ix, iy); }
  else if (m == M_ASPHALT) { c = asphalt(ix, iy); }
  else if (m == M_ADOQUIN) { c = adoquin(t.uv.x, t.uv.y, ix, iy); }
  return mix(c * t.mul, jc, cj);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let U = customUniforms;
  let wy = U.uMH - in.vWorld.y / (U.uSF * U.uSYN);
  let wx = in.vWorld.x / U.uSF - U.uK * wy;
  PXM = max(length(vec2f(dpdx(wx), dpdy(wx))), length(vec2f(dpdx(wy), dpdy(wy))));
  let ix = i32(floor(wx * U.uSF));
  let iy = i32(floor(wy * U.uSF));
  return vec4f(paint(pixelMat(wx, wy, ix, iy), ix, iy) / 255.0, 1.0);
}
