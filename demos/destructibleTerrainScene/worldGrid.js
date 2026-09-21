// Density SAB + mesh statics (marching squares, simplify2, Delaunay, Martinez).
// Solid node: amount >= ISO.

import { Noise2D } from '../../src/core/noise2D.js';
import { SharedResource } from '../../src/core/sharedResource.js';
import Delaunator from './vendor/delaunator.js';
import { diff as martinezDiff, union as martinezUnion } from './vendor/martinez.js';
import simplify2 from './vendor/simplify2.js';

export const CELL = 10;
export const COLS = 640;
export const ROWS = 200;
export const ISO = 0.1;
export const MAT_NONE = 0;
export const MAT_DIRT = 1;
export const MAT_ROCK = 2;
export const MAT_TINT = [0, 0xc4a574, 0x8a9099];
export const LAYER_STATIC = 1;
export const RAY_MASK_NO_STATIC = 0xffffffff ^ (1 << LAYER_STATIC);
export const SHOT_POWER = 2;
export const SHOT_RADIUS = 2;
export const SHOT_FALLOFF = 1;

export const TUNE = {
  BRUSH_RADIUS: 0,
  BRUSH_HARDNESS: 1,
  BRUSH_STRENGTH: 2,
  SHOT_POWER: 3,
  SHOT_RADIUS: 4,
  SHOT_FALLOFF: 5,
  SHOT_COOLDOWN: 6,
  MIN_TRI_AREA: 7,
  SIMPLIFY_TOL: 8,
  FIXTURE_CAP: 9,
  MIN_KEEP_AREA: 10,
  UI_BLOCK: 11,
  CHUNK: 12,
  SIMPLIFY_MAX: 13,
  AREA_RATIO_MIN: 14,
};
export const TUNE_COUNT = 15;
export const SHOT_KIND_GRID = 1;
export const SHOT_KIND_BODY = 2;
export const SHOT_CAP = 32;
const SHOT_STRIDE = 5;
const SHOT_HEAD = 0;
const SHOT_TAIL = 1;
export const TUNE_DEFAULTS = [
  3,
  0.35,
  0.35,
  SHOT_POWER,
  SHOT_RADIUS,
  SHOT_FALLOFF,
  60,
  CELL * CELL * 0.25,
  4,
  512,
  CELL * CELL,
  0,
  32,
  16,
  0.72,
];
/** Ungrounded crumbs smaller than this vanish instead of becoming a body. */
export const DROP_MIN_CELLS = 4;
/** Per-cell fallback only for crumbs. Bigger failures return empty so remesh can quad-split. */
export const FALLBACK_MAX_TRIS = 24;
const AREA_RATIO_MAX = 1.2;
const SEED_SCALE = 0.055;
const SEED_THRESHOLD = 0.12;
const SEED_Y_BIAS = 0.55;
const SEED_OCTAVES = 3;
const SEED_BAND = 0.3;
const SEED_JITTER = 0.25;
const ISO_EMPTY = ISO - 1e-4;
const SEED_STONE_FRAC = 0.55;
const SEED_SKY_FRAC = 0.12;
export const SEED_STAMP = {
  boulderX: 0.72,
  columnX: 0.22,
  peninsulaX: 0.38,
  archX: 0.55,
};

const DIRTY_FLAG = 0;
const DIRTY_MIN_X = 1;
const DIRTY_MIN_Y = 2;
const DIRTY_MAX_X = 3;
const DIRTY_MAX_Y = 4;
const _dirtyBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const _shotOut = { kind: 0, x: 0, y: 0, entityIndex: -1, fixtureIndex: -1 };
const _islandsOut = [];
const _chunksOut = [];
let _smoothA = null;
let _smoothB = null;
const _stitchAdj = new Map();
const _stitchPoints = new Map();
const _stitchUsed = new Set();
const _triSeen = new Set();

const CLIP_SIMPLIFY_TOL = 4;

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

export class WorldGrid extends SharedResource {
  static cols = COLS;
  static rows = ROWS;
  static cellSize = CELL;
  static _visited = null;
  static _queue = null;
  static _nodeIdx = null;
  static _scratchCells = 0;
  static _visitGen = 1;

  static get msCols() {
    return this.cols - 1;
  }

  static get msRows() {
    return this.rows - 1;
  }

  static schemaFor(cols, rows) {
    return {
      amount: { type: Float32Array, length: cols * rows },
      material: { type: Uint8Array, length: cols * rows },
      dirtyRect: { type: Int32Array, length: 5 },
      tune: { type: Float32Array, length: TUNE_COUNT },
      shotMeta: { type: Int32Array, length: 2 },
      shotData: { type: Float32Array, length: SHOT_CAP * SHOT_STRIDE },
    };
  }

  static initialize(buffer, schema) {
    super.initialize(buffer, schema);
    const d = this.dirtyRect;
    if (d) {
      const virgin =
        Atomics.load(d, DIRTY_FLAG) === 0 &&
        Atomics.load(d, DIRTY_MIN_X) === 0 &&
        Atomics.load(d, DIRTY_MIN_Y) === 0 &&
        Atomics.load(d, DIRTY_MAX_X) === 0 &&
        Atomics.load(d, DIRTY_MAX_Y) === 0;
      if (virgin) this.resetDirty();
    }
    this.applyTuneDefaults();
  }

  static applyTuneDefaults() {
    const t = this.tune;
    if (!t || t[TUNE.BRUSH_RADIUS] !== 0) return;
    for (let i = 0; i < TUNE_COUNT; i++) t[i] = TUNE_DEFAULTS[i];
  }

  static tuneGet(i) {
    const t = this.tune;
    return t ? t[i] : TUNE_DEFAULTS[i];
  }

  static tuneSet(i, value) {
    if (this.tune) this.tune[i] = value;
  }

  /** Node tests: bind a local SAB. Scene bind uses Scene.sharedResources. */
  static attach(cols, rows, cellSize) {
    this.cols = cols;
    this.rows = rows;
    this.cellSize = cellSize;
    const schema = this.schemaFor(cols, rows);
    this.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schema)), schema);
    return this;
  }

  static resetDirty() {
    const d = this.dirtyRect;
    if (!d) return;
    Atomics.store(d, DIRTY_FLAG, 0);
    Atomics.store(d, DIRTY_MIN_X, this.cols);
    Atomics.store(d, DIRTY_MIN_Y, this.rows);
    Atomics.store(d, DIRTY_MAX_X, -1);
    Atomics.store(d, DIRTY_MAX_Y, -1);
  }

  static hasDirty() {
    const d = this.dirtyRect;
    return !!(d && Atomics.load(d, DIRTY_FLAG));
  }

  static idx(x, y) {
    return y * this.cols + x;
  }

  static node(x, y) {
    return this.amount[y * this.cols + x];
  }

  static markDirty(x, y) {
    const d = this.dirtyRect;
    if (!d) return;
    atomicMin(d, DIRTY_MIN_X, x);
    atomicMin(d, DIRTY_MIN_Y, y);
    atomicMax(d, DIRTY_MAX_X, x);
    atomicMax(d, DIRTY_MAX_Y, y);
    Atomics.store(d, DIRTY_FLAG, 1);
  }

  static markAllDirty() {
    const d = this.dirtyRect;
    if (!d) return;
    Atomics.store(d, DIRTY_MIN_X, 0);
    Atomics.store(d, DIRTY_MIN_Y, 0);
    Atomics.store(d, DIRTY_MAX_X, this.cols - 1);
    Atomics.store(d, DIRTY_MAX_Y, this.rows - 1);
    Atomics.store(d, DIRTY_FLAG, 1);
  }

  static peekDirty(pad = 0) {
    const d = this.dirtyRect;
    if (!d || Atomics.load(d, DIRTY_FLAG) === 0) return null;
    _dirtyBox.minX = Math.max(0, Atomics.load(d, DIRTY_MIN_X) - pad);
    _dirtyBox.minY = Math.max(0, Atomics.load(d, DIRTY_MIN_Y) - pad);
    _dirtyBox.maxX = Math.min(this.cols - 1, Atomics.load(d, DIRTY_MAX_X) + pad);
    _dirtyBox.maxY = Math.min(this.rows - 1, Atomics.load(d, DIRTY_MAX_Y) + pad);
    return _dirtyBox;
  }

  static consumeDirty(pad = 1) {
    const d = this.dirtyRect;
    if (!d || Atomics.exchange(d, DIRTY_FLAG, 0) === 0) return null;
    const minX = Atomics.load(d, DIRTY_MIN_X);
    const minY = Atomics.load(d, DIRTY_MIN_Y);
    const maxX = Atomics.load(d, DIRTY_MAX_X);
    const maxY = Atomics.load(d, DIRTY_MAX_Y);
    Atomics.store(d, DIRTY_MIN_X, this.cols);
    Atomics.store(d, DIRTY_MIN_Y, this.rows);
    Atomics.store(d, DIRTY_MAX_X, -1);
    Atomics.store(d, DIRTY_MAX_Y, -1);
    _dirtyBox.minX = Math.max(0, minX - pad);
    _dirtyBox.minY = Math.max(0, minY - pad);
    _dirtyBox.maxX = Math.min(this.cols - 1, maxX + pad);
    _dirtyBox.maxY = Math.min(this.rows - 1, maxY + pad);
    return _dirtyBox;
  }

  static setAmount(x, y, value, material) {
    const i = y * this.cols + x;
    const next = clamp01(value);
    if (this.amount[i] === next && (material == null || this.material[i] === material)) {
      return false;
    }
    this.amount[i] = next;
    if (next <= 0) this.material[i] = MAT_NONE;
    else if (material != null) this.material[i] = material;
    this.markDirty(x, y);
    return true;
  }

  static clearIslandNodes(island) {
    const idx = island.nodeIdx;
    const start = island.nodeStart;
    const n = island.nodeCount;
    for (let i = 0; i < n; i++) {
      const p = idx[start + i];
      this.amount[p] = 0;
      this.material[p] = MAT_NONE;
    }
  }

  static clearRect(minX, minY, maxX, maxY) {
    const x0 = Math.max(0, minX);
    const y0 = Math.max(0, minY);
    const x1 = Math.min(this.cols - 1, maxX);
    const y1 = Math.min(this.rows - 1, maxY);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * this.cols + x;
        this.amount[i] = 0;
        this.material[i] = MAT_NONE;
      }
    }
    this.markDirty(x0, y0);
    this.markDirty(x1, y1);
  }

  static seedWorld(seed = 7) {
    seedWorld(this, seed | 0);
  }

  static stampDemoShapes() {
    stampDemoShapes(this);
  }

  static findSkySpawn() {
    return findSkySpawn(this);
  }

  static paint(wx, wy, radius, hardness, strength, erase, material) {
    return paintBrush(this, wx, wy, radius, hardness, strength, erase, material);
  }

  static damage(wx, wy, radius = 2, power = 0.4, falloff = 1) {
    const cx = Math.floor(wx / this.cellSize);
    const cy = Math.floor(wy / this.cellSize);
    return damageKernel(this, cx, cy, radius, power, falloff);
  }

  /**
   * SPSC: ship (reader worker) enqueues; manager (grid writer) drains.
   * Do not call damage() from the ray worker.
   */
  static pushHit(kind, x, y, entityIndex, fixtureIndex) {
    const meta = this.shotMeta;
    const data = this.shotData;
    if (!meta || !data) return false;
    const head = Atomics.load(meta, SHOT_HEAD);
    const tail = Atomics.load(meta, SHOT_TAIL);
    const next = head + 1 < SHOT_CAP ? head + 1 : 0;
    if (next === tail) return false;
    const o = head * SHOT_STRIDE;
    data[o] = kind;
    data[o + 1] = x;
    data[o + 2] = y;
    data[o + 3] = entityIndex;
    data[o + 4] = fixtureIndex;
    Atomics.store(meta, SHOT_HEAD, next);
    return true;
  }

  static shiftHit(out) {
    const dest = out || _shotOut;
    const meta = this.shotMeta;
    const data = this.shotData;
    if (!meta || !data) return null;
    const tail = Atomics.load(meta, SHOT_TAIL);
    const head = Atomics.load(meta, SHOT_HEAD);
    if (tail === head) return null;
    const o = tail * SHOT_STRIDE;
    dest.kind = data[o] | 0;
    dest.x = data[o + 1];
    dest.y = data[o + 2];
    dest.entityIndex = data[o + 3] | 0;
    dest.fixtureIndex = data[o + 4] | 0;
    const next = tail + 1 < SHOT_CAP ? tail + 1 : 0;
    Atomics.store(meta, SHOT_TAIL, next);
    return dest;
  }

  /**
   * DDA on amount. Origin in solid is skipped until the ray leaves, then next solid hits.
   * @returns {{ hit: boolean, gx: number, gy: number, x: number, y: number, distance: number }}
   */
  static castRay(ox, oy, dx, dy, maxDist) {
    const miss = { hit: false, gx: -1, gy: -1, x: ox + dx * maxDist, y: oy + dy * maxDist, distance: maxDist };
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return miss;
    const cs = this.cellSize;
    const cols = this.cols;
    const rows = this.rows;
    const amount = this.amount;
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

    let skipping =
      x >= 0 && y >= 0 && x < cols && y < rows && amount[y * cols + x] >= ISO;
    let t = 0;
    const maxSteps = cols * rows + 2;
    for (let i = 0; i < maxSteps; i++) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return miss;
      const here = amount[y * cols + x] >= ISO;
      if (skipping) {
        if (!here) skipping = false;
      } else if (here) {
        return { hit: true, gx: x, gy: y, x: ox + dx * t, y: oy + dy * t, distance: t };
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
    return miss;
  }

  static extractIslands(box, opts) {
    return extractIslands(this, box, opts);
  }

  /**
   * Flood the connected solid that owns cell (x,y). No chunk clip.
   * @param {{ mesh?: boolean, stopIfGrounded?: boolean }} [opts]
   */
  static extractIslandAt(x, y, opts) {
    x = x | 0;
    y = y | 0;
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    if (this.amount[y * this.cols + x] < ISO) return null;
    const merged = opts
      ? { clip: false, mesh: opts.mesh, stopIfGrounded: opts.stopIfGrounded }
      : { clip: false };
    const list = extractIslands(this, { minX: x, minY: y, maxX: x, maxY: y }, merged);
    return list.length ? list[0] : null;
  }

  static islandKey(island) {
    if (!island || !island.nodeCount) return -1;
    const idx = island.nodeIdx;
    const start = island.nodeStart;
    const n = island.nodeCount;
    let m = idx[start];
    for (let i = 1; i < n; i++) {
      const p = idx[start + i];
      if (p < m) m = p;
    }
    return m;
  }

  static copyIslandNodes(island) {
    return copyIslandNodes(island);
  }

  static packedBox(packed) {
    return packedBox(this, packed);
  }

  /** True if any cell touches left, right, or bottom of the grid (bedrock). */
  static isGrounded(island) {
    return isGrounded(this, island);
  }

  /** True if a node sits on a box edge that is not world bedrock (island may continue). */
  static touchesChunkEdge(island, box) {
    return touchesChunkEdge(this, island, box);
  }

  /**
   * Flood from a seed. Hits bedrock (left/right/bottom) → true.
   * Does not run marching squares. Early-outs on a wall.
   */
  static isGroundedAt(x, y) {
    return isGroundedAt(this, x | 0, y | 0);
  }

  static meshNodes(packed) {
    return meshNodes(this, packed);
  }

  static clearPackedNodes(packed) {
    if (!packed) return;
    const amount = this.amount;
    const material = this.material;
    for (let i = 0; i < packed.length; i++) {
      const p = packed[i];
      amount[p] = 0;
      material[p] = MAT_NONE;
    }
  }

  static buildContourFixtures(island, simplifyTol) {
    return buildContourFixtures(island, this, simplifyTol);
  }

  static chunkCells() {
    return chunkCells(this);
  }

  static chunkRect(cx, cy) {
    return chunkRect(this, cx, cy);
  }

  static chunksOverlapping(dirty) {
    return chunksOverlapping(this, dirty);
  }

  static splitBoxQuads(box) {
    return splitBoxQuads(box);
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

function nodeSolidAt(field, idx) {
  if (field.amount[idx] < ISO) return false;
  const mask = field._extractMask;
  return !mask || mask[idx] !== 0;
}

function nodeAmount(field, x, y, clip) {
  if (clip && (x < clip.minX || x > clip.maxX || y < clip.minY || y > clip.maxY)) return 0;
  if (x < 0 || y < 0 || x >= field.cols || y >= field.rows) return 0;
  const i = y * field.cols + x;
  if (field._extractMask && field._extractMask[i] === 0) return 0;
  return field.amount[i];
}

function cellCorners(field, cx, cy, clip) {
  const cs = field.cellSize;
  const x0 = cx * cs;
  const y0 = cy * cs;
  const x1 = x0 + cs;
  const y1 = y0 + cs;
  const tl = nodeAmount(field, cx, cy, clip);
  const tr = nodeAmount(field, cx + 1, cy, clip);
  const br = nodeAmount(field, cx + 1, cy + 1, clip);
  const bl = nodeAmount(field, cx, cy + 1, clip);
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

function cellSolidParts(field, cx, cy, clip) {
  const c = cellCorners(field, cx, cy, clip);
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

function cellSegments(field, cx, cy, clip) {
  const c = cellCorners(field, cx, cy, clip);
  const segs = MS_CASES[c.caseId] || [];
  return segs.map(([i, j]) => [c.edges[i], c.edges[j]]);
}

function polygonArea(vertices) {
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
function pointInConvex(pts, x, y) {
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
function subdivideConvex(poly, minArea, maxOut, out) {
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
function carveConvexAtPoint(poly, x, y, vanishArea) {
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
function splitConvexAtPoint(poly, x, y, minArea, maxOut) {
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
  const adj = _stitchAdj;
  const points = _stitchPoints;
  adj.clear();
  points.clear();
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

  const used = _stitchUsed;
  used.clear();
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

function circleRing(cx, cy, r, n = 8) {
  const ring = [];
  const sides = n < 8 ? 8 : n;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function unionConvexPolys(polys) {
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

function diffCircle(outline, cx, cy, r, sides = 8) {
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

function triangulateDelaunay(outerPts, holesPts) {
  const holes = holesPts || [];
  const pts = [];
  const seen = _triSeen;
  seen.clear();
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
    if (polygonArea(tri) > WorldGrid.tuneGet(TUNE.MIN_TRI_AREA)) tris.push(tri);
  }
  return tris;
}

/**
 * Union fixtures, subtract a circle, remesh each leftover island to tris.
 * @returns {{ islands: {x:number,y:number}[][][] }}
 */
function clipIslandAtPoint(fixturePolys, x, y, r, minArea = 256) {
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

function triAreaSum(tris) {
  let a = 0;
  for (let i = 0; i < tris.length; i++) a += polygonArea(tris[i]);
  return a;
}

function anyTriCoversEmpty(field, island, tris) {
  if (island.minX == null || island.maxX == null) return false;
  const cs = field.cellSize;
  const cx0 = Math.max(0, (island.minX | 0) - 1);
  const cy0 = Math.max(0, (island.minY | 0) - 1);
  const cx1 = Math.min(field.msCols - 1, island.maxX | 0);
  const cy1 = Math.min(field.msRows - 1, island.maxY | 0);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (cellCorners(field, cx, cy).caseId !== 0) continue;
      const px = (cx + 0.5) * cs;
      const py = (cy + 0.5) * cs;
      for (let t = 0; t < tris.length; t++) {
        if (pointInPolygon(px, py, tris[t])) return true;
      }
    }
  }
  return false;
}

function acceptDelaunay(island, field, outer, holes, tris) {
  const cap = WorldGrid.tuneGet(TUNE.FIXTURE_CAP) | 0;
  if (!tris || !tris.length) return 'empty';
  if (cap > 0 && tris.length > cap) return 'many';
  const areaPx = island.areaPx || 0;
  if (areaPx > 1e-6) {
    const ratio = triAreaSum(tris) / areaPx;
    const minR = WorldGrid.tuneGet(TUNE.AREA_RATIO_MIN);
    if (!(ratio >= minR) || ratio > AREA_RATIO_MAX) return 'area';
  }
  if (anyTriCoversEmpty(field, island, tris)) return 'hole';
  return 'ok';
}

function simplifyHoles(holes0, tol) {
  const holes = [];
  for (let i = 0; i < holes0.length; i++) {
    const c = loopCentroid(holes0[i]);
    let s = simplifyRing(holes0[i], tol);
    if (s.length < 3) continue;
    if (!pointInPolygon(c.x, c.y, s)) s = s.slice().reverse();
    if (s.length >= 3) holes.push(s);
  }
  return holes;
}

function tryDelaunayAtTol(island, field, outer0, holes0, tol) {
  const sx = island.cellCx ?? 0;
  const sy = island.cellCy ?? 0;
  const outer = orientContourSolidInside(simplifyRing(outer0, tol), sx, sy);
  if (!outer || outer.length < 3) return { reason: 'empty', tris: [], outer, holes: [] };
  const holes = simplifyHoles(holes0, tol);
  const tris = triangulateDelaunay(outer, holes);
  return { reason: acceptDelaunay(island, field, outer, holes, tris), tris, outer, holes };
}

function buildContourFixtures(island, field, simplifyTol) {
  const sx = island.cellCx ?? 0;
  const sy = island.cellCy ?? 0;
  const rawLoops = island.loops && island.loops.length ? island.loops : [];
  const classified = classifyLoops(rawLoops, sx, sy, field.cellSize);
  const outer0 = classified.outer;
  const holes0 = classified.holes;

  if (outer0 && outer0.length >= 3) {
    const baseTol = simplifyTol > 0 ? simplifyTol : WorldGrid.tuneGet(TUNE.SIMPLIFY_TOL);
    const maxTol = WorldGrid.tuneGet(TUNE.SIMPLIFY_MAX);
    let triedHalf = false;
    for (let tol = baseTol; tol <= maxTol + 1e-6; tol += 2) {
      const attempt = tryDelaunayAtTol(island, field, outer0, holes0, tol);
      if (attempt.reason === 'ok') return { polys: attempt.tris, fallback: false };
      if (attempt.reason === 'many' || attempt.reason === 'empty') continue;
      if (!triedHalf) {
        triedHalf = true;
        const half = tryDelaunayAtTol(island, field, outer0, holes0, Math.max(1, tol * 0.5));
        if (half.reason === 'ok') return { polys: half.tris, fallback: false };
      }
      break;
    }
  }

  const fb = buildCellTriangleFixtures(island, field.cellSize);
  if (!fb.polys.length) return { polys: [], fallback: false };
  if (fb.polys.length > FALLBACK_MAX_TRIS) return { polys: [], fallback: true };
  return fb;
}

function centroidFromPolys(polys) {
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
function recenterPolys(polys) {
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
  if (polygonArea(t) > WorldGrid.tuneGet(TUNE.MIN_TRI_AREA)) out.push(t);
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

/** Crumb fallback only: 2 tris per solid cell. Large islands must not use this. */
function buildCellTriangleFixtures(island, cellSize) {
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

function polysToLocal(polys, ox, oy) {
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

function atomicMin(arr, i, v) {
  let cur = Atomics.load(arr, i);
  while (v < cur) {
    const prev = Atomics.compareExchange(arr, i, cur, v);
    if (prev === cur) return;
    cur = prev;
  }
}

function atomicMax(arr, i, v) {
  let cur = Atomics.load(arr, i);
  while (v > cur) {
    const prev = Atomics.compareExchange(arr, i, cur, v);
    if (prev === cur) return;
    cur = prev;
  }
}

function ensureExtractScratch(field, n) {
  if (field._scratchCells >= n && field._visited) return;
  field._visited = new Uint32Array(n);
  field._queue = new Int32Array(n);
  field._nodeIdx = new Int32Array(n);
  field._scratchCells = n;
  field._visitGen = 1;
}

function dominantMaterial(field, nodeIdx, nodeStart, nodeCount) {
  let dirt = 0;
  let rock = 0;
  for (let i = 0; i < nodeCount; i++) {
    const m = field.material[nodeIdx[nodeStart + i]];
    if (m === MAT_ROCK) rock++;
    else if (m === MAT_DIRT) dirt++;
  }
  return rock > dirt ? MAT_ROCK : MAT_DIRT;
}

function extractIslands(field, box, opts) {
  const { cols, rows, cellSize, msCols, msRows } = field;
  const n = cols * rows;
  ensureExtractScratch(field, n);
  const visited = field._visited;
  const queue = field._queue;
  const nodeIdx = field._nodeIdx;
  const clipOn = !!(opts && opts.clip && box);
  const clip = clipOn ? box : null;
  const wantMesh = !(opts && opts.mesh === false);
  const stopIfGrounded = !!(opts && opts.stopIfGrounded);
  const lastX = cols - 1;
  const lastY = rows - 1;

  if (field._visitGen > 0x7f000000) {
    visited.fill(0);
    field._visitGen = 1;
  }
  const extractStart = field._visitGen++;

  const seedMinX = box ? box.minX : 0;
  const seedMinY = box ? box.minY : 0;
  const seedMaxX = box ? box.maxX : cols - 1;
  const seedMaxY = box ? box.maxY : rows - 1;
  const floodMinX = clipOn ? seedMinX : 0;
  const floodMinY = clipOn ? seedMinY : 0;
  const floodMaxX = clipOn ? seedMaxX : cols - 1;
  const floodMaxY = clipOn ? seedMaxY : rows - 1;

  let islandCount = 0;
  let nodeFill = 0;

  for (let y = seedMinY; y <= seedMaxY; y++) {
    for (let x = seedMinX; x <= seedMaxX; x++) {
      const start = y * cols + x;
      if (visited[start] >= extractStart || !nodeSolidAt(field, start)) continue;

      const floodId = field._visitGen++;
      let qh = 0;
      let qt = 0;
      queue[qt++] = start;
      visited[start] = floodId;
      const nodeStart = nodeFill;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let grounded = false;

      while (qh < qt) {
        const packed = queue[qh++];
        nodeIdx[nodeFill++] = packed;
        const cx = packed % cols;
        const cy = (packed / cols) | 0;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        if (stopIfGrounded && (cx === 0 || cx === lastX || cy === lastY)) {
          grounded = true;
          break;
        }

        if (cx + 1 <= floodMaxX) {
          const nIdx = packed + 1;
          if (visited[nIdx] < extractStart && nodeSolidAt(field, nIdx)) {
            visited[nIdx] = floodId;
            queue[qt++] = nIdx;
          }
        }
        if (cx - 1 >= floodMinX) {
          const nIdx = packed - 1;
          if (visited[nIdx] < extractStart && nodeSolidAt(field, nIdx)) {
            visited[nIdx] = floodId;
            queue[qt++] = nIdx;
          }
        }
        if (cy + 1 <= floodMaxY) {
          const nIdx = packed + cols;
          if (visited[nIdx] < extractStart && nodeSolidAt(field, nIdx)) {
            visited[nIdx] = floodId;
            queue[qt++] = nIdx;
          }
        }
        if (cy - 1 >= floodMinY) {
          const nIdx = packed - cols;
          if (visited[nIdx] < extractStart && nodeSolidAt(field, nIdx)) {
            visited[nIdx] = floodId;
            queue[qt++] = nIdx;
          }
        }
      }

      const nodeCount = nodeFill - nodeStart;
      if (!grounded) {
        grounded = isGroundedNodes(cols, lastX, lastY, nodeIdx, nodeStart, nodeCount);
      }

      let rec = _islandsOut[islandCount];
      if (!rec) {
        rec = {};
        _islandsOut[islandCount] = rec;
      }
      rec.nodeIdx = nodeIdx;
      rec.nodeStart = nodeStart;
      rec.nodeCount = nodeCount;
      rec.minX = minX;
      rec.minY = minY;
      rec.maxX = maxX;
      rec.maxY = maxY;
      rec.material = dominantMaterial(field, nodeIdx, nodeStart, nodeCount);
      rec.grounded = grounded;
      rec.cellCx = nodeCount
        ? ((nodeIdx[nodeStart] % cols) + 0.5) * cellSize
        : 0;
      rec.cellCy = nodeCount
        ? (((nodeIdx[nodeStart] / cols) | 0) + 0.5) * cellSize
        : 0;

      if (!wantMesh || (stopIfGrounded && grounded)) {
        rec.polys = [];
        rec.cellsMeta = [];
        rec.contour = [];
        rec.loops = [];
        rec.areaPx = 0;
        rec.areaCells = 0;
        islandCount++;
        continue;
      }

      const polys = [];
      const segments = [];
      const cellsMeta = [];
      const cx0 = Math.max(0, minX - 1);
      const cy0 = Math.max(0, minY - 1);
      const cx1 = Math.min(msCols - 1, maxX);
      const cy1 = Math.min(msRows - 1, maxY);

      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const parts = cellSolidParts(field, cx, cy, clip);
          if (!parts.length) continue;
          const ownedParts = [];
          for (let p = 0; p < parts.length; p++) {
            const part = parts[p];
            let owned = true;
            for (let s = 0; s < part.solidNodes.length; s++) {
              const sn = part.solidNodes[s];
              if (clip && (sn.x < clip.minX || sn.x > clip.maxX || sn.y < clip.minY || sn.y > clip.maxY)) {
                continue;
              }
              if (visited[sn.y * cols + sn.x] !== floodId) {
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
          const caseId = cellCorners(field, cx, cy, clip).caseId;
          cellsMeta.push({ cx, cy, caseId, parts: ownedParts });
          if (parts.length === ownedParts.length && caseId > 0 && caseId < 15) {
            const segs = cellSegments(field, cx, cy, clip);
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

      if (!rec.cellCx && cellsMeta.length) {
        rec.cellCx = (cellsMeta[0].cx + 0.5) * cellSize;
        rec.cellCy = (cellsMeta[0].cy + 0.5) * cellSize;
      }
      if (contour.length >= 3) {
        contour = orientContourSolidInside(contour, rec.cellCx, rec.cellCy);
      }

      rec.polys = polys;
      rec.cellsMeta = cellsMeta;
      rec.contour = contour;
      rec.loops = loops;
      rec.areaPx = areaPx;
      rec.areaCells = areaPx / (cellSize * cellSize);
      islandCount++;
    }
  }
  _islandsOut.length = islandCount;
  return _islandsOut;
}

function aabbOverlaps(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function chunkCells(field) {
  const n = WorldGrid.tuneGet(TUNE.CHUNK) | 0;
  return n < 8 ? 8 : n;
}

function chunkRect(field, cx, cy, dest) {
  const ch = chunkCells(field);
  const rec = dest || {};
  rec.chunkX = cx;
  rec.chunkY = cy;
  rec.minX = cx * ch;
  rec.minY = cy * ch;
  rec.maxX = Math.min(field.cols - 1, rec.minX + ch - 1);
  rec.maxY = Math.min(field.rows - 1, rec.minY + ch - 1);
  return rec;
}

function chunksOverlapping(field, dirty) {
  const ch = chunkCells(field);
  const x0 = Math.max(0, dirty.minX | 0);
  const y0 = Math.max(0, dirty.minY | 0);
  const x1 = Math.min(field.cols - 1, dirty.maxX | 0);
  const y1 = Math.min(field.rows - 1, dirty.maxY | 0);
  if (x1 < x0 || y1 < y0) {
    _chunksOut.length = 0;
    return _chunksOut;
  }
  const cx0 = (x0 / ch) | 0;
  const cy0 = (y0 / ch) | 0;
  const cx1 = (x1 / ch) | 0;
  const cy1 = (y1 / ch) | 0;
  let n = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      let rec = _chunksOut[n];
      if (!rec) {
        rec = {};
        _chunksOut[n] = rec;
      }
      chunkRect(field, cx, cy, rec);
      n++;
    }
  }
  _chunksOut.length = n;
  return _chunksOut;
}

function smoothOccupancy(solid, cols, rows, passes = 2) {
  const n = cols * rows;
  if (!_smoothA || _smoothA.length < n) {
    _smoothA = new Uint8Array(n);
    _smoothB = new Uint8Array(n);
  }
  let cur = solid;
  let dest = _smoothA;
  for (let p = 0; p < passes; p++) {
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        let neighbors = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = gx + dx;
            const y = gy + dy;
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
            neighbors += cur[y * cols + x];
          }
        }
        dest[gy * cols + gx] = neighbors >= 5 ? 1 : 0;
      }
    }
    cur = dest;
    dest = cur === _smoothA ? _smoothB : _smoothA;
  }
  return cur;
}

function seedFbm(noise, x, y) {
  return noise.fbm(
    (x + 0.5) * SEED_SCALE,
    (y + 0.5) * SEED_SCALE,
    SEED_OCTAVES,
    1,
    1,
    2,
    0.5,
  );
}

/** Rewrite amount from occupancy + noise. Solid stays >= ISO; empty stays < ISO. */
function writeClampedDensity(field, occ, noise) {
  const cols = field.cols;
  const rows = field.rows;
  const amount = field.amount;
  const skyEnd = Math.max(2, Math.floor(rows * SEED_SKY_FRAC));
  const depthDen = Math.max(1, rows - 1 - skyEnd);
  for (let y = 0; y < rows; y++) {
    const depth = rows > 1 ? (y - skyEnd) / depthDen : 1;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const n = seedFbm(noise, x, y);
      const n01 = clamp01(0.5 + 0.5 * n);
      const signed = n + SEED_Y_BIAS * depth - SEED_THRESHOLD;
      if (occ[i]) {
        amount[i] = clamp(ISO + (1 - ISO) * clamp01(signed / SEED_BAND + SEED_JITTER * n01), ISO, 1);
      } else {
        amount[i] = clamp(ISO_EMPTY * clamp01(-signed / SEED_BAND + SEED_JITTER * n01), 0, ISO_EMPTY);
      }
    }
  }
}

function seedWorld(field, seed) {
  const cols = field.cols;
  const rows = field.rows;
  const amount = field.amount;
  const material = field.material;
  amount.fill(0);
  material.fill(0);
  const noise = new Noise2D(seed);
  const skyEnd = Math.max(2, Math.floor(rows * SEED_SKY_FRAC));
  const raw = new Uint8Array(cols * rows);
  for (let y = skyEnd; y < rows; y++) {
    const depth = rows > 1 ? (y - skyEnd) / Math.max(1, rows - 1 - skyEnd) : 1;
    for (let x = 0; x < cols; x++) {
      const n = seedFbm(noise, x, y);
      if (n + SEED_Y_BIAS * depth > SEED_THRESHOLD) raw[y * cols + x] = 1;
    }
  }
  const solid = smoothOccupancy(raw, cols, rows, 2);
  for (let y = 0; y < skyEnd; y++) {
    solid.fill(0, y * cols, y * cols + cols);
  }
  for (let y = 0; y < rows; y++) {
    const depth = rows > 1 ? y / (rows - 1) : 1;
    const mat = depth >= SEED_STONE_FRAC ? MAT_ROCK : MAT_DIRT;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!solid[i]) continue;
      amount[i] = 1;
      material[i] = mat;
    }
  }
  stampDemoShapes(field);
  const occ = new Uint8Array(cols * rows);
  for (let i = 0; i < occ.length; i++) occ[i] = amount[i] >= ISO ? 1 : 0;
  writeClampedDensity(field, occ, noise);
  field.markAllDirty();
}

function stampFilled(field, x0, y0, x1, y1, mat) {
  const cols = field.cols;
  const rows = field.rows;
  const amount = field.amount;
  const material = field.material;
  const xa = x0 < 0 ? 0 : x0 | 0;
  const ya = y0 < 0 ? 0 : y0 | 0;
  const xb = x1 > cols ? cols : x1 | 0;
  const yb = y1 > rows ? rows : y1 | 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = y * cols + x;
      amount[i] = 1;
      material[i] = mat;
    }
  }
}

function markGroundedMask(field) {
  const cols = field.cols;
  const rows = field.rows;
  const n = cols * rows;
  const amount = field.amount;
  let mask = field._grounded;
  if (!mask || mask.length < n) mask = field._grounded = new Uint8Array(n);
  else mask.fill(0);
  let q = field._groundQ;
  if (!q || q.length < n) q = field._groundQ = new Int32Array(n);
  let qt = 0;
  const lastX = cols - 1;
  const lastY = rows - 1;
  const trySeed = (x, y) => {
    const i = y * cols + x;
    if (amount[i] < ISO || mask[i]) return;
    mask[i] = 1;
    q[qt++] = i;
  };
  for (let x = 0; x < cols; x++) trySeed(x, lastY);
  for (let y = 0; y < lastY; y++) {
    trySeed(0, y);
    trySeed(lastX, y);
  }
  let qh = 0;
  while (qh < qt) {
    const i = q[qh++];
    const x = i % cols;
    const y = (i / cols) | 0;
    if (x + 1 <= lastX) trySeed(x + 1, y);
    if (x > 0) trySeed(x - 1, y);
    if (y + 1 <= lastY) trySeed(x, y + 1);
    if (y > 0) trySeed(x, y - 1);
  }
  return mask;
}

function firstGroundedSurfaceY(field, x, mask) {
  const cols = field.cols;
  const rows = field.rows;
  const gx = x | 0;
  if (gx < 0 || gx >= cols) return -1;
  for (let y = 0; y < rows; y++) {
    if (mask[y * cols + gx]) return y;
  }
  return -1;
}

/** Sky boulder (drops) + grounded column, peninsula, arch. */
function stampDemoShapes(field) {
  const cols = field.cols;
  const skyEnd = Math.max(2, Math.floor(field.rows * SEED_SKY_FRAC));
  const fh = Math.min(10, skyEnd - 2);
  if (fh >= 4) {
    const fx = Math.max(2, (cols * SEED_STAMP.boulderX) | 0);
    stampFilled(field, fx, 1, fx + 16, 1 + fh, MAT_DIRT);
  }

  const grounded = markGroundedMask(field);
  const cx = Math.max(4, (cols * SEED_STAMP.columnX) | 0);
  const columnY = firstGroundedSurfaceY(field, cx, grounded);
  if (columnY > skyEnd + 8) {
    const h = columnY - skyEnd - 1;
    const colH = h < 36 ? h : 36;
    stampFilled(field, cx - 1, columnY - colH, cx + 2, columnY, MAT_DIRT);
  }

  const px = Math.max(8, (cols * SEED_STAMP.peninsulaX) | 0);
  const py = firstGroundedSurfaceY(field, px, grounded);
  if (py > skyEnd + 12) {
    stampFilled(field, px - 2, py - 8, px + 6, py, MAT_DIRT);
    stampFilled(field, px - 30, py - 11, px + 6, py - 8, MAT_DIRT);
  }

  const ax = Math.max(20, (cols * SEED_STAMP.archX) | 0);
  const yL = firstGroundedSurfaceY(field, ax, grounded);
  const yR = firstGroundedSurfaceY(field, ax + 18, grounded);
  if (yL > skyEnd + 16 && yR > skyEnd + 16) {
    const top = (yL < yR ? yL : yR) - 14;
    stampFilled(field, ax, top, ax + 3, yL, MAT_DIRT);
    stampFilled(field, ax + 16, top, ax + 19, yR, MAT_DIRT);
    stampFilled(field, ax, top - 4, ax + 19, top, MAT_DIRT);
  }
}

function findSkySpawn(field) {
  const cols = field.cols;
  const rows = field.rows;
  const cs = field.cellSize;
  const gx = (cols * 0.5) | 0;
  const amount = field.amount;
  const minGy = 4;
  let solidY = -1;
  for (let y = 0; y < rows; y++) {
    if (amount[y * cols + gx] >= ISO) {
      solidY = y;
      break;
    }
  }
  let gy = solidY < 0 ? Math.max(minGy, (rows * 0.2) | 0) : solidY - 4;
  if (gy < minGy) gy = minGy;
  if (gy >= rows) gy = rows - 1;
  if (amount[gy * cols + gx] < ISO) {
    return { x: (gx + 0.5) * cs, y: (gy + 0.5) * cs };
  }
  for (let y = minGy; y < rows; y++) {
    if (amount[y * cols + gx] < ISO) {
      return { x: (gx + 0.5) * cs, y: (y + 0.5) * cs };
    }
  }
  for (let x = 0; x < cols; x++) {
    if (amount[minGy * cols + x] < ISO) {
      return { x: (x + 0.5) * cs, y: (minGy + 0.5) * cs };
    }
  }
  return { x: (gx + 0.5) * cs, y: (minGy + 0.5) * cs };
}

function splitBoxQuads(box) {
  const midX = (box.minX + box.maxX) >> 1;
  const midY = (box.minY + box.maxY) >> 1;
  const out = [
    { minX: box.minX, minY: box.minY, maxX: midX, maxY: midY, quad: 0 },
    { minX: midX + 1, minY: box.minY, maxX: box.maxX, maxY: midY, quad: 1 },
    { minX: box.minX, minY: midY + 1, maxX: midX, maxY: box.maxY, quad: 2 },
    { minX: midX + 1, minY: midY + 1, maxX: box.maxX, maxY: box.maxY, quad: 3 },
  ];
  let w = 0;
  for (let i = 0; i < 4; i++) {
    if (out[i].maxX >= out[i].minX && out[i].maxY >= out[i].minY) out[w++] = out[i];
  }
  out.length = w;
  return out;
}

function smoothstep01(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function paintBrush(field, wx, wy, radius, hardness, strength, erase, material) {
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

function damageKernel(field, cx, cy, radius, power, falloff) {
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

function ensureMaskStore(field, n) {
  if (field._maskStore && field._maskStore.length >= n) return;
  field._maskStore = new Uint8Array(n);
}

function copyIslandNodes(island) {
  if (!island || !island.nodeCount) return new Int32Array(0);
  const n = island.nodeCount;
  const out = new Int32Array(n);
  out.set(island.nodeIdx.subarray(island.nodeStart, island.nodeStart + n));
  return out;
}

function packedBox(field, packed) {
  const cols = field.cols;
  const box = { minX: 0, minY: 0, maxX: -1, maxY: -1 };
  if (!packed || !packed.length) return box;
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < packed.length; i++) {
    const p = packed[i];
    const x = p % cols;
    const y = (p / cols) | 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  box.minX = minX;
  box.minY = minY;
  box.maxX = maxX;
  box.maxY = maxY;
  return box;
}

function isGroundedNodes(cols, lastX, lastY, packed, start, count) {
  for (let i = 0; i < count; i++) {
    const p = packed[start + i];
    const x = p % cols;
    const y = (p / cols) | 0;
    if (x === 0 || x === lastX || y === lastY) return true;
  }
  return false;
}

function isGrounded(field, island) {
  if (!island || !island.nodeCount) return false;
  if (island.grounded) return true;
  const cols = field.cols;
  return isGroundedNodes(cols, cols - 1, field.rows - 1, island.nodeIdx, island.nodeStart, island.nodeCount);
}

function touchesChunkEdge(field, island, box) {
  if (!island || !island.nodeCount || !box) return false;
  const cols = field.cols;
  const lastX = cols - 1;
  const lastY = field.rows - 1;
  const packed = island.nodeIdx;
  const start = island.nodeStart;
  const count = island.nodeCount;
  for (let i = 0; i < count; i++) {
    const p = packed[start + i];
    const x = p % cols;
    const y = (p / cols) | 0;
    if (x === box.minX && box.minX > 0) return true;
    if (x === box.maxX && box.maxX < lastX) return true;
    if (y === box.minY && box.minY > 0) return true;
    if (y === box.maxY && box.maxY < lastY) return true;
  }
  return false;
}

function isGroundedAt(field, sx, sy) {
  const cols = field.cols;
  const rows = field.rows;
  const amount = field.amount;
  if (!amount || sx < 0 || sy < 0 || sx >= cols || sy >= rows) return false;
  if (amount[sy * cols + sx] < ISO) return false;
  const lastX = cols - 1;
  const lastY = rows - 1;
  if (sx === 0 || sx === lastX || sy === lastY) return true;
  let yDown = sy;
  while (yDown < lastY && amount[(yDown + 1) * cols + sx] >= ISO) yDown++;
  if (yDown === lastY) return true;

  const n = cols * rows;
  ensureExtractScratch(field, n);
  const visited = field._visited;
  const queue = field._queue;
  if (field._visitGen > 0x7f000000) {
    visited.fill(0);
    field._visitGen = 1;
  }
  const floodId = field._visitGen++;
  let qh = 0;
  let qt = 0;
  const start = sy * cols + sx;
  queue[qt++] = start;
  visited[start] = floodId;
  while (qh < qt) {
    const packed = queue[qh++];
    const x = packed % cols;
    const y = (packed / cols) | 0;
    if (x === 0 || x === lastX || y === lastY) return true;
    if (x + 1 <= lastX) {
      const nIdx = packed + 1;
      if (visited[nIdx] !== floodId && amount[nIdx] >= ISO) {
        visited[nIdx] = floodId;
        queue[qt++] = nIdx;
      }
    }
    if (x - 1 >= 0) {
      const nIdx = packed - 1;
      if (visited[nIdx] !== floodId && amount[nIdx] >= ISO) {
        visited[nIdx] = floodId;
        queue[qt++] = nIdx;
      }
    }
    if (y + 1 <= lastY) {
      const nIdx = packed + cols;
      if (visited[nIdx] !== floodId && amount[nIdx] >= ISO) {
        visited[nIdx] = floodId;
        queue[qt++] = nIdx;
      }
    }
    if (y - 1 >= 0) {
      const nIdx = packed - cols;
      if (visited[nIdx] !== floodId && amount[nIdx] >= ISO) {
        visited[nIdx] = floodId;
        queue[qt++] = nIdx;
      }
    }
  }
  return false;
}

function meshNodes(field, packed) {
  if (!packed || !packed.length) return [];
  const n = field.cols * field.rows;
  ensureMaskStore(field, n);
  const mask = field._maskStore;
  mask.fill(0);
  const box = packedBox(field, packed);
  for (let i = 0; i < packed.length; i++) mask[packed[i]] = 1;
  field._extractMask = mask;
  try {
    const list = extractIslands(field, box, { clip: false });
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      const nodes = rec.nodeCount
        ? rec.nodeIdx.slice(rec.nodeStart, rec.nodeStart + rec.nodeCount)
        : new Int32Array(0);
      out.push({
        nodeIdx: nodes,
        nodeStart: 0,
        nodeCount: nodes.length,
        polys: rec.polys,
        cellsMeta: rec.cellsMeta,
        contour: rec.contour,
        loops: rec.loops,
        areaPx: rec.areaPx,
        areaCells: rec.areaCells,
        cellCx: rec.cellCx,
        cellCy: rec.cellCy,
        minX: rec.minX,
        minY: rec.minY,
        maxX: rec.maxX,
        maxY: rec.maxY,
        material: rec.material,
      });
    }
    return out;
  } finally {
    field._extractMask = null;
  }
}

WorldGrid.polygonArea = polygonArea;
WorldGrid.pointInPolygon = pointInPolygon;
WorldGrid.pointInConvex = pointInConvex;
WorldGrid.subdivideConvex = subdivideConvex;
WorldGrid.carveConvexAtPoint = carveConvexAtPoint;
WorldGrid.splitConvexAtPoint = splitConvexAtPoint;
WorldGrid.circleRing = circleRing;
WorldGrid.unionConvexPolys = unionConvexPolys;
WorldGrid.diffCircle = diffCircle;
WorldGrid.triangulateDelaunay = triangulateDelaunay;
WorldGrid.clipIslandAtPoint = clipIslandAtPoint;
WorldGrid.centroidFromPolys = centroidFromPolys;
WorldGrid.recenterPolys = recenterPolys;
WorldGrid.buildCellTriangleFixtures = buildCellTriangleFixtures;
WorldGrid.polysToLocal = polysToLocal;
WorldGrid.aabbOverlaps = aabbOverlaps;
