// Marching squares + island BFS + simplify + earcut (contour mode from the HTML prototype).
// Grid is material (uint8) + amount (float 0..1). Solid node: amount >= ISO.

import earcut from './vendor/earcut.js';

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

function sqSegDist(p, a, b) {
  let x = a.x;
  let y = a.y;
  let dx = b.x - x;
  let dy = b.y - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b.x;
      y = b.y;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p.x - x;
  dy = p.y - y;
  return dx * dx + dy * dy;
}

function simplifyDP(pts, first, last, sqTol, out) {
  let maxSq = 0;
  let index = 0;
  for (let i = first + 1; i < last; i++) {
    const d = sqSegDist(pts[i], pts[first], pts[last]);
    if (d > maxSq) {
      index = i;
      maxSq = d;
    }
  }
  if (maxSq > sqTol) {
    if (index - first > 1) simplifyDP(pts, first, index, sqTol, out);
    out.push(pts[index]);
    if (last - index > 1) simplifyDP(pts, index, last, sqTol, out);
  }
}

function simplifyRing(pts, tol) {
  if (!pts || pts.length < 3) return pts || [];
  if (!(tol > 0)) return pts;
  const sqTol = tol * tol;
  const out = [pts[0]];
  simplifyDP(pts, 0, pts.length - 1, sqTol, out);
  out.push(pts[pts.length - 1]);
  return out.length >= 3 ? out : pts;
}

function triangulateWithHoles(outer, holes) {
  if (!outer || outer.length < 3) return [];
  const data = [];
  const holeIndices = [];
  for (let i = 0; i < outer.length; i++) data.push(outer[i].x, outer[i].y);
  for (let h = 0; h < holes.length; h++) {
    const hole = holes[h];
    if (!hole || hole.length < 3) continue;
    holeIndices.push(data.length / 2);
    for (let i = 0; i < hole.length; i++) data.push(hole[i].x, hole[i].y);
  }
  let idx;
  try {
    idx = earcut(data, holeIndices.length ? holeIndices : undefined, 2);
  } catch {
    return [];
  }
  if (!idx || !idx.length) return [];
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const b = idx[i + 1];
    const c = idx[i + 2];
    tris.push([
      { x: data[a * 2], y: data[a * 2 + 1] },
      { x: data[b * 2], y: data[b * 2 + 1] },
      { x: data[c * 2], y: data[c * 2 + 1] },
    ]);
  }
  return tris;
}

function pointInTri(p, a, b, c) {
  const ax = a.x;
  const ay = a.y;
  const bx = b.x - ax;
  const by = b.y - ay;
  const cx = c.x - ax;
  const cy = c.y - ay;
  const px = p.x - ax;
  const py = p.y - ay;
  const den = bx * cy - cx * by;
  if (Math.abs(den) < 1e-12) return false;
  const u = (px * cy - cx * py) / den;
  const v = (bx * py - px * by) / den;
  return u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9;
}

function triangulateContour(contour) {
  let pts = cleanContour(contour);
  if (pts.length < 3) return [];
  if (signedArea(pts) > 0) pts = pts.slice().reverse();

  const idx = pts.map((_, i) => i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let ear = -1;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      const i0 = idx[(i + n - 1) % n];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % n];
      const a = pts[i0];
      const b = pts[i1];
      const c = pts[i2];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 0) continue;
      let inside = false;
      for (let j = 0; j < n; j++) {
        const k = idx[j];
        if (k === i0 || k === i1 || k === i2) continue;
        if (pointInTri(pts[k], a, b, c)) {
          inside = true;
          break;
        }
      }
      if (!inside) {
        ear = i;
        break;
      }
    }
    if (ear < 0) break;
    const i0 = idx[(ear + n - 1) % n];
    const i1 = idx[ear];
    const i2 = idx[(ear + 1) % n];
    tris.push([pts[i0], pts[i1], pts[i2]]);
    idx.splice(ear, 1);
  }
  if (idx.length === 3) tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  return tris;
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

function expandRect(full, used, cx, cy, primary, maxW, maxH) {
  let w = 1;
  let h = 1;
  if (primary === 'h') {
    while (w < maxW && full.has(`${cx + w},${cy}`) && !used.has(`${cx + w},${cy}`)) w++;
    outerH: while (h < maxH) {
      for (let dx = 0; dx < w; dx++) {
        const k = `${cx + dx},${cy + h}`;
        if (!full.has(k) || used.has(k)) break outerH;
      }
      h++;
    }
  } else {
    while (h < maxH && full.has(`${cx},${cy + h}`) && !used.has(`${cx},${cy + h}`)) h++;
    outerV: while (w < maxW) {
      for (let dy = 0; dy < h; dy++) {
        const k = `${cx + w},${cy + dy}`;
        if (!full.has(k) || used.has(k)) break outerV;
      }
      w++;
    }
  }
  return { cx, cy, w, h, area: w * h };
}

function greedyRectsFromCells(cellsMeta, cellSize) {
  const full = new Set();
  for (let i = 0; i < cellsMeta.length; i++) {
    if (cellsMeta[i].caseId === 15) full.add(`${cellsMeta[i].cx},${cellsMeta[i].cy}`);
  }
  const used = new Set();
  const rects = [];
  const seeds = [];
  for (const key of full) {
    const comma = key.indexOf(',');
    seeds.push({ cx: +key.slice(0, comma), cy: +key.slice(comma + 1) });
  }
  seeds.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  for (let s = 0; s < seeds.length; s++) {
    const start = seeds[s];
    const key0 = `${start.cx},${start.cy}`;
    if (used.has(key0)) continue;
    const rh = expandRect(full, used, start.cx, start.cy, 'h', 1e9, 1e9);
    const rv = expandRect(full, used, start.cx, start.cy, 'v', 1e9, 1e9);
    const best = rh.area >= rv.area ? rh : rv;
    for (let dy = 0; dy < best.h; dy++) {
      for (let dx = 0; dx < best.w; dx++) used.add(`${best.cx + dx},${best.cy + dy}`);
    }
    const x0 = best.cx * cellSize;
    const y0 = best.cy * cellSize;
    const x1 = x0 + best.w * cellSize;
    const y1 = y0 + best.h * cellSize;
    rects.push([
      { x: x0, y: y0 }, { x: x1, y: y0 },
      { x: x1, y: y1 }, { x: x0, y: y1 },
    ]);
  }
  return rects;
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

function buildGreedyFixtures(island, cellSize) {
  const rects = greedyRectsFromCells(island.cellsMeta || [], cellSize);
  const edges = edgePolysFromCells(island.cellsMeta || []);
  return { polys: rects.concat(edges), fallback: true };
}

export function buildContourFixtures(island, field, simplifyTol) {
  const sx = island.cellCx ?? 0;
  const sy = island.cellCy ?? 0;
  const rawLoops = (island.loops && island.loops.length)
    ? island.loops
    : (island.contour ? [island.contour] : []);
  let { outer, holes } = classifyLoops(rawLoops, sx, sy, field.cellSize);
  const fallback = () => buildGreedyFixtures(island, field.cellSize);

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

  let tris = triangulateWithHoles(outer, holes);
  if (!tris.length && !holes.length) tris = triangulateContour(outer);
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

function ensureCcw(pts) {
  if (signedArea(pts) <= 1e-8) return pts.slice().reverse();
  return pts;
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
