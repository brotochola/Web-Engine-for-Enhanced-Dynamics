// Marching squares + island BFS + simplify2 + Delaunay (contour mode from the HTML prototype).
// Grid is material (uint8) + amount (float 0..1). Solid node: amount >= ISO.

import Delaunator from './vendor/delaunator.js';
import { diff as martinezDiff, union as martinezUnion } from './vendor/martinez.js';
import simplify2 from './vendor/simplify2.js';

const CLIP_SIMPLIFY_TOL = 4;

export const ISO = 0.1;
export const MAT_NONE = 0;
export const MAT_DIRT = 1;
export const MAT_ROCK = 2;
export const MAT_TINT = [0, 0xc4a574, 0x8a9099];

const MS_CASES = {
  0: [], 15: [],
  1: [[3, 2]], 14: [[3, 2]],
  2: [[2, 1]], 13: [[2, 1]],
  3: [[3, 1]], 12: [[3, 1]],
  4: [[0, 1]], 11: [[0, 1]],
  5: [[0, 3], [2, 1]],
  6: [[0, 2]], 9: [[0, 2]],
  7: [[0, 3]], 8: [[0, 3]],
  10: [[0, 1], [2, 3]],
};

export class TerrainField {
  constructor(cols, rows, cellSize) {
    this.cols = cols;
    this.rows = rows;
    this.cellSize = cellSize;
    this.msCols = cols - 1;
    this.msRows = rows - 1;
    this.amount = new Float32Array(cols * rows);
    this.material = new Uint8Array(cols * rows);
    this.dirty = false;
    this.dirtyMinX = cols;
    this.dirtyMinY = rows;
    this.dirtyMaxX = -1;
    this.dirtyMaxY = -1;
  }

  idx(x, y) {
    return y * this.cols + x;
  }

  node(x, y) {
    return this.amount[y * this.cols + x];
  }

  markDirty(x, y) {
    this.dirty = true;
    if (x < this.dirtyMinX) this.dirtyMinX = x;
    if (y < this.dirtyMinY) this.dirtyMinY = y;
    if (x > this.dirtyMaxX) this.dirtyMaxX = x;
    if (y > this.dirtyMaxY) this.dirtyMaxY = y;
  }

  markAllDirty() {
    this.dirty = true;
    this.dirtyMinX = 0;
    this.dirtyMinY = 0;
    this.dirtyMaxX = this.cols - 1;
    this.dirtyMaxY = this.rows - 1;
  }

  consumeDirty(pad = 1) {
    if (!this.dirty) return null;
    const box = {
      minX: Math.max(0, this.dirtyMinX - pad),
      minY: Math.max(0, this.dirtyMinY - pad),
      maxX: Math.min(this.cols - 1, this.dirtyMaxX + pad),
      maxY: Math.min(this.rows - 1, this.dirtyMaxY + pad),
    };
    this.dirty = false;
    this.dirtyMinX = this.cols;
    this.dirtyMinY = this.rows;
    this.dirtyMaxX = -1;
    this.dirtyMaxY = -1;
    return box;
  }

  setAmount(x, y, value, material) {
    const idx = y * this.cols + x;
    const next = clamp01(value);
    if (this.amount[idx] === next && (material == null || this.material[idx] === material)) {
      return false;
    }
    this.amount[idx] = next;
    if (next <= 0) this.material[idx] = MAT_NONE;
    else if (material != null) this.material[idx] = material;
    this.markDirty(x, y);
    return true;
  }

  clearIslandNodes(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const idx = n.y * this.cols + n.x;
      this.amount[idx] = 0;
      this.material[idx] = MAT_NONE;
    }
  }

  seedPlatforms() {
    this.amount.fill(0);
    this.material.fill(0);
    const thick = Math.max(3, Math.floor(this.rows * 0.04));
    const y1 = this.rows - 2;
    const y0 = Math.max(0, y1 - thick);
    const margin = Math.max(2, Math.floor(this.cols * 0.05));
    for (let y = y0; y < y1; y++) {
      for (let x = margin; x < this.cols - margin; x++) {
        this.amount[y * this.cols + x] = 1;
        this.material[y * this.cols + x] = MAT_DIRT;
      }
    }
    const midY = Math.floor(this.rows * 0.55);
    for (let y = midY; y < midY + 2; y++) {
      for (let x = Math.floor(this.cols * 0.2); x < Math.floor(this.cols * 0.45); x++) {
        this.amount[y * this.cols + x] = 1;
        this.material[y * this.cols + x] = MAT_ROCK;
      }
    }
    const midY2 = Math.floor(this.rows * 0.35);
    for (let y = midY2; y < midY2 + 2; y++) {
      for (let x = Math.floor(this.cols * 0.55); x < Math.floor(this.cols * 0.8); x++) {
        this.amount[y * this.cols + x] = 1;
        this.material[y * this.cols + x] = MAT_DIRT;
      }
    }
    this.markAllDirty();
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function interp(x0, y0, v0, x1, y1, v1) {
  const dv = v1 - v0;
  if (Math.abs(dv) < 1e-6) return { x: x0, y: y0 };
  const t = (ISO - v0) / dv;
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
}

function cellCorners(field, cx, cy) {
  const cs = field.cellSize;
  const x0 = cx * cs;
  const y0 = cy * cs;
  const x1 = x0 + cs;
  const y1 = y0 + cs;
  const tl = field.node(cx, cy);
  const tr = field.node(cx + 1, cy);
  const br = field.node(cx + 1, cy + 1);
  const bl = field.node(cx, cy + 1);
  const a = tl >= ISO ? 1 : 0;
  const b = tr >= ISO ? 1 : 0;
  const c = br >= ISO ? 1 : 0;
  const d = bl >= ISO ? 1 : 0;
  const caseId = a * 8 + b * 4 + c * 2 + d;
  const edges = [
    interp(x0, y0, tl, x1, y0, tr),
    interp(x1, y0, tr, x1, y1, br),
    interp(x0, y1, bl, x1, y1, br),
    interp(x0, y0, tl, x0, y1, bl),
  ];
  return {
    caseId,
    edges,
    TL: { x: x0, y: y0 },
    TR: { x: x1, y: y0 },
    BR: { x: x1, y: y1 },
    BL: { x: x0, y: y1 },
  };
}

function cellSolidParts(field, cx, cy) {
  const c = cellCorners(field, cx, cy);
  const { caseId, edges, TL, TR, BR, BL } = c;
  const [T, R, B, L] = edges;
  const nTL = { x: cx, y: cy };
  const nTR = { x: cx + 1, y: cy };
  const nBR = { x: cx + 1, y: cy + 1 };
  const nBL = { x: cx, y: cy + 1 };
  const part = (verts, solidNodes) => ({ verts, solidNodes });
  switch (caseId) {
    case 0: return [];
    case 1: return [part([BL, B, L], [nBL])];
    case 2: return [part([BR, R, B], [nBR])];
    case 3: return [part([BL, BR, R, L], [nBL, nBR])];
    case 4: return [part([TR, R, T], [nTR])];
    case 5: return [part([TR, R, T], [nTR]), part([BL, B, L], [nBL])];
    case 6: return [part([TR, BR, B, T], [nTR, nBR])];
    case 7: return [part([TR, BR, BL, L, T], [nTR, nBR, nBL])];
    case 8: return [part([TL, T, L], [nTL])];
    case 9: return [part([TL, T, B, BL], [nTL, nBL])];
    case 10: return [part([TL, T, L], [nTL]), part([BR, R, B], [nBR])];
    case 11: return [part([TL, T, R, BR, BL], [nTL, nBR, nBL])];
    case 12: return [part([TL, TR, R, L], [nTL, nTR])];
    case 13: return [part([TL, TR, R, B, BL], [nTL, nTR, nBL])];
    case 14: return [part([TL, TR, BR, B, L], [nTL, nTR, nBR])];
    case 15: return [part([TL, TR, BR, BL], [nTL, nTR, nBR, nBL])];
    default: return [];
  }
}

function cellSegments(field, cx, cy) {
  const c = cellCorners(field, cx, cy);
  const segs = MS_CASES[c.caseId] || [];
  return segs.map(([i, j]) => [c.edges[i], c.edges[j]]);
}

export function polygonArea(vertices) {
  if (!vertices || vertices.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length;
    area += vertices[i].x * vertices[j].y;
    area -= vertices[j].x * vertices[i].y;
  }
  return Math.abs(area) * 0.5;
}

/** Point-in-convex. Works for CW or CCW. On-edge counts as inside. */
export function pointInConvex(pts, x, y) {
  const n = pts ? pts.length : 0;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross > -1e-8 && cross < 1e-8) continue;
    const s = cross > 0 ? 1 : -1;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Recurse-split a convex poly until each piece area <= minArea or dest hits maxOut.
 * Tris split at midpoints (4 kids). 4+ verts split on a diagonal.
 */
export function subdivideConvex(poly, minArea, maxOut, out) {
  const dest = out || [];
  if (!poly || poly.length < 3 || dest.length >= maxOut) return dest;
  _subdivideConvex(poly, minArea, maxOut, dest);
  return dest;
}

const CARVE_MAX_DEPTH = 16;

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function copyPt(p) {
  return { x: p.x, y: p.y };
}

function midPt(a, b) {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function splitTriLongestEdge(tri) {
  const a = tri[0];
  const b = tri[1];
  const c = tri[2];
  const ab = dist2(a, b);
  const bc = dist2(b, c);
  const ca = dist2(c, a);
  if (ab >= bc && ab >= ca) {
    const m = midPt(a, b);
    return [[copyPt(a), m, copyPt(c)], [copyPt(m), copyPt(b), copyPt(c)]];
  }
  if (bc >= ca) {
    const m = midPt(b, c);
    return [[copyPt(b), m, copyPt(a)], [copyPt(m), copyPt(c), copyPt(a)]];
  }
  const m = midPt(c, a);
  return [[copyPt(c), m, copyPt(b)], [copyPt(m), copyPt(a), copyPt(b)]];
}

function splitPoly2(poly) {
  if (poly.length === 3) return splitTriLongestEdge(poly);
  const ear = [copyPt(poly[0]), copyPt(poly[1]), copyPt(poly[2])];
  const rest = [copyPt(poly[0]), copyPt(poly[2])];
  for (let i = 3; i < poly.length; i++) rest.push(copyPt(poly[i]));
  return [ear, rest];
}

/**
 * Mamushka carve: bisect only the child that contains (x,y) until that leaf
 * is below vanishArea. Siblings stay. Hit leaf goes to drop.
 */
export function carveConvexAtPoint(poly, x, y, vanishArea) {
  const keep = [];
  const drop = [];
  _carveConvexAtPoint(poly, x, y, vanishArea, 0, keep, drop);
  return { keep, drop };
}

function _carveConvexAtPoint(poly, x, y, vanishArea, depth, keep, drop) {
  if (!poly || poly.length < 3) return;
  const area = polygonArea(poly);
  if (area <= 1e-8) return;
  if (area < vanishArea) {
    drop.push(poly);
    return;
  }
  if (depth >= CARVE_MAX_DEPTH) {
    keep.push(poly);
    return;
  }
  const kids = splitPoly2(poly);
  let hitIdx = -1;
  for (let i = 0; i < kids.length; i++) {
    if (pointInConvex(kids[i], x, y)) {
      hitIdx = i;
      break;
    }
  }
  if (hitIdx < 0) hitIdx = 0;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    const a = polygonArea(kid);
    if (a <= 1e-8) continue;
    if (i === hitIdx) _carveConvexAtPoint(kid, x, y, vanishArea, depth + 1, keep, drop);
    else keep.push(kid);
  }
}

/**
 * Split a convex poly; the child that contains (x,y) goes to drop, the rest to keep.
 * If the point misses every child (edge cases), first child is dropped.
 */
export function splitConvexAtPoint(poly, x, y, minArea, maxOut) {
  const kids = [];
  subdivideConvex(poly, minArea, maxOut, kids);
  const keep = [];
  const drop = [];
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (!drop.length && pointInConvex(kid, x, y)) drop.push(kid);
    else keep.push(kid);
  }
  if (!drop.length && kids.length) {
    drop.push(kids[0]);
    if (keep.length && keep[0] === kids[0]) keep.shift();
  }
  return { keep, drop };
}

function _subdivideConvex(poly, minArea, maxOut, dest) {
  if (dest.length >= maxOut) return;
  const area = polygonArea(poly);
  if (!(area > minArea) || poly.length < 3) {
    dest.push(poly);
    return;
  }
  if (poly.length === 3) {
    if (maxOut - dest.length < 4) {
      dest.push(poly);
      return;
    }
    const a = poly[0];
    const b = poly[1];
    const c = poly[2];
    const ab = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    const bc = { x: (b.x + c.x) * 0.5, y: (b.y + c.y) * 0.5 };
    const ca = { x: (c.x + a.x) * 0.5, y: (c.y + a.y) * 0.5 };
    _subdivideConvex([a, ab, ca], minArea, maxOut, dest);
    _subdivideConvex([ab, b, bc], minArea, maxOut, dest);
    _subdivideConvex([ca, bc, c], minArea, maxOut, dest);
    _subdivideConvex([ab, bc, ca], minArea, maxOut, dest);
    return;
  }
  if (maxOut - dest.length < 2) {
    dest.push(poly);
    return;
  }
  const mid = poly.length >> 1;
  const left = poly.slice(0, mid + 1);
  const right = poly.slice(mid);
  right.push(poly[0]);
  _subdivideConvex(left, minArea, maxOut, dest);
  _subdivideConvex(right, minArea, maxOut, dest);
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a * 0.5;
}

function ptKey(p) {
  return `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`;
}

function stitchContours(segments) {
  if (!segments.length) return [];
  const adj = new Map();
  const points = new Map();
  const addEdge = (a, b) => {
    const ka = ptKey(a);
    const kb = ptKey(b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ key: kb, p: b });
    adj.get(kb).push({ key: ka, p: a });
  };
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i];
    points.set(ptKey(a), a);
    points.set(ptKey(b), b);
    addEdge(a, b);
  }

  const used = new Set();
  const loops = [];
  for (const startKey of adj.keys()) {
    const neighs = adj.get(startKey);
    for (let n = 0; n < neighs.length; n++) {
      const neigh = neighs[n];
      const edgeId = startKey < neigh.key ? `${startKey}|${neigh.key}` : `${neigh.key}|${startKey}`;
      if (used.has(edgeId)) continue;

      const loop = [points.get(startKey)];
      let prev = startKey;
      let curr = neigh.key;
      used.add(edgeId);
      loop.push(points.get(curr));

      let guard = 0;
      while (curr !== startKey && guard++ < 10000) {
        const options = adj.get(curr) || [];
        let next = null;
        for (let o = 0; o < options.length; o++) {
          const opt = options[o];
          if (opt.key === prev) continue;
          const eid = curr < opt.key ? `${curr}|${opt.key}` : `${opt.key}|${curr}`;
          if (used.has(eid)) continue;
          next = opt;
          used.add(eid);
          break;
        }
        if (!next) break;
        prev = curr;
        curr = next.key;
        if (curr !== startKey) loop.push(points.get(curr));
      }
      if (loop.length >= 3 && curr === startKey) loops.push(loop);
    }
  }
  return loops;
}

function cleanContour(contour) {
  const pts = [];
  for (let i = 0; i < contour.length; i++) {
    const p = contour[i];
    if (!pts.length) {
      pts.push({ x: p.x, y: p.y });
      continue;
    }
    const prev = pts[pts.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) < 0.05) continue;
    pts.push({ x: p.x, y: p.y });
  }
  if (pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.05) pts.pop();
  }
  return pts;
}

function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function closedRing(pts) {
  const ring = [];
  for (let i = 0; i < pts.length; i++) ring.push([pts[i].x, pts[i].y]);
  if (!ring.length) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
  return ring;
}

function ringToPts(ring) {
  const pts = [];
  if (!ring || ring.length < 2) return pts;
  const last = ring.length - 1;
  const closed = ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
  const n = closed ? last : ring.length;
  for (let i = 0; i < n; i++) pts.push({ x: ring[i][0], y: ring[i][1] });
  return pts;
}

function asMulti(geom) {
  if (!geom || !geom.length) return [];
  if (typeof geom[0][0][0] === 'number') return [geom];
  return geom;
}

function gjPolygonArea(poly) {
  if (!poly || !poly.length) return 0;
  let a = polygonArea(ringToPts(poly[0]));
  for (let i = 1; i < poly.length; i++) a -= polygonArea(ringToPts(poly[i]));
  return a;
}

function pointInSolid(px, py, outer, holes) {
  if (!pointInPolygon(px, py, outer)) return false;
  for (let i = 0; i < holes.length; i++) {
    if (pointInPolygon(px, py, holes[i])) return false;
  }
  return true;
}

export function circleRing(cx, cy, r, n = 8) {
  const ring = [];
  const sides = n < 8 ? 8 : n;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

export function unionConvexPolys(polys) {
  if (!polys || !polys.length) return [];
  let acc = null;
  for (let i = 0; i < polys.length; i++) {
    const pts = polys[i];
    if (!pts || pts.length < 3) continue;
    const next = [closedRing(pts)];
    if (!acc) {
      acc = next;
      continue;
    }
    try {
      acc = martinezUnion(acc, next);
    } catch {
      return [];
    }
    if (!acc || !acc.length) return [];
  }
  return asMulti(acc);
}

export function diffCircle(outline, cx, cy, r, sides = 8) {
  const multi = asMulti(outline);
  if (!multi.length || !(r > 0)) return [];
  const clip = [circleRing(cx, cy, r, sides)];
  let out;
  try {
    out = martinezDiff(multi, clip);
  } catch {
    return [];
  }
  return asMulti(out);
}

export function triangulateDelaunay(outerPts, holesPts) {
  const holes = holesPts || [];
  const pts = [];
  const seen = new Set();
  const pushPt = (p) => {
    const k = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
    if (seen.has(k)) return;
    seen.add(k);
    pts.push([p.x, p.y]);
  };
  for (let i = 0; i < outerPts.length; i++) pushPt(outerPts[i]);
  for (let h = 0; h < holes.length; h++) {
    for (let i = 0; i < holes[h].length; i++) pushPt(holes[h][i]);
  }
  if (pts.length < 3) return [];
  let del;
  try {
    del = Delaunator.from(pts);
  } catch {
    return [];
  }
  const idx = del.triangles;
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = pts[idx[i]];
    const b = pts[idx[i + 1]];
    const c = pts[idx[i + 2]];
    const mx = (a[0] + b[0] + c[0]) / 3;
    const my = (a[1] + b[1] + c[1]) / 3;
    if (!pointInSolid(mx, my, outerPts, holes)) continue;
    const tri = ensureCcw([
      { x: a[0], y: a[1] },
      { x: b[0], y: b[1] },
      { x: c[0], y: c[1] },
    ]);
    if (polygonArea(tri) > 1e-8) tris.push(tri);
  }
  return tris;
}

/**
 * Union fixtures, subtract a circle, remesh each leftover island to tris.
 * @returns {{ islands: {x:number,y:number}[][][] }}
 */
export function clipIslandAtPoint(fixturePolys, x, y, r, minArea = 256) {
  const outline = unionConvexPolys(fixturePolys);
  if (!outline.length) return { islands: [] };
  const leftover = diffCircle(outline, x, y, r);
  const islands = [];
  for (let i = 0; i < leftover.length; i++) {
    const poly = leftover[i];
    if (gjPolygonArea(poly) < minArea) continue;
    const outer = simplifyRing(ringToPts(poly[0]), CLIP_SIMPLIFY_TOL);
    if (outer.length < 3) continue;
    const holes = [];
    for (let h = 1; h < poly.length; h++) {
      const hp = simplifyRing(ringToPts(poly[h]), CLIP_SIMPLIFY_TOL);
      if (hp.length >= 3) holes.push(hp);
    }
    const tris = triangulateDelaunay(outer, holes);
    if (!tris.length) continue;
    let ta = 0;
    for (let t = 0; t < tris.length; t++) ta += polygonArea(tris[t]);
    if (ta < minArea) continue;
    islands.push(tris);
  }
  return { islands };
}

function orientContourSolidInside(contour, solidX, solidY) {
  let pts = cleanContour(contour);
  if (pts.length < 3) return pts;
  if (!pointInPolygon(solidX, solidY, pts)) pts = pts.slice().reverse();
  return pts;
}

function loopCentroid(pts) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    cx += pts[i].x;
    cy += pts[i].y;
  }
  return { x: cx / pts.length, y: cy / pts.length };
}

function classifyLoops(loops, solidX, solidY, cellSize) {
  const minA = cellSize * cellSize * 0.05;
  const cleaned = [];
  for (let i = 0; i < (loops || []).length; i++) {
    const pts = cleanContour(loops[i]);
    if (pts.length < 3) continue;
    if (polygonArea(pts) < minA) continue;
    cleaned.push(pts);
  }
  if (!cleaned.length) return { outer: [], holes: [] };

  let outer = null;
  let bestA = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const o = orientContourSolidInside(cleaned[i], solidX, solidY);
    if (!pointInPolygon(solidX, solidY, o)) continue;
    const a = polygonArea(o);
    if (a > bestA) {
      bestA = a;
      outer = o;
    }
  }
  if (!outer) {
    cleaned.sort((a, b) => polygonArea(b) - polygonArea(a));
    outer = orientContourSolidInside(cleaned[0], solidX, solidY);
    bestA = polygonArea(outer);
  }

  const holes = [];
  const oc = loopCentroid(outer);
  for (let i = 0; i < cleaned.length; i++) {
    const loop = cleaned[i];
    if (Math.abs(polygonArea(loop) - bestA) < 1e-6) {
      const c = loopCentroid(loop);
      if (Math.hypot(c.x - oc.x, c.y - oc.y) < 0.5) continue;
    }
    const c = loopCentroid(loop);
    if (!pointInPolygon(c.x, c.y, outer)) continue;
    let h = cleanContour(loop);
    if (!pointInPolygon(c.x, c.y, h)) h = h.slice().reverse();
    if (pointInPolygon(solidX, solidY, h)) continue;
    if (polygonArea(h) < minA) continue;
    holes.push(h);
  }
  return { outer, holes };
}

function simplifyRing(pts, tol) {
  if (!pts || pts.length < 3) return pts || [];
  if (!(tol > 0)) return pts;
  const out = simplify2.douglasPeucker(pts, tol);
  return out && out.length >= 3 ? out : pts;
}

function hasUnstitchedEmpty(field, outer, holes) {
  if (!outer || outer.length < 3) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cs = field.cellSize;
  const cx0 = Math.max(0, Math.floor(minX / cs));
  const cy0 = Math.max(0, Math.floor(minY / cs));
  const cx1 = Math.min(field.msCols - 1, Math.floor(maxX / cs));
  const cy1 = Math.min(field.msRows - 1, Math.floor(maxY / cs));
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (cellCorners(field, cx, cy).caseId !== 0) continue;
      const px = (cx + 0.5) * cs;
      const py = (cy + 0.5) * cs;
      if (!pointInPolygon(px, py, outer)) continue;
      let inHole = false;
      for (let h = 0; h < holes.length; h++) {
        if (pointInPolygon(px, py, holes[h])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

function edgePolysFromCells(cellsMeta) {
  const polys = [];
  for (let i = 0; i < cellsMeta.length; i++) {
    const c = cellsMeta[i];
    if (c.caseId === 0 || c.caseId === 15) continue;
    for (let p = 0; p < c.parts.length; p++) {
      if (c.parts[p].verts.length >= 3) polys.push(c.parts[p].verts);
    }
  }
  return polys;
}

export function buildContourFixtures(island, field, simplifyTol) {
  const sx = island.cellCx ?? 0;
  const sy = island.cellCy ?? 0;
  const rawLoops = (island.loops && island.loops.length)
    ? island.loops
    : (island.contour ? [island.contour] : []);
  let { outer, holes } = classifyLoops(rawLoops, sx, sy, field.cellSize);
  const fallback = () => buildCellTriangleFixtures(island, field.cellSize);

  if (!outer || outer.length < 3) return fallback();
  if (rawLoops.length > 1 && !holes.length) return fallback();
  if (hasUnstitchedEmpty(field, outer, holes)) return fallback();

  outer = orientContourSolidInside(simplifyRing(outer, simplifyTol), sx, sy);
  holes = holes.map((h) => {
    const c = loopCentroid(h);
    let s = simplifyRing(h, simplifyTol);
    if (!pointInPolygon(c.x, c.y, s)) s = s.slice().reverse();
    return s;
  }).filter((h) => h.length >= 3);

  const tris = triangulateDelaunay(outer, holes);
  if (!tris.length) return fallback();
  return { polys: tris, fallback: false };
}

export function centroidFromPolys(polys) {
  let cx = 0;
  let cy = 0;
  let wSum = 0;
  for (let i = 0; i < polys.length; i++) {
    const poly = polys[i];
    const a = polygonArea(poly);
    if (a < 1e-9) continue;
    let px = 0;
    let py = 0;
    for (let v = 0; v < poly.length; v++) {
      px += poly[v].x;
      py += poly[v].y;
    }
    px /= poly.length;
    py /= poly.length;
    cx += px * a;
    cy += py * a;
    wSum += a;
  }
  if (wSum < 1e-9) return null;
  return { x: cx / wSum, y: cy / wSum };
}

/** Shift polys so area centroid sits at origin. Returns the old centroid, or null. */
export function recenterPolys(polys) {
  const cen = centroidFromPolys(polys);
  if (!cen) return null;
  if (cen.x * cen.x + cen.y * cen.y < 1e-12) return { x: 0, y: 0 };
  for (let i = 0; i < polys.length; i++) {
    const poly = polys[i];
    for (let v = 0; v < poly.length; v++) {
      poly[v].x -= cen.x;
      poly[v].y -= cen.y;
    }
  }
  return cen;
}

function ensureCcw(pts) {
  if (signedArea(pts) <= 1e-8) return pts.slice().reverse();
  return pts;
}

function pushTri(out, a, b, c) {
  const t = ensureCcw([a, b, c]);
  if (polygonArea(t) > 1e-8) out.push(t);
}

function fanToTris(verts, out) {
  if (!verts || verts.length < 3) return;
  if (verts.length === 3) {
    pushTri(out, verts[0], verts[1], verts[2]);
    return;
  }
  for (let i = 1; i + 1 < verts.length; i++) {
    pushTri(out, verts[0], verts[i], verts[i + 1]);
  }
}

/** Fallback: 2 tris per solid cell, edge loops fanned to tris. No greedy quads. */
export function buildCellTriangleFixtures(island, cellSize) {
  const meta = island.cellsMeta || [];
  const polys = [];
  for (let i = 0; i < meta.length; i++) {
    const c = meta[i];
    if (c.caseId !== 15) continue;
    const x0 = c.cx * cellSize;
    const y0 = c.cy * cellSize;
    const x1 = x0 + cellSize;
    const y1 = y0 + cellSize;
    const tl = { x: x0, y: y0 };
    const tr = { x: x1, y: y0 };
    const br = { x: x1, y: y1 };
    const bl = { x: x0, y: y1 };
    pushTri(polys, tl, tr, br);
    pushTri(polys, tl, br, bl);
  }
  const edges = edgePolysFromCells(meta);
  for (let i = 0; i < edges.length; i++) fanToTris(edges[i], polys);
  return { polys, fallback: true };
}

export function polysToLocal(polys, ox, oy) {
  const out = [];
  for (let i = 0; i < polys.length; i++) {
    const poly = polys[i];
    if (!poly || poly.length < 3 || poly.length > 8) continue;
    const local = [];
    for (let v = 0; v < poly.length; v++) {
      local.push({ x: poly[v].x - ox, y: poly[v].y - oy });
    }
    const ccw = ensureCcw(local);
    if (signedArea(ccw) > 1e-8) out.push(ccw);
  }
  return out;
}

function dominantMaterial(field, nodes) {
  let dirt = 0;
  let rock = 0;
  for (let i = 0; i < nodes.length; i++) {
    const m = field.material[nodes[i].y * field.cols + nodes[i].x];
    if (m === MAT_ROCK) rock++;
    else if (m === MAT_DIRT) dirt++;
  }
  return rock > dirt ? MAT_ROCK : MAT_DIRT;
}

export function extractIslands(field) {
  const { cols, rows, cellSize, msCols, msRows } = field;
  const visited = new Uint8Array(cols * rows);
  const islands = [];
  const queue = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const start = y * cols + x;
      if (visited[start] || field.amount[start] < ISO) continue;

      const nodes = [];
      queue.length = 0;
      queue.push(x, y);
      visited[start] = 1;
      let qh = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (qh < queue.length) {
        const cx = queue[qh++];
        const cy = queue[qh++];
        nodes.push({ x: cx, y: cy });
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const nbs = [cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1];
        for (let k = 0; k < 8; k += 2) {
          const nx = nbs[k];
          const ny = nbs[k + 1];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nIdx = ny * cols + nx;
          if (visited[nIdx] || field.amount[nIdx] < ISO) continue;
          visited[nIdx] = 1;
          queue.push(nx, ny);
        }
      }

      const nodeSet = new Set();
      for (let i = 0; i < nodes.length; i++) nodeSet.add(`${nodes[i].x},${nodes[i].y}`);

      const polys = [];
      const segments = [];
      const cellsMeta = [];
      const cx0 = Math.max(0, minX - 1);
      const cy0 = Math.max(0, minY - 1);
      const cx1 = Math.min(msCols - 1, maxX);
      const cy1 = Math.min(msRows - 1, maxY);

      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const parts = cellSolidParts(field, cx, cy);
          if (!parts.length) continue;
          const ownedParts = [];
          for (let p = 0; p < parts.length; p++) {
            const part = parts[p];
            let owned = true;
            for (let s = 0; s < part.solidNodes.length; s++) {
              const n = part.solidNodes[s];
              if (!nodeSet.has(`${n.x},${n.y}`)) {
                owned = false;
                break;
              }
            }
            if (owned) {
              polys.push(part.verts);
              ownedParts.push(part);
            }
          }
          if (!ownedParts.length) continue;
          const caseId = cellCorners(field, cx, cy).caseId;
          cellsMeta.push({ cx, cy, caseId, parts: ownedParts });
          if (parts.length === ownedParts.length && caseId > 0 && caseId < 15) {
            const segs = cellSegments(field, cx, cy);
            for (let s = 0; s < segs.length; s++) segments.push(segs[s]);
          }
        }
      }

      let areaPx = 0;
      for (let i = 0; i < polys.length; i++) areaPx += polygonArea(polys[i]);

      const loops = stitchContours(segments);
      let contour = [];
      let best = 0;
      for (let i = 0; i < loops.length; i++) {
        const a = polygonArea(loops[i]);
        if (a > best) {
          best = a;
          contour = loops[i];
        }
      }

      let cellCx = 0;
      let cellCy = 0;
      if (cellsMeta.length) {
        for (let i = 0; i < cellsMeta.length; i++) {
          cellCx += (cellsMeta[i].cx + 0.5) * cellSize;
          cellCy += (cellsMeta[i].cy + 0.5) * cellSize;
        }
        cellCx /= cellsMeta.length;
        cellCy /= cellsMeta.length;
      }
      if (contour.length >= 3) {
        contour = orientContourSolidInside(contour, cellCx, cellCy);
      } else if (polys.length) {
        let mnX = Infinity;
        let mnY = Infinity;
        let mxX = -Infinity;
        let mxY = -Infinity;
        for (let i = 0; i < polys.length; i++) {
          const poly = polys[i];
          for (let v = 0; v < poly.length; v++) {
            const p = poly[v];
            if (p.x < mnX) mnX = p.x;
            if (p.y < mnY) mnY = p.y;
            if (p.x > mxX) mxX = p.x;
            if (p.y > mxY) mxY = p.y;
          }
        }
        contour = orientContourSolidInside([
          { x: mnX, y: mnY }, { x: mxX, y: mnY },
          { x: mxX, y: mxY }, { x: mnX, y: mxY },
        ], cellCx, cellCy);
      }

      islands.push({
        nodes,
        polys,
        cellsMeta,
        contour,
        loops,
        areaPx,
        areaCells: areaPx / (cellSize * cellSize),
        cellCx,
        cellCy,
        minX,
        minY,
        maxX,
        maxY,
        material: dominantMaterial(field, nodes),
      });
    }
  }
  return islands;
}

export function aabbOverlaps(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function smoothstep01(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function paintBrush(field, wx, wy, radius, hardness, strength, erase, material) {
  const targetX = Math.floor(wx / field.cellSize);
  const targetY = Math.floor(wy / field.cellSize);
  const r = Math.max(1, radius);
  let changed = false;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = targetX + dx;
      const ny = targetY + dy;
      if (nx < 0 || ny < 0 || nx >= field.cols || ny >= field.rows) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > r) continue;
      const idx = ny * field.cols + nx;
      if (hardness >= 0.999) {
        changed = field.setAmount(nx, ny, erase ? 0 : 1, erase ? MAT_NONE : material) || changed;
        continue;
      }
      const d = dist / r;
      const softW = 1 - smoothstep01(d);
      const wMask = softW * (1 - hardness) + (d <= 1 ? 1 : 0) * hardness;
      if (wMask <= 1e-6) continue;
      const delta = strength * wMask;
      const next = clamp01(field.amount[idx] + (erase ? -delta : delta));
      changed = field.setAmount(nx, ny, next, erase ? undefined : material) || changed;
    }
  }
  return changed;
}

export function damageKernel(field, cx, cy, radius, power, falloff) {
  let changed = false;
  if (radius <= 0) {
    if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) return false;
    const idx = cy * field.cols + cx;
    return field.setAmount(cx, cy, field.amount[idx] - power);
  }
  const rCeil = Math.ceil(radius);
  for (let dy = -rCeil; dy <= rCeil; dy++) {
    for (let dx = -rCeil; dx <= rCeil; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= field.cols || ny >= field.rows) continue;
      const t = 1 - d / radius;
      const w = Math.pow(t, falloff);
      const idx = ny * field.cols + nx;
      changed = field.setAmount(nx, ny, field.amount[idx] - power * w) || changed;
    }
  }
  return changed;
}

export function castRayGrid(field, ox, oy, dx, dy, maxDist) {
  const missEnd = { x: ox + dx * maxDist, y: oy + dy * maxDist };
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) {
    return { hit: false, point: missEnd, gx: -1, gy: -1 };
  }
  const cs = field.cellSize;
  let x = Math.floor(ox / cs);
  let y = Math.floor(oy / cs);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(cs / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(cs / dy) : Infinity;
  let tMaxX = Infinity;
  if (stepX > 0) tMaxX = ((x + 1) * cs - ox) / dx;
  else if (stepX < 0) tMaxX = (x * cs - ox) / dx;
  let tMaxY = Infinity;
  if (stepY > 0) tMaxY = ((y + 1) * cs - oy) / dy;
  else if (stepY < 0) tMaxY = (y * cs - oy) / dy;

  let t = 0;
  const maxSteps = field.cols * field.rows + 2;
  for (let i = 0; i < maxSteps; i++) {
    if (x < 0 || y < 0 || x >= field.cols || y >= field.rows) {
      return { hit: false, point: missEnd, gx: -1, gy: -1 };
    }
    if (field.amount[y * field.cols + x] > 0) {
      return { hit: true, gx: x, gy: y, point: { x: ox + dx * t, y: oy + dy * t } };
    }
    if (tMaxX < tMaxY) {
      t = tMaxX;
      if (t > maxDist) break;
      tMaxX += tDeltaX;
      x += stepX;
    } else {
      t = tMaxY;
      if (t > maxDist) break;
      tMaxY += tDeltaY;
      y += stepY;
    }
  }
  return { hit: false, point: missEnd, gx: -1, gy: -1 };
}

export { clamp };
