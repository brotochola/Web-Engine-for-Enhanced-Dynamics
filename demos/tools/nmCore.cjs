// nm-core: the normal map and height map generator of the "Luz 2.5D" page (claude.ai artifact DR1fHARFKXssVNrixn4ufh,
// the owner's), copied as it is but for the lines marked "WeedJS patch" (process() and processRelieve() also return the
// heights as floats, heightF, for the engine's 16-bit height maps). Vehicles of several headings (TopDown Vehicles):
// a prism model fitted to every frame's silhouette, each frame refined, an SDF ray-marched for normals and heights;
// single-view sprites (LPC, trees, props): the silhouette inflated by each part's thickness, shape from the painted
// shading. World: X east, Y south, Z up; screen x = X, screen y = A·Y - B·Z. Normals: R +x, G +y up (north), B +z.
// Used by bakeCarSheet.mjs and bakeReliefMaps.mjs.
/* =====================================================================
   nm-core.js — generador de normal map + mapa de altura para atlas de
   vehículos pre-renderizados en vista oblicua (TopDown Vehicles).
   Corre igual en el navegador (Web Worker) y en Node. Sin dependencias.

   Pipeline por vehículo:
     1. AJUSTE GLOBAL: medidas de un modelo paramétrico (prismas convexos)
        que mejor reproducen la silueta (alpha) de todos los cuadros.
     2. REFINAMIENTO por cuadro: pequeño desvío de ángulo, escala y posición.
     3. RENDER: ray-marching de un SDF redondeado -> normal + altura por píxel.
     4. DETALLE fino desde la luminancia del dibujo + recorte con el alpha.

   Convenciones:
     mundo: X este, Y sur (abajo en pantalla), Z arriba.
     proyección oblicua:  pantalla_x = X ;  pantalla_y = A*Y - B*Z
     normal map (espacio de mundo): R=+x, G=+y ARRIBA (norte), B=+z.
     altura: gris = Z*4.
   ===================================================================== */
(function (root) {
'use strict';

// Proyección compartida por todo el pack (ajustada con el camión).
const A = 0.7364193217154872, B = 0.7516549042792687;
const ZC = 3.0;           // piso de la carrocería
const CAN = 200, SS = 2;  // lienzo de siluetas (px) y supermuestreo
const S = CAN * SS;

// ------------------------------------------------------------- modelos
// p0 = medidas iniciales (px del mundo). Salen de ajustar los vehículos del pack.
const TIPOS = {
  sedan:     { keys: ['L','W','Hb','Hr','gr','gf','sr','sf','cf','cr','rw','gw'],
               p0: { L: 80.5, W: 32.5, Hb: 12.9, Hr: 22.6, gr: .18, gf: .80, sr: 9.5, sf: 13, cf: 7.2, cr: 7.2, rw: 7.7, gw: .88 } },
  pickup:    { keys: ['L','W','Hb','Hr','gr','gf','sr','sf','cf','cr','rw','gw'],
               p0: { L: 82, W: 32.6, Hb: 12.3, Hr: 20.4, gr: .35, gf: .76, sr: 1.2, sf: 8.4, cf: 9, cr: .85, rw: 7, gw: .89 } },
  hatch:     { keys: ['L','W','Hb','Hr','gr','gf','sr','sf','cf','cr','rw','gw'],
               p0: { L: 76.6, W: 34, Hb: 8.3, Hr: 19.8, gr: .06, gf: .80, sr: 4, sf: 8.3, cf: 6.6, cr: 1.75, rw: 6.5, gw: .89 } },
  colectivo: { keys: ['L','W','Hb','Hr','gr','gf','sr','sf','cf','cr','rw','gw'],
               p0: { L: 139.3, W: 42, Hb: 13.7, Hr: 42.4, gr: .007, gf: .97, sr: 3, sf: 6, cf: 3, cr: 3, rw: 5, gw: .87 } },
  camion:    { keys: ['L','W','Lb','Hbox','Lc','Hc','Hh','rw'],
               p0: { L: 96.4, W: 30.4, Lb: 55.8, Hbox: 36.3, Lc: 19.3, Hc: 21.4, Hh: 15.0, rw: 7.3 } },
};
const STEPS = { L: 3, W: 2, Hb: 1.5, Hr: 1.5, gr: .03, gf: .03, sr: 2, sf: 2, cf: 2, cr: 2, rw: 1, gw: .04,
                Lb: 3, Hbox: 2, Lc: 2, Hc: 1.5, Hh: 1.5 };

function guessType(name) {
  const n = name.toLowerCase();
  const tipo = /pickup|camioneta/.test(n) ? 'pickup' : /colectivo|bus|omnibus/.test(n) ? 'colectivo'
             : /hatch/.test(n) ? 'hatch' : /camion|truck|furgon/.test(n) ? 'camion' : 'sedan';
  const extra = /polic/.test(n) ? 'barra' : /taxi/.test(n) ? 'cartel' : null;
  return { tipo, extra, abandonado: /abandon/.test(n) };
}

function prism(prof, hw, r, cy = 0, kind = 'prism') { return { kind, prof, hw, r, cy }; }

function buildParts(p, tipo, extra) {
  const L = p.L, W = p.W, xr = -L / 2, xf = L / 2, hw = W / 2;
  const parts = [];
  if (tipo === 'camion') {
    const xb = xr + p.Lb, xc = xb + p.Lc;
    parts.push(prism([[xr, 7], [xb - .5, 7], [xb - .5, p.Hbox], [xr, p.Hbox]], hw, 4));
    parts.push(prism([[xb + .5, 7], [xc + 5, 7], [xc + 5, p.Hh + 1], [Math.max(xc - 5, xb + 2), p.Hc], [xb + .5, p.Hc]], hw * .93, 3));
    parts.push(prism([[xc - 2, 5], [xf, 5], [xf, p.Hh - 5], [xf - 8, p.Hh], [xc - 2, p.Hh]], hw * .95, 3));
    parts.push(prism([[xr - .5, 3], [xf + .5, 3], [xf + .5, 9], [xr - .5, 9]], hw, 2));
    for (const ax of [xr + .2 * L, xf - .17 * L]) for (const sg of [-1, 1])
      parts.push({ kind: 'wheel', ax, rw: p.rw, cy: sg * (hw - 2.5), hw: 3 });
    return parts;
  }
  const Hb = p.Hb, Hr = Math.max(p.Hr, p.Hb + 3);
  const dz = .35 * (Hb - ZC), cf = Math.max(p.cf, .5), cr = Math.max(p.cr, .5);
  parts.push(prism([[xr, ZC], [xf, ZC], [xf, Hb - dz], [xf - cf, Hb], [xr + cr, Hb], [xr, Hb - dz]], hw, 3));
  const x0 = xr + L * p.gr, x1 = xr + L * p.gf;
  let sr = Math.max(p.sr, .3), sf = Math.max(p.sf, .3);
  const k = (x1 - x0 - 2) / (sr + sf); if (k < 1) { sr *= k; sf *= k; }
  parts.push(prism([[x0, Hb - 1], [x1, Hb - 1], [x1 - sf, Hr], [x0 + sr, Hr]], hw * p.gw, 2.5));
  const xm = (x0 + sr + x1 - sf) / 2;
  if (tipo === 'pickup')
    parts.push(prism([[xr + 2.5, ZC + 4], [x0 - 1.5, ZC + 4], [x0 - 1.5, Hb + 6], [xr + 2.5, Hb + 6]], hw - 2.5, 1, 0, 'sub'));
  if (extra === 'barra')
    parts.push(prism([[xm - 2.5, Hr - 1], [xm + 2.5, Hr - 1], [xm + 2.5, Hr + 4], [xm - 2.5, Hr + 4]], hw * .72, 1));
  if (extra === 'cartel')
    parts.push(prism([[xm - 3, Hr - 1], [xm + 3, Hr - 1], [xm + 2.5, Hr + 3.5], [xm - 2.5, Hr + 3.5]], hw * .32, 1));
  // ruedas: nunca más altas que la carrocería (si no, asoman como bultos sobre el capó)
  const rwE = Math.min(p.rw, (Hb - 1.5) / 2);
  for (const ax of [xr + .19 * L, xf - .19 * L]) for (const sg of [-1, 1])
    parts.push({ kind: 'wheel', ax, rw: rwE, cy: sg * (hw - 2.5), hw: 3 });
  return parts;
}

// ------------------------------------------------------------- siluetas
function hull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function partVertices(pt) {
  let prof = pt.prof;
  if (pt.kind === 'wheel') { prof = []; for (let k = 0; k < 8; k++) { const t = k / 8 * 2 * Math.PI; prof.push([pt.ax + pt.rw * Math.cos(t), pt.rw + pt.rw * Math.sin(t)]); } }
  const v = [];
  for (const [x, z] of prof) { v.push([x, pt.cy - pt.hw, z]); v.push([x, pt.cy + pt.hw, z]); }
  return v;
}

function fillConvex(sub, poly) {
  let ymin = Infinity, ymax = -Infinity;
  for (const p of poly) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
  const r0 = Math.max(0, Math.ceil(ymin - .5)), r1 = Math.min(S - 1, Math.floor(ymax - .5));
  const n = poly.length;
  for (let r = r0; r <= r1; r++) {
    const yc = r + .5; let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
        const x = a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
        if (x < xl) xl = x; if (x > xr) xr = x;
      }
    }
    if (xl > xr) continue;
    const c0 = Math.max(0, Math.ceil(xl - .5)), c1 = Math.min(S - 1, Math.floor(xr - .5));
    sub.fill(1, r * S + c0, r * S + c1 + 1);
  }
}

const _sub = new Uint8Array(S * S);
// devuelve cobertura (0..1) en el lienzo CAN x CAN + centroide y área
function silhouette(parts, angDeg, kx = 1, ky = 1, cov = new Float32Array(CAN * CAN)) {
  _sub.fill(0); cov.fill(0);
  const c = Math.cos(angDeg * Math.PI / 180), s = Math.sin(angDeg * Math.PI / 180);
  for (const pt of parts) {
    if (pt.kind === 'sub') continue;
    const pts = partVertices(pt).map(([X, Y, Z]) => {
      const wx = X * c - Y * s, wy = X * s + Y * c;
      return [(wx * kx + CAN / 2) * SS, ((A * wy - B * Z) * ky + CAN / 2) * SS];
    });
    fillConvex(_sub, hull(pts));
  }
  let area = 0, mx = 0, my = 0;
  for (let j = 0; j < CAN; j++) for (let i = 0; i < CAN; i++) {
    const b = 2 * j * S + 2 * i;
    const v = (_sub[b] + _sub[b + 1] + _sub[b + S] + _sub[b + S + 1]) * .25;
    if (v) { cov[j * CAN + i] = v; area += v; mx += v * (i + .5); my += v * (j + .5); }
  }
  return { cov, area, cx: mx / (area || 1), cy: my / (area || 1) };
}

function maskInfo(mask, w, h) {
  let area = 0, mx = 0, my = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (mask[j * w + i]) { area++; mx += i + .5; my += j + .5; }
  return { mask, w, h, area, cx: mx / area, cy: my / area };
}

// IoU con el cuadro desplazado: píxel (i,j) del cuadro <-> (i+dx, j+dy) del lienzo
function iouAt(sil, m, dx, dy) {
  let inter = 0;
  const { mask, w, h } = m, cov = sil.cov;
  for (let j = 0; j < h; j++) {
    const cj = j + dy; if (cj < 0 || cj >= CAN) continue;
    for (let i = 0; i < w; i++) {
      if (!mask[j * w + i]) continue;
      const ci = i + dx; if (ci < 0 || ci >= CAN) continue;
      inter += cov[cj * CAN + ci];
    }
  }
  return inter / (sil.area + m.area - inter);
}

function bestIoU(sil, m, rad) {
  const dx0 = Math.round(sil.cx - m.cx), dy0 = Math.round(sil.cy - m.cy);
  let best = -1, bx = dx0, by = dy0;
  for (let dy = dy0 - rad; dy <= dy0 + rad; dy++) for (let dx = dx0 - rad; dx <= dx0 + rad; dx++) {
    const v = iouAt(sil, m, dx, dy); if (v > best) { best = v; bx = dx; by = dy; }
  }
  return { iou: best, dx: bx, dy: by };
}

// búsqueda por coordenadas (Hooke-Jeeves simplificado): robusta con funciones "escalonadas"
function coordSearch(f, x0, steps, { maxEvals = 400, lo = null, hi = null, minFrac = 1 / 16 } = {}) {
  const clampv = x => x.map((v, i) => Math.min(hi ? hi[i] : Infinity, Math.max(lo ? lo[i] : -Infinity, v)));
  let x = clampv(x0), fx = f(x), st = steps.slice(), ev = 1;
  const st0 = steps.slice();
  while (ev < maxEvals) {
    let improved = false;
    for (let i = 0; i < x.length && ev < maxEvals; i++) {
      for (const sg of [1, -1]) {
        const xt = x.slice(); xt[i] += sg * st[i]; const xc = clampv(xt);
        if (xc[i] === x[i]) continue;
        const ft = f(xc); ev++;
        if (ft < fx) { x = xc; fx = ft; improved = true; break; }
      }
    }
    if (!improved) { st = st.map(v => v / 2); if (st.every((v, i) => v < st0[i] * minFrac)) break; }
  }
  return { x, fx, evals: ev };
}

// ------------------------------------------------------------- AJUSTE
function framesFrom(atlas, W, json) {
  const fr = [];
  for (const [ang, names] of Object.entries(json.animations)) {
    const name = names[0], f = json.frames[name].frame;
    const mask = new Uint8Array(f.w * f.h);
    for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) mask[j * f.w + i] = atlas[((f.y + j) * W + f.x + i) * 4 + 3] > 0 ? 1 : 0;
    fr.push({ ang: parseFloat(ang), name, f, m: maskInfo(mask, f.w, f.h) });
  }
  return fr.sort((a, b) => a.ang - b.ang);
}

function fitGlobal(frames, tipo, extra, p0, prog) {
  const T = TIPOS[tipo], keys = T.keys;
  const cov = new Float32Array(CAN * CAN);
  const score = v => {
    const p = Object.fromEntries(keys.map((k, i) => [k, v[i]]));
    const parts = buildParts(p, tipo, extra);
    let tot = 0;
    for (const fr of frames) tot += bestIoU(silhouette(parts, fr.ang, 1, 1, cov), fr.m, 1).iou;
    return -tot / frames.length;
  };
  const x0 = keys.map(k => p0[k]);
  const lo = keys.map(k => p0[k] * .6), hi = keys.map(k => p0[k] * 1.5 + (k === 'gf' ? .2 : 0));
  let n = 0;
  const res = coordSearch(v => { const r = score(v); if (++n % 20 === 0) prog && prog(Math.min(n / 400, 1), -r); return r; },
                          x0, keys.map(k => STEPS[k]), { maxEvals: 400, lo, hi });
  return { p: Object.fromEntries(keys.map((k, i) => [k, res.x[i]])), iou: -res.fx, iou0: -score(x0) };
}

function refineFrames(frames, parts, lim, prog) {
  const cov = new Float32Array(CAN * CAN), out = {};
  frames.forEach((fr, idx) => {
    const sc = v => -bestIoU(silhouette(parts, fr.ang + v[0], v[1], v[2], cov), fr.m, 2).iou;
    let best = null;
    for (const d0 of [-5, 0, 5]) {
      const r = coordSearch(sc, [d0, 1, 1], [2, .03, .03], { maxEvals: 70, lo: [-11, lim[0], lim[0]], hi: [11, lim[1], lim[1]] });
      if (!best || r.fx < best.fx) best = r;
    }
    const v = best.x, b = bestIoU(silhouette(parts, fr.ang + v[0], v[1], v[2], cov), fr.m, 2);
    out[fr.name] = { ang: fr.ang, dang: v[0], kx: v[1], ky: v[2], dx: b.dx, dy: b.dy, iou: b.iou };
    prog && prog((idx + 1) / frames.length, b.iou);
  });
  return out;
}

// ------------------------------------------------------------- SDF
function shrinkPoly(prof, r) {
  const n = prof.length, lines = [];
  for (let i = 0; i < n; i++) {
    const a = prof[i], b = prof[(i + 1) % n];
    let ex = b[0] - a[0], ez = b[1] - a[1]; const l = Math.hypot(ex, ez); ex /= l; ez /= l;
    lines.push([a[0] - ez * r, a[1] + ex * r, ex, ez]);   // normal interior (polígono CCW) = (-ez, ex)
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const [px1, pz1, dx1, dz1] = lines[(i + n - 1) % n], [px2, pz2, dx2, dz2] = lines[i];
    const det = dx1 * -dz2 - (-dx2) * dz1;
    const t = ((px2 - px1) * -dz2 - (-dx2) * (pz2 - pz1)) / det;
    out.push([px1 + dx1 * t, pz1 + dz1 * t]);
  }
  return out;
}

function makeSDF(parts) {
  const prep = parts.map(pt => {
    if (pt.kind === 'wheel') return pt;
    const V = shrinkPoly(pt.prof, pt.r);
    return Object.assign({}, pt, { V: V.flat(), n: V.length, hwi: pt.hw - pt.r });
  });
  const solids = prep.filter(q => q.kind !== 'sub'), subs = prep.filter(q => q.kind === 'sub');
  function sdPrism(q, x, y, z) {
    const V = q.V, n = q.n; let d2 = Infinity, inside = true;
    for (let i = 0; i < n; i++) {
      const v0x = V[2 * i], v0z = V[2 * i + 1], j = (i + 1) % n;
      const ex = V[2 * j] - v0x, ez = V[2 * j + 1] - v0z, wx = x - v0x, wz = z - v0z;
      let t = (wx * ex + wz * ez) / (ex * ex + ez * ez); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const bx = wx - ex * t, bz = wz - ez * t, dd = bx * bx + bz * bz;
      if (dd < d2) d2 = dd;
      if (ex * wz - ez * wx < 0) inside = false;
    }
    const dp = (inside ? -1 : 1) * Math.sqrt(d2), dy = Math.abs(y - q.cy) - q.hwi;
    return Math.hypot(Math.max(dp, 0), Math.max(dy, 0)) + Math.min(Math.max(dp, dy), 0) - q.r;
  }
  function sdWheel(q, x, y, z) {
    const dr = Math.hypot(x - q.ax, z - q.rw) - q.rw, dy = Math.abs(y - q.cy) - q.hw;
    return Math.min(Math.max(dr, dy), 0) + Math.hypot(Math.max(dr, 0), Math.max(dy, 0)) - .8;
  }
  return function sdf(x, y, z) {
    let d = 1e9;
    for (const q of solids) { const v = q.kind === 'wheel' ? sdWheel(q, x, y, z) : sdPrism(q, x, y, z); if (v < d) d = v; }
    for (const q of subs) { const v = -sdPrism(q, x, y, z); if (v > d) d = v; }
    return d;
  };
}

// ------------------------------------------------------------- RENDER de un cuadro
function renderFrame(sdf, fp, w, h, SSN) {
  const head = (fp.ang + fp.dang) * Math.PI / 180, c = Math.cos(head), s = Math.sin(head);
  const Z0 = 80, dn = Math.hypot(A, B), ddy = -B / dn, ddz = -A / dn, e = .35;
  const n = w * h, N = new Float32Array(n * 3), Zs = new Float32Array(n), cov = new Float32Array(n);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let nx = 0, ny = 0, nz = 0, zs = 0, hits = 0;
    for (let sj = 0; sj < SSN; sj++) for (let si = 0; si < SSN; si++) {
      const sx = ((i + (si + .5) / SSN) + fp.dx - CAN / 2) / fp.kx;
      const sy = ((j + (sj + .5) / SSN) + fp.dy - CAN / 2) / fp.ky;
      const wy0 = (sy + B * Z0) / A;
      let t = 0, hit = false, lx = 0, ly = 0, z = 0;
      for (let it = 0; it < 220; it++) {
        const Y = wy0 + ddy * t; z = Z0 + ddz * t;
        if (z < -2) break;
        lx = sx * c + Y * s; ly = -sx * s + Y * c;
        const d = sdf(lx, ly, z);
        if (d < .02) { hit = true; break; }
        t += d > .02 ? d : .02;
      }
      if (!hit) continue;
      let gx = sdf(lx + e, ly, z) - sdf(lx - e, ly, z);
      let gy = sdf(lx, ly + e, z) - sdf(lx, ly - e, z);
      let gz = sdf(lx, ly, z + e) - sdf(lx, ly, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1; gx /= gl; gy /= gl; gz /= gl;
      nx += gx * c - gy * s; ny += gx * s + gy * c; nz += gz; zs += z; hits++;
    }
    const k = j * w + i;
    cov[k] = hits / (SSN * SSN);
    if (hits) { N[k * 3] = nx / hits; N[k * 3 + 1] = ny / hits; N[k * 3 + 2] = nz / hits; Zs[k] = zs / hits; }
  }
  return { N, Zs, cov };
}

// ------------------------------------------------------------- utilidades de imagen
function gauss1d(sigma) {
  const r = Math.ceil(4 * sigma), k = [];
  let sum = 0; for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
  return { r, k: k.map(v => v / sum) };
}
function blur(src, w, h, sigma) {
  const { r, k } = gauss1d(sigma), tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const refl = (i, n) => { while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1; return i; };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let s = 0; for (let t = -r; t <= r; t++) s += k[t + r] * src[j * w + refl(i + t, w)]; tmp[j * w + i] = s; }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let s = 0; for (let t = -r; t <= r; t++) s += k[t + r] * tmp[refl(j + t, h) * w + i]; out[j * w + i] = s; }
  return out;
}
function erode(m, w, h, it) {
  let a = m;
  for (let k = 0; k < it; k++) {
    const b = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = j * w + i;
      b[q] = a[q] && i > 0 && a[q - 1] && i < w - 1 && a[q + 1] && j > 0 && a[q - w] && j < h - 1 && a[q + w] ? 1 : 0;
    }
    a = b;
  }
  return a;
}
function detailNormals(rgba, alpha, w, h, strength = .9) {
  const n = w * h, lum = new Float32Array(n), al = new Float32Array(n);
  for (let q = 0; q < n; q++) if (alpha[q]) { lum[q] = (.299 * rgba[q * 4] + .587 * rgba[q * 4 + 1] + .114 * rgba[q * 4 + 2]) / 255; al[q] = 1; }
  const bl = blur(lum, w, h, 1.6), wt = blur(al, w, h, 1.6), inner = erode(alpha, w, h, 2);
  let hp = new Float32Array(n);
  for (let q = 0; q < n; q++) hp[q] = inner[q] ? lum[q] - bl[q] / (wt[q] + 1e-6) : 0;
  hp = blur(hp, w, h, .5);
  const gx = new Float32Array(n), gy = new Float32Array(n), at = (i, j) => hp[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const sx = (at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1));
    const sy = (at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1));
    gx[j * w + i] = -sx / 8 * strength; gy[j * w + i] = -sy / 8 * strength;
  }
  return { gx, gy };
}
// los píxeles inválidos toman el valor del válido más cercano (BFS multi-fuente)
function nearestFill(valid, w, h) {
  const src = new Int32Array(w * h).fill(-1), q = new Int32Array(w * h); let qh = 0, qt = 0;
  for (let k = 0; k < w * h; k++) if (valid[k]) { src[k] = k; q[qt++] = k; }
  while (qh < qt) {
    const k = q[qh++], i = k % w, j = (k / w) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const nk = nj * w + ni; if (src[nk] < 0) { src[nk] = src[k]; q[qt++] = nk; }
    }
  }
  return src;
}

// ------------------------------------------------------------- PROCESO COMPLETO
/**
 * atlas: Uint8ClampedArray RGBA (W x H), json: { frames, animations }
 * opts: { nombre, tipo, extra, ajustarMedidas, calidad (1..3), p0 }
 * prog(fase, frac, info)
 * -> { normal: Uint8ClampedArray, height: Uint8ClampedArray, luz, params }
 */
function process(atlas, W, H, json, opts = {}, prog = () => {}) {
  const g = guessType(opts.nombre || '');
  const tipo = opts.tipo || g.tipo, extra = opts.extra !== undefined ? opts.extra : g.extra;
  const aband = opts.abandonado !== undefined ? opts.abandonado : g.abandonado;
  const frames = framesFrom(atlas, W, json);
  const p0 = Object.assign({}, TIPOS[tipo].p0, opts.p0 || {});
  const doFit = opts.ajustarMedidas !== undefined ? opts.ajustarMedidas : (frames.length >= 12 && !aband);

  let p = p0, fitInfo = null;
  if (doFit) {
    fitInfo = fitGlobal(frames, tipo, extra, p0, (f, iou) => prog('ajuste', f, { iou }));
    p = fitInfo.p;
  }
  prog('ajuste', 1, fitInfo ? { iou: fitInfo.iou } : {});
  const parts = buildParts(p, tipo, extra);
  const lim = aband ? [.94, 1.08] : [.88, 1.12];
  const fps = refineFrames(frames, parts, lim, (f, iou) => prog('refinamiento', f, { iou }));

  const sdf = makeSDF(parts), SSN = opts.calidad || 2;
  const normal = new Uint8ClampedArray(W * H * 4), height = new Uint8ClampedArray(W * H * 4);
  const heightF = new Float32Array(W * H); // WeedJS patch: the heights as floats (px)
  const luz = {
    proyeccion: { a: A, b: B, nota: 'pantalla_x = X ; pantalla_y = a*Y - b*Z (X este, Y sur, Z arriba)' },
    collider: {}, normal_map: 'espacio de mundo: R=+x (derecha), G=+y ARRIBA (norte), B=+z (cielo)',
    altura: 'gris = Z*4 (en px del mundo)', tipo, extra, medidas: p, frames: {},
  };
  const names = Object.keys(json.frames);
  let kxs = 0, nk = 0, covTot = 0;
  names.forEach((name, idx) => {
    const fp = fps[name];
    if (!fp) return;                     // cuadro sin ángulo en "animations"
    const f = json.frames[name].frame, w = f.w, h = f.h, n = w * h;
    const rgba = new Uint8ClampedArray(n * 4), alpha = new Uint8Array(n);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const s = ((f.y + j) * W + f.x + i) * 4, d = (j * w + i) * 4;
      for (let c = 0; c < 4; c++) rgba[d + c] = atlas[s + c];
      alpha[j * w + i] = atlas[s + 3] > 0 ? 1 : 0;
    }
    const R = renderFrame(sdf, fp, w, h, SSN);
    const valid = new Uint8Array(n); let vc = 0, ac = 0;
    for (let q = 0; q < n; q++) { valid[q] = R.cov[q] > .25 ? 1 : 0; if (alpha[q]) { ac++; if (valid[q]) vc++; } }
    covTot += vc / Math.max(ac, 1);
    const src = nearestFill(valid, w, h);
    const det = detailNormals(rgba, alpha, w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = j * w + i, o = ((f.y + j) * W + f.x + i) * 4;
      if (!alpha[q] || src[q] < 0) continue;
      const sq = src[q];
      let nx = R.N[sq * 3], ny = R.N[sq * 3 + 1], nz = R.N[sq * 3 + 2];
      nx += det.gx[q] * nz; ny += det.gy[q] * nz;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      normal[o] = Math.round((nx * .5 + .5) * 255); normal[o + 1] = Math.round((-ny * .5 + .5) * 255);
      normal[o + 2] = Math.round((nz * .5 + .5) * 255); normal[o + 3] = 255;
      const z = Math.max(0, Math.min(255, Math.round(R.Zs[sq] * 4)));
      height[o] = height[o + 1] = height[o + 2] = z; height[o + 3] = 255;
      heightF[(f.y + j) * W + f.x + i] = Math.max(0, R.Zs[sq]); // WeedJS patch
    }
    kxs += fp.kx; nk++;
    luz.frames[name] = { rumbo: +(((fp.ang + fp.dang) % 360 + 360) % 360).toFixed(2),
                         ancla: [CAN / 2 - fp.dx, CAN / 2 - fp.dy], iou: +fp.iou.toFixed(3) };
    prog('render', (idx + 1) / names.length, { cuadro: name });
  });
  luz.collider = { largo: +(p.L * kxs / nk).toFixed(1), ancho: +p.W.toFixed(1) };
  return { normal, height, heightF, luz, params: { tipo, extra, p, fit: fitInfo && { iou0: fitInfo.iou0, iou: fitInfo.iou }, cobertura: covTot / nk } };
}

// ------------------------------------------------------------- ESCALAS (0.5, 0.25)
// Reduce un normal map (y opcionalmente la altura) con promedio ponderado por alpha
// y renormalizando la normal. Devuelve RGBA del tamaño ceil(W*s) x ceil(H*s).
function downscale(normal, height, W, H, s) {
  const k = Math.round(1 / s), w2 = Math.ceil(W / k), h2 = Math.ceil(H / k);
  const nOut = new Uint8ClampedArray(w2 * h2 * 4), hOut = height ? new Uint8ClampedArray(w2 * h2 * 4) : null;
  for (let j = 0; j < h2; j++) for (let i = 0; i < w2; i++) {
    let nx = 0, ny = 0, nz = 0, hz = 0, c = 0;
    for (let dj = 0; dj < k; dj++) for (let di = 0; di < k; di++) {
      const x = i * k + di, y = j * k + dj; if (x >= W || y >= H) continue;
      const o = (y * W + x) * 4; if (!normal[o + 3]) continue;
      nx += normal[o] / 127.5 - 1; ny += normal[o + 1] / 127.5 - 1; nz += normal[o + 2] / 127.5 - 1;
      if (height) hz += height[o]; c++;
    }
    if (!c) continue;
    const l = Math.hypot(nx, ny, nz) || 1, o2 = (j * w2 + i) * 4;
    nOut[o2] = Math.round((nx / l * .5 + .5) * 255); nOut[o2 + 1] = Math.round((ny / l * .5 + .5) * 255);
    nOut[o2 + 2] = Math.round((nz / l * .5 + .5) * 255); nOut[o2 + 3] = 255;
    if (hOut) { hOut[o2] = hOut[o2 + 1] = hOut[o2 + 2] = Math.round(hz / c); hOut[o2 + 3] = 255; }
  }
  return { normal: nOut, height: hOut, w: w2, h: h2 };
}

// ------------------------------------------------------------- MODO RELIEVE (personajes, árboles, props)
// Para sprites de una sola vista (LPC, árboles): no hay modelo 3D, se infla la silueta.
// Cada parte se redondea según su grosor (brazos y troncos = cilindros, torso o copa = cúpula),
// se suma el detalle del dibujo y las normales pasan de pantalla a mundo con la inclinación
// de la cámara. La altura es "cuántos px por encima del piso" (el sprite es una tarjeta vertical).

// transformada de distancia euclídea exacta (Felzenszwalb) sobre una grilla w x h
function edt(mask, w, h) {
  const INF = 1e20, f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const g = new Float64Array(w * h);
  for (let q = 0; q < w * h; q++) g[q] = mask[q] ? INF : 0;
  const pass = (n, get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; set(q, d[q]); }
  };
  for (let x = 0; x < w; x++) pass(h, y => g[y * w + x], (y, val) => { g[y * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, x => g[y * w + x], (x, val) => { g[y * w + x] = val; });
  for (let q = 0; q < w * h; q++) g[q] = Math.sqrt(g[q]);
  return g;
}
function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let m = 0; for (let t = Math.max(0, i - r); t <= Math.min(w - 1, i + r); t++) m = Math.max(m, src[j * w + t]); tmp[j * w + i] = m; }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let m = 0; for (let t = Math.max(0, j - r); t <= Math.min(h - 1, j + r); t++) m = Math.max(m, tmp[t * w + i]); out[j * w + i] = m; }
  return out;
}

const PERFILES = {
  // forma: 'inflado' (silueta inflada) | 'caja' (caja isométrica ajustada a la silueta)
  // sfs: peso de la "forma desde el sombreado" pintado; cerrar: tapar huecos (copas); suave: sigma del suavizado
  personaje: { forma: 'inflado', elev: 28, radioVecino: 5,  radioMax: 9,  redondez: 1.0, detalle: 0.5, sfs: 0.3,  cerrar: 0, suave: 1.0, profundidad: 1 },
  arbol:     { forma: 'inflado', elev: 35, radioVecino: 64, radioMax: 85, redondez: 0.95, detalle: 0.25, sfs: 0.35, cerrar: 3, suave: 2.5, profundidad: 1 },
  prop:      { forma: 'inflado', elev: 35, radioVecino: 14, radioMax: 22, redondez: 0.9, detalle: 0.15, sfs: 0.85, cerrar: 1, suave: 1.4, profundidad: 1 },
  caja:      { forma: 'caja',    elev: 35, detalle: 0.25, sfs: 0.3, suave: 1.0 },
};

function binDilate(m, w, h, r) { const f = new Float32Array(w * h); for (let q = 0; q < w * h; q++) f[q] = m[q]; const o = maxFilter(f, w, h, r), out = new Uint8Array(w * h); for (let q = 0; q < w * h; q++) out[q] = o[q] > 0 ? 1 : 0; return out; }
function binErode(m, w, h, r) { const inv = new Uint8Array(w * h); for (let q = 0; q < w * h; q++) inv[q] = m[q] ? 0 : 1; const d = binDilate(inv, w, h, r), out = new Uint8Array(w * h); for (let q = 0; q < w * h; q++) out[q] = d[q] ? 0 : 1; return out; }
function fillHoles(m, w, h) {
  const out = Uint8Array.from(m), seen = new Uint8Array(w * h), st = [];
  for (let i = 0; i < w; i++) { st.push(i, (h - 1) * w + i); } for (let j = 0; j < h; j++) { st.push(j * w, j * w + w - 1); }
  while (st.length) { const q = st.pop(); if (seen[q] || m[q]) continue; seen[q] = 1; const i = q % w, j = (q / w) | 0;
    if (i > 0) st.push(q - 1); if (i < w - 1) st.push(q + 1); if (j > 0) st.push(q - w); if (j < h - 1) st.push(q + w); }
  for (let q = 0; q < w * h; q++) if (!m[q] && !seen[q]) out[q] = 1;
  return out;
}
// resolver un sistema lineal chico (eliminación gaussiana)
function solve(M, v) {
  const n = v.length, a = M.map((r, i) => r.concat([v[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]]; if (Math.abs(a[c][c]) < 1e-9) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
  }
  return a.map((r, i) => r[n] / r[i]);
}
// caja isométrica (2:1): esquina frontal de abajo (cx,cy), anchos de pantalla wl (izq) y wr (der), alto hs
function cajaHex(c) {
  const { cx, cy, wl, wr, hs } = c;
  return [[cx, cy], [cx - wl, cy - wl / 2], [cx - wl, cy - wl / 2 - hs], [cx - wl + wr, cy - (wl + wr) / 2 - hs], [cx + wr, cy - wr / 2 - hs], [cx + wr, cy - wr / 2]];
}
function insidePoly(P, x, y) { let s = 0; for (let i = 0; i < P.length; i++) { const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length]; const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1); if (c > 1e-9) s |= 1; else if (c < -1e-9) s |= 2; if (s === 3) return false; } return true; }
function fitCaja(mask, w, h) {
  let x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (mask[j * w + i]) { x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j); area++; }
  const W0 = x1 - x0 + 1;
  const score = v => {
    const c = { cx: v[0], cy: v[1], wl: v[2], wr: v[3], hs: v[4] }; if (c.wl < 2 || c.wr < 2 || c.hs < 2) return 1;
    const P = cajaHex(c); let inter = 0, ins = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const a = insidePoly(P, i + .5, j + .5); if (a) { ins++; if (mask[j * w + i]) inter++; } }
    return -inter / (ins + area - inter);
  };
  let best = null;
  for (const f of [.35, .5, .65]) {
    const wl = W0 * f, wr = W0 - wl, x0c = x0 + wl;
    const r = coordSearch(score, [x0c, y1 + 1, wl, wr, (y1 - y0) * .55], [2, 2, 2, 2, 2], { maxEvals: 260, minFrac: 1 / 8 });
    if (!best || r.fx < best.fx) best = r;
  }
  const v = best.x; return { cx: v[0], cy: v[1], wl: v[2], wr: v[3], hs: v[4], iou: -best.fx };
}

/**
 * Relieve para sprites de UNA vista (personajes LPC, árboles, props, cajas isométricas).
 * json: { frames: { nombre: { frame:{x,y,w,h} } } }   opts: { perfil, base, ...overrides }
 */
function processRelieve(atlas, W, H, json, opts = {}, prog = () => {}) {
  const perfil = opts.perfil || 'personaje';
  const P = Object.assign({}, PERFILES[perfil], opts);
  const e = P.elev * Math.PI / 180, ce = Math.cos(e), se = Math.sin(e);
  const vn = Math.hypot(A, B), VZ = A / vn;               // dirección "hacia la cámara" de la proyección del mundo: (0, B, A)/vn
  const names = Object.keys(json.frames);
  const aMin = P.alphaMin !== undefined ? P.alphaMin : 100;
  // fila de los pies: la más común entre los cuadros (así las animaciones no "rebotan")
  let base = P.base;
  if (base === undefined) {
    const cnt = {};
    for (const n of names) {
      const f = json.frames[n].frame; let b = -1;
      for (let j = f.h - 1; j >= 0 && b < 0; j--) for (let i = 0; i < f.w; i++) if (atlas[((f.y + j) * W + f.x + i) * 4 + 3] >= aMin) { b = j; break; }
      if (b >= 0) cnt[b] = (cnt[b] || 0) + 1;
    }
    base = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0] + 1;
  }
  const normal = new Uint8ClampedArray(W * H * 4), heightF = new Float32Array(W * H);
  const frames = {}; let zMax = 0; const pieAncho = []; let cajaInfo = null, luzPintada = null;
  names.forEach((name, idx) => {
    const f = json.frames[name].frame, w = f.w, h = f.h, n = w * h;
    const rgba = new Uint8ClampedArray(n * 4), alpha = new Uint8Array(n), soft = new Uint8Array(n); let any = false;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const s = ((f.y + j) * W + f.x + i) * 4, q = j * w + i;
      for (let c = 0; c < 4; c++) rgba[q * 4 + c] = atlas[s + c];
      if (atlas[s + 3] >= aMin) { alpha[q] = 1; any = true; } else if (atlas[s + 3]) soft[q] = 1;
    }
    if (!any) return;
    const NX = new Float32Array(n), NY = new Float32Array(n), NZ = new Float32Array(n), Zw = new Float32Array(n);
    const det = detailNormals(rgba, alpha, w, h, P.detalle);
    let ancla = [w / 2, base];

    if (P.forma === 'caja') {
      // ---- CAJA ISOMÉTRICA: tres caras con su normal real (arriba, frente izquierdo, frente derecho)
      const c = fitCaja(alpha, w, h); cajaInfo = c;
      const r2 = Math.SQRT1_2;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const q = j * w + i; if (!alpha[q]) continue;
        const x = i + .5, y = j + .5;
        // ¿techo? (z = hs): resolvemos p,q en el rombo superior
        const pp = (2 * (c.cy - c.hs - y) - (x - c.cx)) / 2, qq = (x - c.cx) + pp;
        let nx, ny, nz, zs;
        if (pp >= -1 && pp <= c.wl + 1 && qq >= -1 && qq <= c.wr + 1) { nx = 0; ny = 0; nz = 1; zs = c.hs; }
        else if (x < c.cx) { const p = c.cx - x; zs = clampN(c.cy - p / 2 - y, 0, c.hs); nx = -r2; ny = r2; nz = 0; }
        else { const qv = x - c.cx; zs = clampN(c.cy - qv / 2 - y, 0, c.hs); nx = r2; ny = r2; nz = 0; }
        // detalle del dibujo, en la base de pantalla (derecha, abajo)
        nx += det.gx[q]; ny += det.gy[q] * se; nz += -det.gy[q] * ce;
        const l = Math.hypot(nx, ny, nz); NX[q] = nx / l; NY[q] = ny / l; NZ[q] = nz / l; Zw[q] = zs / B;
      }
      ancla = [c.cx + (c.wr - c.wl) / 2, c.cy - (c.wl + c.wr) / 4];
    } else {
      // ---- INFLADO: cada parte se redondea según su grosor
      let m = alpha;
      if (P.cerrar > 0) m = fillHoles(binErode(binDilate(alpha, w, h, P.cerrar), w, h, P.cerrar), w, h);
      const d = edt(m, w, h);
      const T = maxFilter(Float32Array.from(d), w, h, P.radioVecino);
      const D = new Float32Array(n), al = new Float32Array(n);
      for (let q = 0; q < n; q++) {
        if (!m[q]) continue;
        const t = Math.min(Math.max(T[q], 1), P.radioMax), x = Math.min(d[q], t) / t;
        D[q] = P.redondez * t * Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x))); al[q] = 1;
      }
      const Db = blur(D, w, h, P.suave), Wb = blur(al, w, h, P.suave);
      for (let q = 0; q < n; q++) D[q] = m[q] ? Db[q] / Math.max(Wb[q], 1e-3) : 0;
      const Dat = (i, j, q0) => (i < 0 || j < 0 || i >= w || j >= h || !m[j * w + i]) ? D[q0] : D[j * w + i];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const q = j * w + i; if (!alpha[q]) continue;
        const gx = (Dat(i + 1, j, q) - Dat(i - 1, j, q)) * .5, gy = (Dat(i, j + 1, q) - Dat(i, j - 1, q)) * .5;
        let sx = -gx + det.gx[q], sy = -gy + det.gy[q], sz = 1;
        const l = Math.hypot(sx, sy, sz); sx /= l; sy /= l; sz /= l;
        NX[q] = sx; NY[q] = sy * se + sz * ce; NZ[q] = -sy * ce + sz * se;      // pantalla -> mundo
        // altura: tarjeta vertical apoyada en la fila 'base' + la PROFUNDIDAD del volumen (lo que se
        // abomba hacia la cámara queda más adelante y más arriba; la altura deja de ser lineal)
        Zw[q] = Math.max(0, (base - (j + .5)) / B + P.profundidad * D[q] * VZ);
      }
    }

    // ---- FORMA DESDE EL SOMBREADO PINTADO: estimamos la luz del artista y giramos cada normal
    //      hasta que su ángulo con esa luz explique el brillo dibujado (facetas, pliegues).
    if (P.sfs > 0) {
      const I = new Float32Array(n);
      for (let q = 0; q < n; q++) if (alpha[q]) I[q] = Math.max(rgba[q * 4], rgba[q * 4 + 1], rgba[q * 4 + 2]) / 255;
      const Is = new Float32Array(n);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {      // suavizado que respeta bordes de facetas
        const q = j * w + i; if (!alpha[q]) continue; let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= w || b >= h) continue; const k = b * w + a; if (alpha[k] && Math.abs(I[k] - I[q]) < .1) { s += I[k]; c++; } }
        Is[q] = s / c;
      }
      const inner = erode(alpha, w, h, 1);
      // mínimos cuadrados: I ≈ v·N + c  ->  luz = v/|v|, contraste k = |v|
      const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], rhs = [0, 0, 0, 0];
      for (let q = 0; q < n; q++) {
        if (!inner[q] || Is[q] < .08) continue;
        const F = [NX[q], NY[q], NZ[q], 1];
        for (let a = 0; a < 4; a++) { rhs[a] += F[a] * Is[q]; for (let b = 0; b < 4; b++) M[a][b] += F[a] * F[b]; }
      }
      for (let a = 0; a < 4; a++) M[a][a] += 1e-3;
      const sol = solve(M, rhs);
      if (sol) {
        const k = Math.hypot(sol[0], sol[1], sol[2]);
        if (k > .05) {
          const L = [sol[0] / k, sol[1] / k, sol[2] / k]; luzPintada = L.map(v => +v.toFixed(3));
          for (let q = 0; q < n; q++) {
            if (!alpha[q] || !inner[q] || Is[q] < .08) continue;
            const ct = clampN((Is[q] - sol[3]) / k, -.98, .98);
            const nd = NX[q] * L[0] + NY[q] * L[1] + NZ[q] * L[2];
            let ux = NX[q] - nd * L[0], uy = NY[q] - nd * L[1], uz = NZ[q] - nd * L[2];
            const ul = Math.hypot(ux, uy, uz); if (ul < 1e-4) continue; ux /= ul; uy /= ul; uz /= ul;
            const st = Math.sqrt(1 - ct * ct);
            let sx = ct * L[0] + st * ux, sy = ct * L[1] + st * uy, sz = ct * L[2] + st * uz;
            if (sy * B + sz * A < .05) continue;                     // tiene que seguir mirando a la cámara
            const wgt = P.sfs;
            let nx = NX[q] + (sx - NX[q]) * wgt, ny = NY[q] + (sy - NY[q]) * wgt, nz = NZ[q] + (sz - NZ[q]) * wgt;
            const l = Math.hypot(nx, ny, nz); NX[q] = nx / l; NY[q] = ny / l; NZ[q] = nz / l;
          }
        }
      }
    }

    // ---- escribir + bordes semitransparentes copian al opaco más cercano
    const src = nearestFill(alpha, w, h);
    let bl = 1e9, br = -1e9;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = j * w + i; if (!alpha[q] && !soft[q]) continue;
      const sq = alpha[q] ? q : src[q]; if (sq < 0) continue;
      const o = ((f.y + j) * W + f.x + i) * 4;
      normal[o] = Math.round((NX[sq] * .5 + .5) * 255); normal[o + 1] = Math.round((-NY[sq] * .5 + .5) * 255);
      normal[o + 2] = Math.round((NZ[sq] * .5 + .5) * 255); normal[o + 3] = 255;
      const z = Zw[sq]; heightF[(f.y + j) * W + f.x + i] = z; if (z > zMax) zMax = z;
      if (alpha[q] && j >= base - 4 && j < base) { bl = Math.min(bl, i); br = Math.max(br, i); }
    }
    if (br > bl) pieAncho.push(br - bl + 1);
    frames[name] = { ancla };
    prog('relieve', (idx + 1) / names.length, { cuadro: name });
  });
  const escala = Math.min(4, 255 / Math.max(zMax, 1));
  const height = new Uint8ClampedArray(W * H * 4);
  for (let q = 0; q < W * H; q++) if (normal[q * 4 + 3]) { const v = Math.round(heightF[q] * escala); height[q * 4] = height[q * 4 + 1] = height[q * 4 + 2] = v; height[q * 4 + 3] = 255; }
  pieAncho.sort((a, b) => a - b);
  const ancho = Math.max(8, pieAncho.length ? pieAncho[pieAncho.length >> 1] : 16);
  let collider = { tipo: 'elipse', rx: +(ancho * .5).toFixed(1), ry: +(ancho * .3).toFixed(1) };
  if (cajaInfo) {
    // huella de la caja en el piso (relativa al ancla), en coords de piso
    const c = cajaInfo, ax = c.cx + (c.wr - c.wl) / 2, ay = c.cy - (c.wl + c.wr) / 4;
    const pts = [[c.cx, c.cy], [c.cx - c.wl, c.cy - c.wl / 2], [c.cx - c.wl + c.wr, c.cy - (c.wl + c.wr) / 2], [c.cx + c.wr, c.cy - c.wr / 2]];
    collider = { tipo: 'poligono', puntos: pts.map(([x, y]) => [+(x - ax).toFixed(1), +((y - ay) / A).toFixed(1)]) };
  }
  const luz = {
    modo: 'relieve', perfil, volumen: P.forma === 'caja' ? 'real' : 'tarjeta',
    proyeccion: { a: A, b: B, elevacion_camara: P.elev },
    normal_map: 'espacio de mundo: R=+x (derecha), G=+y ARRIBA (norte), B=+z (cielo)',
    altura: `gris = Z*${+escala.toFixed(3)} (px del mundo sobre el piso)`, altura_escala: +escala.toFixed(4),
    base, collider, luz_pintada_estimada: luzPintada, caja: cajaInfo && Object.fromEntries(Object.entries(cajaInfo).map(([k, v]) => [k, +v.toFixed(2)])),
    frames,
  };
  return { normal, height, heightF, luz }; // WeedJS patch: heightF
}
const clampN = (x, a, b) => x < a ? a : x > b ? b : x;

const NM = { A, B, CAN, TIPOS, PERFILES, guessType, buildParts, silhouette, process, processRelieve, downscale };
if (typeof module !== 'undefined' && module.exports) module.exports = NM;
else root.NM = NM;
})(typeof self !== 'undefined' ? self : this);
