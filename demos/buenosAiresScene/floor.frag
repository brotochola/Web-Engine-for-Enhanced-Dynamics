#version 300 es
// The barrio's floor, painted on the GPU pixel by pixel: buenos-aires' shaders/piso.frag, the algorithm of its editor's
// ground.js. Data: 0.5 m cells with up to 3 candidate streets, the sidewalk and yard kind, a table of streets, wealth and noise.
// Its comments are left out of this copy; the game has them. Unlike the game's, it decides what each pixel is first
// (pixelMat) and draws that once (paint): it links in about 2.2 s instead of 6.2 on ANGLE's D3D11 (GTX 1650). And its
// sidewalks and yards meet along lines (smoothKinds), where the game's follow the 0.5 m cells.
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vWorld;
out vec4 finalColor;
uniform sampler2D cellA;     // rg: street 1 (+1), ba: street 2 (+1)
uniform sampler2D cellB;     // rg: street 3 (+1), b: sidewalk (kind | 16 damaged), a: yard (kind | 16 damaged)
uniform sampler2D wealth;    // wealth, 10 m cells
uniform sampler2D noiseT;    // r, g, b: three noises, a: grain
uniform sampler2D segs;      // 12 RGBA8 texels a street: 24 values of 16 bits (fixed point)
uniform sampler2D pits;      // tree pits in 2 m cells: rg centre in the cell, b angle (/256 of a turn), a kind (1 brick, 2 cement, 3 no border) | 4 grass
uniform float uMW, uMH, uK, uSF, uSYN, uGC, uCW, uCH, uWG, uHG, uPW, uPH;
uniform float uRX, uRY, uRI, uRE;   // a roundabout: centre, island and road radius, in m (uRE = 0: none)

int b8(float v) { return int(v * 255.0 + 0.5); }
float NA(int x, int y) { return texelFetch(noiseT, ivec2(x & 255, y & 255), 0).r; }
float NB(int x, int y) { return texelFetch(noiseT, ivec2(x & 255, y & 255), 0).g; }
float NC(int x, int y) { return texelFetch(noiseT, ivec2(x & 255, y & 255), 0).b; }
float NG(int x, int y) { return texelFetch(noiseT, ivec2(x & 255, y & 255), 0).a; }
float hash2(int a, int b) { uint h = uint(a) * 374761393u ^ uint(b) * 668265263u; h = (h ^ (h >> 13u)) * 1274126177u; return float(h ^ (h >> 16u)) / 4294967296.0; }
float fmod_(float a, float m) { return a - m * floor(a / m); }

vec3 ramp5(vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4, float t) {
  t = clamp(t, 0.0, 0.999) * 4.0; int i = int(t); float f = t - float(i);
  if (i == 0) return mix(c0, c1, f); if (i == 1) return mix(c1, c2, f); if (i == 2) return mix(c2, c3, f); return mix(c3, c4, f);
}
vec3 asphalt(int ix, int iy) {
  float v = .86 + .3 * (NC(ix >> 2, iy >> 2) - .5) + .16 * (NA(ix, iy) - .5) + .14 * (NG(ix, iy) - .5);
  if (NG(ix * 7, iy * 3) > .95) return vec3(118, 116, 112); return vec3(70, 71, 76) * v;
}
float PXM = .055;
float junta(float x, float j, float w) {
  w = max(w, 1e-4); float a = x - w * .5, b = x + w * .5;
  return clamp((floor(b) * j + min(fract(b), j) - floor(a) * j - min(fract(a), j)) / w, 0.0, 1.0);
}
float juntas(float cu, float cv) { return 1.0 - (1.0 - cu) * (1.0 - cv); }
vec3 adoquin(float u, float v, int ix, int iy) {
  float bw = .3, bh = .2, row = floor(v / bh), uu = u + fmod_(row, 2.0) * bw * .5, cu = floor(uu / bw), lu = uu / bw - cu, lv = v / bh - row;
  float h = hash2(int(cu) * 13 + 5, int(row) * 7 + 11), cj = juntas(junta(uu / bw, .13, PXM / bw), junta(v / bh, .17, PXM / bh));
  float f = (1.0 + (.5 - lv) * .14 - (lu - .5) * .06) * (.94 + .1 * NA(ix, iy));
  return mix(vec3(96.0 + 36.0 * h, 98.0 + 30.0 * h, 104.0 + 18.0 * h) * f, vec3(58, 56, 54) * (.9 + .2 * NG(ix, iy)), cj);
}
vec3 grass(int ix, int iy, float dry) {
  float t = .45 + (NA(ix, iy) - .5) * .7 + (NB(ix, iy) - .5) * .3 + (NG(ix, iy) - .5) * .35;
  vec3 c = ramp5(vec3(46, 80, 40), vec3(62, 102, 48), vec3(80, 126, 58), vec3(102, 150, 70), vec3(132, 174, 86), t);
  if (dry > 0.0) { float d = clamp((NC(ix, iy) - .55) * 3.0, 0.0, 1.0) * dry; c = vec3(c.r + (150.0 - c.r) * d, c.g + (140.0 - c.g) * d * .6, c.b + (80.0 - c.b) * d); }
  if (NG(ix * 3, iy * 5) > .965) return vec3(176, 204, 120); return c;
}
vec3 dirt(int ix, int iy) {
  float t = .5 + (NA(ix, iy) - .5) * .5 + (NB(ix, iy) - .5) * .3 + (NG(ix, iy) - .5) * .2, g = NG(ix * 5, iy * 7);
  if (g > .97) return vec3(196, 184, 160); if (g < .015) return vec3(72, 56, 44);
  return ramp5(vec3(96, 72, 52), vec3(118, 88, 62), vec3(140, 106, 76), vec3(160, 126, 90), vec3(182, 150, 112), t);
}
// What a pixel is: a colour, or a surface that paint() draws at the end. Each surface is drawn at one place only, since
// D3D's compiler (ANGLE on Windows) inlines every call: the shader that called grass and dirt from twenty places took 6 s
// to link on a GTX 1650, before the first frame.
const int M_RGB = 0, M_GRASS = 1, M_DIRT = 2, M_ASPHALT = 3, M_ADOQUIN = 4, M_TILES = 5, M_NONE = 6;
struct Mat { int m; vec3 rgb; float dry; float mul; vec2 uv; int kind; bool dmg; };
Mat rgbM(vec3 c) { return Mat(M_RGB, c, 0.0, 1.0, vec2(0.0), 0, false); }
Mat grassM(float dry) { return Mat(M_GRASS, vec3(0.0), dry, 1.0, vec2(0.0), 0, false); }
Mat dirtM(float mul) { return Mat(M_DIRT, vec3(0.0), 0.0, mul, vec2(0.0), 0, false); }
Mat asphaltM(float mul) { return Mat(M_ASPHALT, vec3(0.0), 0.0, mul, vec2(0.0), 0, false); }
Mat adoquinM(float u, float v, float mul) { return Mat(M_ADOQUIN, vec3(0.0), 0.0, mul, vec2(u, v), 0, false); }
Mat tilesM(float u, float v, int kind, bool dmg) { return Mat(M_TILES, vec3(0.0), 0.0, 1.0, vec2(u, v), kind, dmg); }
Mat yuyoM(int ix, int iy) { if (NC(ix, iy) > .6) return dirtM(1.0); return grassM(.8); }

// The first tree pit (in the order x, then y, over the 3 × 3 cells around) that holds the point decides; the decision
// comes after the loop, so the unrolled loop holds no return.
Mat cazuelaM(float wx, float wy, int ix, int iy) {
  int gx = int(floor(wx / 2.0)), gy = int(floor(wy / 2.0));
  float edge = 0.0; int tp = 0;
  for (int i = 0; i < 9; i++) {
    int x = gx - 1 + i / 3, y = gy - 1 + i % 3;
    if (x < 0 || y < 0 || x >= int(uPW) || y >= int(uPH)) continue;
    vec4 q = texelFetch(pits, ivec2(x, y), 0); int t = b8(q.a); if (t == 0) continue;
    vec2 c = vec2(float(x) * 2.0 + q.r * 2.0, float(y) * 2.0 + q.g * 2.0); float a = q.b * 6.2831853 * 255.0 / 256.0;
    vec2 d = vec2(wx, wy) - c; float cs = cos(a), sn = sin(a), lx = d.x * cs + d.y * sn, ly = -d.x * sn + d.y * cs;
    if (abs(lx) >= .7 || abs(ly) >= .7) continue;
    edge = .7 - max(abs(lx), abs(ly)); tp = t; break;
  }
  if (tp == 0) return Mat(M_NONE, vec3(0.0), 0.0, 1.0, vec2(0.0), 0, false);
  int t = tp & 3;
  if (edge < .11 && t == 1) return rgbM(vec3(150, 74, 52) * (.9 + .15 * NG(ix, iy)));
  if (edge < .11 && t == 2) return rgbM(vec3(172, 170, 162) * (.92 + .1 * NG(ix, iy)));
  if (edge < .18) return dirtM(.72);
  if ((tp & 4) != 0 && NB(ix * 2, iy * 2) > .5) return grassM(.6);
  return dirtM(1.0);
}
float wealthAt(float x, float y) { return texelFetch(wealth, ivec2(clamp(int(x / 10.0), 0, int(uWG) - 1), clamp(int(y / 10.0), 0, int(uHG) - 1)), 0).r; }

// The sidewalk's and the yard's kind (cellB's b and a), not those of the one cell under the pixel: each is the kind of one
// of the four nearest cells, the one held by the largest share of the 4 x 4 cells around, weighted by a tent of 1.5 cells.
// Kinds then meet along straight lines near the lots' own edges instead of along the cells' edges, in 0.5 m steps. A 0
// has no vote in the sidewalk's kind (it is the cell's other side), and does in the yard's (no yard).
ivec2 smoothKinds(float wx, float wy) {
  vec2 g = vec2(wx, wy) / uGC - .5; ivec2 c0 = ivec2(floor(g)); vec2 f = g - vec2(c0);
  ivec2 hi = ivec2(int(uCW) - 1, int(uCH) - 1);
  ivec4 kb, ka;
  for (int c = 0; c < 4; c++) { vec4 t = texelFetch(cellB, clamp(c0 + ivec2(c & 1, c >> 1), ivec2(0), hi), 0); kb[c] = b8(t.b); ka[c] = b8(t.a); }
  vec4 sb = vec4(0.0), sa = vec4(0.0);
  for (int n = 0; n < 16; n++) {
    int i = (n & 3) - 1, j = (n >> 2) - 1;
    vec4 t = texelFetch(cellB, clamp(c0 + ivec2(i, j), ivec2(0), hi), 0); int b = b8(t.b), a = b8(t.a);
    float w = max(0.0, 1.5 - abs(float(i) - f.x)) * max(0.0, 1.5 - abs(float(j) - f.y));
    if (b != 0) sb += w * vec4(equal(kb, ivec4(b)));
    sa += w * vec4(equal(ka, ivec4(a)));
  }
  int bestB = 0, bestA = ka.x; float vb = 0.0, va = sa.x;
  for (int c = 0; c < 4; c++) { if (sb[c] > vb) { vb = sb[c]; bestB = kb[c]; } if (sa[c] > va) { va = sa[c]; bestA = ka[c]; } }
  return ivec2(bestB, bestA);
}
struct Seg { vec2 a; vec2 dir; vec2 n; float len, hw, sw, med, cls, w; int type, mat; bool cant; };
float u16(int id, int m) { vec4 t = texelFetch(segs, ivec2(m >> 1, id), 0); return (m & 1) == 0 ? float(b8(t.r) + b8(t.g) * 256) : float(b8(t.b) + b8(t.a) * 256); }
float dPos(float q) { return q / 50.0 - 20.0; }
float dUnit(float q) { return q / 32767.5 - 1.0; }
Seg loadSeg(int id) { Seg s;
  s.a = vec2(dPos(u16(id, 0)), dPos(u16(id, 1))); s.dir = vec2(dUnit(u16(id, 2)), dUnit(u16(id, 3))); s.n = vec2(dUnit(u16(id, 4)), dUnit(u16(id, 5)));
  s.len = u16(id, 6) / 50.0; s.hw = u16(id, 7) / 1000.0; s.sw = u16(id, 8) / 1000.0; s.med = u16(id, 9) / 1000.0; s.cls = u16(id, 10); s.w = u16(id, 11) / 1000.0;
  s.type = int(u16(id, 12)); s.mat = int(u16(id, 13)); s.cant = u16(id, 14) > .5; return s; }
bool nearCross(int id, float t, float r) {
  for (int m = 16; m < 24; m++) { float q = u16(id, m); if (q > 65534.5) break; if (abs(t - dPos(q)) < r) return true; }
  return false; }


Mat pixelMat(float wx, float wy, int ix, int iy) {
  if (wx < 0.0 || wy < 0.0 || wx > uMW || wy > uMH) return rgbM(vec3(40, 46, 36));
  ivec2 cc = ivec2(clamp(int(wx / uGC), 0, int(uCW) - 1), clamp(int(wy / uGC), 0, int(uCH) - 1));
  float dr = uRE > 0.0 ? length(vec2(wx - uRX, wy - uRY)) : 1e9;
  if (dr < uRI) { float e = uRI - dr;
    if (e < .16) return rgbM(vec3(222, 218, 208)); if (e < .2) return rgbM(vec3(168, 164, 156));
    if (e < 1.5) return tilesM(wx, wy, 6, false); return grassM(.3); }
  vec4 A = texelFetch(cellA, cc, 0), B = texelFetch(cellB, cc, 0);
  int ids[3]; ids[0] = b8(A.r) + b8(A.g) * 256 - 1; ids[1] = b8(A.b) + b8(A.a) * 256 - 1; ids[2] = b8(B.r) + b8(B.g) * 256 - 1;
  int rid = -1, wid = -1; float rk = 0.0, wk = 0.0, rd = 0.0, rt = 0.0, rds = 0.0, wd = 0.0, wt = 0.0, wds = 0.0;
  for (int k = 0; k < 3; k++) { int id = ids[k]; if (id < 0) continue; Seg s = loadSeg(id);
    vec2 p = vec2(wx, wy) - s.a; float t = dot(p, s.dir), tc = clamp(t, 0.0, s.len), d = length(vec2(wx, wy) - (s.a + s.dir * tc)), ds = dot(p, s.n);
    if (d < s.hw) { float kk = (d - s.hw) - s.cls * .01; if (rid < 0 || kk < rk) { rid = id; rk = kk; rd = d; rt = t; rds = ds; } }
    else if (s.sw > 0.0 && d < s.hw + s.sw) { float kk = d - s.hw - s.sw; if (wid < 0 || kk < wk) { wid = id; wk = kk; wd = d; wt = t; wds = ds; } } }
  if (dr < uRE) {
    float e = uRE - dr;
    if (rid < 0 && e < .07) return rgbM(vec3(112, 110, 104));
    if (rid < 0 && e < .4) { float f = .95 + .08 * NG(ix, iy); return rgbM(vec3(160, 158, 152) * f); }
    return asphaltM(1.0); }
  if (rid >= 0) {
    Seg s = loadSeg(rid); float ad = abs(rds), edge = s.hw - rd;
    if (s.sw > 0.0 && s.mat != 2 && s.mat != 3 && edge < .07) return rgbM(vec3(112, 110, 104));
    if (s.mat == 3) { if (wealthAt(wx, wy) > .18 || NB(ix, iy) > .5) return tilesM(rt, ad, 4, true); return dirtM(1.0); }
    if (s.mat == 2) {
      if (s.type != 3 && s.sw > 0.0 && edge < 1.4) {
        if (edge < .3) return grassM(.6); if (edge > 1.15) return dirtM(1.0);
        float w = .5 + .5 * sin(float(ix) * .3 + float(iy) * .9); if (NG(ix, iy) > .985) return rgbM(vec3(220, 220, 210));
        return rgbM(vec3(62.0 + 18.0 * w * .4, 76.0 + 14.0 * w * .4, 58.0 + 8.0 * w * .4));
      }
      float rut = min(abs(ad - 1.3), abs(ad - (s.hw - 1.9))); float mul = rut < .35 ? .86 : 1.0;
      if (NC(ix + 91, iy + 37) > .8 && NB(ix, iy) > .35) { float w = NC(ix + 91, iy + 37); return rgbM(w > .83 ? vec3(96.0 + 40.0 * NG(ix, iy), 112.0 + 30.0 * NG(ix, iy), 120) : vec3(78, 62, 48)); }
      return dirtM(mul);
    }
    if (s.type == 0 && ad < s.med) { if (s.med - ad < .15) return rgbM(vec3(214, 210, 200)); return grassM(.3); }
    if (s.type == 0 && ad < s.med + .12) return rgbM(vec3(150, 148, 142));
    if (s.sw > 0.0 && edge < .4) { float f = .95 + .08 * NG(ix, iy); return rgbM(vec3(160, 158, 152) * f); }
    float mul = 1.0;
    if (s.mat == 1) {
      float ph = NC(ix + 300, iy + 120), pb = NB(ix + 13, iy + 77);
      if (ph > .7 && pb > .45) { if (ph > .76 && pb > .6) return rgbM(vec3(80.0 + 40.0 * NG(ix, iy), 96.0 + 30.0 * NG(ix, iy), 104)); return dirtM(1.0); }
      if (ph > .66 && pb > .4) return rgbM(vec3(38, 36, 36));
      if (NA(ix + 50, iy + 50) > .74) mul = .8;
      if (NB(ix * 2, iy * 2) > .82 && NG(ix, iy) > .5) return rgbM(vec3(32, 32, 36));
    }
    Mat col = asphaltM(mul);
    if (s.mat == 4) col = adoquinM(rt, ad, mul);
    if (nearCross(rid, rt, 1.5)) { if (fmod_(ad + 10.0, 1.0) < .55 && NG(ix, iy) > .1) return rgbM(vec3(210, 208, 198)); return col; }
    if (s.type == 0) { float lane = abs(ad - (s.med + (s.hw - s.med) / 2.0)); if (lane < .07 && fmod_(rt, 6.0) < 3.0) return rgbM(vec3(214, 212, 204)); }
    else if (s.mat == 0 && s.w > .3 && ad < .07 && fmod_(rt, 5.0) < 2.5) return rgbM(s.w > .6 ? vec3(230, 200, 80) : vec3(214, 212, 204));
    return col;
  }
  ivec2 sk = smoothKinds(wx, wy);
  if (wid >= 0) {
    Seg s = loadSeg(wid); float dd = wd - s.hw;
    if (s.mat == 2) { if (dd < .6) return grassM(.7); }
    else { if (dd < .16) return rgbM(vec3(222, 218, 208)); if (dd < .2) return rgbM(vec3(168, 164, 156)); }
    Mat cz = cazuelaM(wx, wy, ix, iy); if (cz.m != M_NONE) return cz;
    bool cant = s.cant && dd < 1.0 && !nearCross(wid, wt, 1.6);
    if (cant) return grassM(.2);
    int vk = sk.x; int kind = vk & 15; bool dmg = (vk & 16) != 0;
    if (kind == 0) { kind = s.w < .3 ? 1 : 2; dmg = s.w < .45; }
    return tilesM(wt, dd, kind, dmg);
  }
  int pk = sk.y;
  if (pk > 0) { int k = pk & 15; bool d = (pk & 16) != 0;
    if (k == 1) return grassM(.3); if (k == 2) { if (NB(ix, iy) > .6) return grassM(.8); return dirtM(1.0); }
    if (k == 3) return yuyoM(ix, iy); if (k == 4) return tilesM(wx, wy, 6, false); return tilesM(wx, wy, 4, d); }
  float wv = wealthAt(wx, wy);
  if (wv < .15) { if (NB(ix, iy) > .5) { float f = .8 + .14 * (NA(ix, iy) - .5) + (NG(ix * 3, iy * 3) > .9 ? -.12 : 0.0); return rgbM(vec3(156, 150, 140) * f); }
    if (NC(ix, iy) > .78) return grassM(.9); return dirtM(1.0); }
  if (wv < .3) return yuyoM(ix, iy); return grassM(.5);
}

// The surface, drawn once: tiles first turn into grass, dirt or their own colour (with the joint to lay over it).
vec3 paint(Mat t, int ix, int iy) {
  int m = t.m; float dry = t.dry; vec3 rgb = t.rgb; float cj = 0.0; vec3 jc = vec3(0.0);
  if (m == M_TILES) {
    float u = t.uv.x, v = t.uv.y; int kind = t.kind; bool dmg = t.dmg;
    if (kind == 5) { m = M_GRASS; dry = .4; }
    else if (kind == 1) { if (NB(ix, iy) > .55) { m = M_GRASS; dry = .9; } else m = M_DIRT; }
    else if (kind == 4) {
      float cj4 = juntas(junta(u / 1.5, .05 / 1.5, PXM / 1.5), junta(v / 1.5, .05 / 1.5, PXM / 1.5));
      float f = .95 + .1 * (NA(ix, iy) - .5) - .04 * junta(u * 8.0, .25, PXM * 8.0);
      m = M_RGB; rgb = mix(vec3(190, 188, 180) * f, vec3(138, 136, 128), cj4);
    } else {
      float size = kind == 6 ? .25 : .4, tu = floor(u / size), tv = floor(v / size), lu = u / size - tu, lv = v / size - tv, w = PXM / size;
      float h = hash2(int(tu) * 31 + 7, int(tv) * 17 + 3);
      vec3 base = kind == 6 ? vec3(176, 86, 62) : kind == 3 ? vec3(188, 186, 178) : vec3(228, 212, 168);
      jc = kind == 6 ? vec3(212, 196, 176) : vec3(base.r * .74, base.g * .74, base.b * .72);
      cj = juntas(junta(u / size, .07, w), junta(v / size, .07, w));
      float cerca = 1.0 - smoothstep(.2, .5, w);
      if (dmg && h < .1) m = M_DIRT;
      else if (dmg && h < .2) { m = M_RGB; rgb = vec3(176, 174, 166) * (.95 + .1 * NG(ix, iy)); }
      else {
        float f = 1.0 + (h - .5) * .08 + (NA(ix, iy) - .5) * .12 * (dmg ? 2.0 : 1.0);
        if (kind != 6) {
          float w3 = w * 3.0, o1 = juntas(junta(u / size * 3.0, .12, w3), junta(v / size * 3.0, .12, w3)), o2 = juntas(junta(u / size * 3.0, .24, w3), junta(v / size * 3.0, .24, w3));
          f *= 1.0 - .1 * o1 + .04 * max(0.0, o2 - o1); }
        m = M_RGB; rgb = base * f;
        if (dmg && h < .3 && abs(lu - lv) < .04) rgb = mix(rgb, vec3(110, 98, 76), cerca);
      }
    }
  }
  vec3 c;
  if (m == M_GRASS) c = grass(ix, iy, dry);
  else if (m == M_DIRT) c = dirt(ix, iy);
  else if (m == M_ASPHALT) c = asphalt(ix, iy);
  else if (m == M_ADOQUIN) c = adoquin(t.uv.x, t.uv.y, ix, iy);
  else c = rgb;
  return mix(c * t.mul, jc, cj);
}

void main() {
  float wy = uMH - vWorld.y / (uSF * uSYN), wx = vWorld.x / uSF - uK * wy;
  PXM = max(length(vec2(dFdx(wx), dFdy(wx))), length(vec2(dFdx(wy), dFdy(wy))));
  int ix = int(floor(wx * uSF)), iy = int(floor(wy * uSF));
  finalColor = vec4(paint(pixelMat(wx, wy, ix, iy), ix, iy) / 255.0, 1.0);
}
