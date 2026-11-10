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
fn yuyo(ix: i32, iy: i32) -> vec3f {
  if (NC(ix, iy) > 0.6) { return dirt(ix, iy); }
  return grass(ix, iy, 0.8);
}
fn tiles(u: f32, v: f32, ix: i32, iy: i32, kind: i32, dmg: bool) -> vec3f {
  if (kind == 5) { return grass(ix, iy, 0.4); }
  if (kind == 1) {
    if (NB(ix, iy) > 0.55) { return grass(ix, iy, 0.9); }
    return dirt(ix, iy);
  }
  if (kind == 4) {
    let cj = juntas(junta(u / 1.5, 0.05 / 1.5, PXM / 1.5), junta(v / 1.5, 0.05 / 1.5, PXM / 1.5));
    let f = 0.95 + 0.1 * (NA(ix, iy) - 0.5) - 0.04 * junta(u * 8.0, 0.25, PXM * 8.0);
    return mix(vec3f(190.0, 188.0, 180.0) * f, vec3f(138.0, 136.0, 128.0), cj);
  }
  let size = select(0.4, 0.25, kind == 6);
  let tu = floor(u / size);
  let tv = floor(v / size);
  let lu = u / size - tu;
  let lv = v / size - tv;
  let w = PXM / size;
  let h = hash2(i32(tu) * 31 + 7, i32(tv) * 17 + 3);
  let base = select(select(vec3f(228.0, 212.0, 168.0), vec3f(188.0, 186.0, 178.0), kind == 3), vec3f(176.0, 86.0, 62.0), kind == 6);
  let jc = select(vec3f(base.r * 0.74, base.g * 0.74, base.b * 0.72), vec3f(212.0, 196.0, 176.0), kind == 6);
  let cj = juntas(junta(u / size, 0.07, w), junta(v / size, 0.07, w));
  let cerca = 1.0 - smoothstep(0.2, 0.5, w);
  var col: vec3f;
  if (dmg && h < 0.1) {
    col = dirt(ix, iy);
  } else if (dmg && h < 0.2) {
    col = vec3f(176.0, 174.0, 166.0) * (0.95 + 0.1 * NG(ix, iy));
  } else {
    var f = 1.0 + (h - 0.5) * 0.08 + (NA(ix, iy) - 0.5) * 0.12 * select(1.0, 2.0, dmg);
    if (kind != 6) {
      let w3 = w * 3.0;
      let o1 = juntas(junta(u / size * 3.0, 0.12, w3), junta(v / size * 3.0, 0.12, w3));
      let o2 = juntas(junta(u / size * 3.0, 0.24, w3), junta(v / size * 3.0, 0.24, w3));
      f *= 1.0 - 0.1 * o1 + 0.04 * max(0.0, o2 - o1);
    }
    col = base * f;
    if (dmg && h < 0.3 && abs(lu - lv) < 0.04) { col = mix(col, vec3f(110.0, 98.0, 76.0), cerca); }
  }
  return mix(col, jc, cj);
}
fn cazuela(wx: f32, wy: f32, ix: i32, iy: i32) -> vec3f {
  let gx = i32(floor(wx / 2.0));
  let gy = i32(floor(wy / 2.0));
  for (var x = gx - 1; x <= gx + 1; x++) {
    for (var y = gy - 1; y <= gy + 1; y++) {
      if (x < 0 || y < 0 || x >= i32(customUniforms.uPW) || y >= i32(customUniforms.uPH)) { continue; }
      let q = textureLoad(pits, vec2<i32>(x, y), 0);
      let tp = b8(q.a);
      if (tp == 0) { continue; }
      let c = vec2f(f32(x) * 2.0 + q.r * 2.0, f32(y) * 2.0 + q.g * 2.0);
      let a = q.b * 6.2831853 * 255.0 / 256.0;
      let d = vec2f(wx, wy) - c;
      let cs = cos(a);
      let sn = sin(a);
      let lx = d.x * cs + d.y * sn;
      let ly = -d.x * sn + d.y * cs;
      if (abs(lx) >= 0.7 || abs(ly) >= 0.7) { continue; }
      let edge = 0.7 - max(abs(lx), abs(ly));
      let t = tp & 3;
      if (edge < 0.11 && t == 1) { return vec3f(150.0, 74.0, 52.0) * (0.9 + 0.15 * NG(ix, iy)); }
      if (edge < 0.11 && t == 2) { return vec3f(172.0, 170.0, 162.0) * (0.92 + 0.1 * NG(ix, iy)); }
      if (edge < 0.18) { return dirt(ix, iy) * 0.72; }
      if ((tp & 4) != 0 && NB(ix * 2, iy * 2) > 0.5) { return grass(ix, iy, 0.6); }
      return dirt(ix, iy);
    }
  }
  return vec3f(-1.0);
}
fn wealthAt(x: f32, y: f32) -> f32 {
  let p = vec2<i32>(clamp(i32(x / 10.0), 0, i32(customUniforms.uWG) - 1), clamp(i32(y / 10.0), 0, i32(customUniforms.uHG) - 1));
  return textureLoad(wealth, p, 0).r;
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

fn pixel(wx: f32, wy: f32) -> vec3f {
  let U = customUniforms;
  if (wx < 0.0 || wy < 0.0 || wx > U.uMW || wy > U.uMH) { return vec3f(40.0, 46.0, 36.0); }
  let ix = i32(floor(wx * U.uSF));
  let iy = i32(floor(wy * U.uSF));
  let cc = vec2<i32>(clamp(i32(wx / U.uGC), 0, i32(U.uCW) - 1), clamp(i32(wy / U.uGC), 0, i32(U.uCH) - 1));
  var dr = 1e9;
  if (U.uRE > 0.0) { dr = length(vec2f(wx - U.uRX, wy - U.uRY)); }
  if (dr < U.uRI) {
    let e = U.uRI - dr;
    if (e < 0.16) { return vec3f(222.0, 218.0, 208.0); }
    if (e < 0.2) { return vec3f(168.0, 164.0, 156.0); }
    if (e < 1.5) { return tiles(wx, wy, ix, iy, 6, false); }
    return grass(ix, iy, 0.3);
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
    if (rid < 0 && e < 0.07) { return vec3f(112.0, 110.0, 104.0); }
    if (rid < 0 && e < 0.4) { return vec3f(160.0, 158.0, 152.0) * (0.95 + 0.08 * NG(ix, iy)); }
    return asphalt(ix, iy);
  }
  if (rid >= 0) {
    let s = loadSeg(rid);
    let ad = abs(rds);
    let edge = s.hw - rd;
    if (s.sw > 0.0 && s.mat != 2 && s.mat != 3 && edge < 0.07) { return vec3f(112.0, 110.0, 104.0); }
    if (s.mat == 3) {
      if (wealthAt(wx, wy) > 0.18 || NB(ix, iy) > 0.5) { return tiles(rt, ad, ix, iy, 4, true); }
      return dirt(ix, iy);
    }
    if (s.mat == 2) {
      if (s.rtype != 3 && s.sw > 0.0 && edge < 1.4) {
        if (edge < 0.3) { return grass(ix, iy, 0.6); }
        if (edge > 1.15) { return dirt(ix, iy); }
        let w = 0.5 + 0.5 * sin(f32(ix) * 0.3 + f32(iy) * 0.9);
        if (NG(ix, iy) > 0.985) { return vec3f(220.0, 220.0, 210.0); }
        return vec3f(62.0 + 18.0 * w * 0.4, 76.0 + 14.0 * w * 0.4, 58.0 + 8.0 * w * 0.4);
      }
      var col = dirt(ix, iy);
      let rut = min(abs(ad - 1.3), abs(ad - (s.hw - 1.9)));
      if (rut < 0.35) { col *= 0.86; }
      if (NC(ix + 91, iy + 37) > 0.8 && NB(ix, iy) > 0.35) {
        let w = NC(ix + 91, iy + 37);
        return select(vec3f(78.0, 62.0, 48.0), vec3f(96.0 + 40.0 * NG(ix, iy), 112.0 + 30.0 * NG(ix, iy), 120.0), w > 0.83);
      }
      return col;
    }
    if (s.rtype == 0 && ad < s.med) {
      if (s.med - ad < 0.15) { return vec3f(214.0, 210.0, 200.0); }
      return grass(ix, iy, 0.3);
    }
    if (s.rtype == 0 && ad < s.med + 0.12) { return vec3f(150.0, 148.0, 142.0); }
    if (s.sw > 0.0 && edge < 0.4) { return vec3f(160.0, 158.0, 152.0) * (0.95 + 0.08 * NG(ix, iy)); }
    var col: vec3f;
    if (s.mat == 4) { col = adoquin(rt, ad, ix, iy); } else { col = asphalt(ix, iy); }
    if (s.mat == 1) {
      let ph = NC(ix + 300, iy + 120);
      let pb = NB(ix + 13, iy + 77);
      if (ph > 0.7 && pb > 0.45) {
        if (ph > 0.76 && pb > 0.6) { return vec3f(80.0 + 40.0 * NG(ix, iy), 96.0 + 30.0 * NG(ix, iy), 104.0); }
        return dirt(ix, iy);
      }
      if (ph > 0.66 && pb > 0.4) { return vec3f(38.0, 36.0, 36.0); }
      if (NA(ix + 50, iy + 50) > 0.74) { col *= 0.8; }
      if (NB(ix * 2, iy * 2) > 0.82 && NG(ix, iy) > 0.5) { return vec3f(32.0, 32.0, 36.0); }
    }
    if (nearCross(rid, rt, 1.5)) {
      if (fmod_(ad + 10.0, 1.0) < 0.55 && NG(ix, iy) > 0.1) { return vec3f(210.0, 208.0, 198.0); }
      return col;
    }
    if (s.rtype == 0) {
      let lane = abs(ad - (s.med + (s.hw - s.med) / 2.0));
      if (lane < 0.07 && fmod_(rt, 6.0) < 3.0) { return vec3f(214.0, 212.0, 204.0); }
    } else if (s.mat == 0 && s.w > 0.3 && ad < 0.07 && fmod_(rt, 5.0) < 2.5) {
      return select(vec3f(214.0, 212.0, 204.0), vec3f(230.0, 200.0, 80.0), s.w > 0.6);
    }
    return col;
  }
  if (wid >= 0) {
    let s = loadSeg(wid);
    let dd = wd - s.hw;
    if (s.mat == 2) {
      if (dd < 0.6) { return grass(ix, iy, 0.7); }
    } else {
      if (dd < 0.16) { return vec3f(222.0, 218.0, 208.0); }
      if (dd < 0.2) { return vec3f(168.0, 164.0, 156.0); }
    }
    let cz = cazuela(wx, wy, ix, iy);
    if (cz.x >= 0.0) { return cz; }
    let cant = s.cant && dd < 1.0 && !nearCross(wid, wt, 1.6);
    if (cant) { return grass(ix, iy, 0.2); }
    let vk = b8(B.b);
    var kind = vk & 15;
    var dmg = (vk & 16) != 0;
    if (kind == 0) {
      kind = select(2, 1, s.w < 0.3);
      dmg = s.w < 0.45;
    }
    return tiles(wt, dd, ix, iy, kind, dmg);
  }
  let pk = b8(B.a);
  if (pk > 0) {
    let k = pk & 15;
    let d = (pk & 16) != 0;
    if (k == 1) { return grass(ix, iy, 0.3); }
    if (k == 2) {
      if (NB(ix, iy) > 0.6) { return grass(ix, iy, 0.8); }
      return dirt(ix, iy);
    }
    if (k == 3) { return yuyo(ix, iy); }
    if (k == 4) { return tiles(wx, wy, ix, iy, 6, false); }
    return tiles(wx, wy, ix, iy, 4, d);
  }
  let wv = wealthAt(wx, wy);
  if (wv < 0.15) {
    if (NB(ix, iy) > 0.5) {
      let f = 0.8 + 0.14 * (NA(ix, iy) - 0.5) + select(0.0, -0.12, NG(ix * 3, iy * 3) > 0.9);
      return vec3f(156.0, 150.0, 140.0) * f;
    }
    if (NC(ix, iy) > 0.78) { return grass(ix, iy, 0.9); }
    return dirt(ix, iy);
  }
  if (wv < 0.3) { return yuyo(ix, iy); }
  return grass(ix, iy, 0.5);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let U = customUniforms;
  let wy = U.uMH - in.vWorld.y / (U.uSF * U.uSYN);
  let wx = in.vWorld.x / U.uSF - U.uK * wy;
  PXM = max(length(vec2f(dpdx(wx), dpdy(wx))), length(vec2f(dpdx(wy), dpdy(wy))));
  return vec4f(pixel(wx, wy) / 255.0, 1.0);
}
