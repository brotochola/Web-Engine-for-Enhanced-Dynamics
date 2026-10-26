// angularSweep.js - what the visibility kernels share with the engine: the occluder kinds, the sweep's caps and
// constant tables (copied into visibilitySweep.wasm's memory), the compound solids' outlines (ensureCompoundSolid,
// their walk order for solidSegments.wasm), the polar bins' state and the vertex writers the gather and Pixi use.
// The JS sweep, the polar raster, the clip and the merge (E-76 W2a, W1; close-out group B) are
// tests/reference/visibilitySweepJs.mjs, the kernels' parity reference.

import { MAX_POLYGON_VERTICES } from '../../util/configDefaults.js';

const TWO_PI = Math.PI * 2;
const EPSILON = 1e-5;
// H-04. endAngle is a module constant, so these directions are too. The sweep
// used to call cos/sin on every light even though the comment below already
// called them fixed.
const END_ANGLE = Math.PI - EPSILON;
const END_DIR_C = Math.cos(END_ANGLE);
const END_DIR_S = Math.sin(END_ANGLE);
/** Empty-light disc tessellation only (not free-arc densify). */
const MAX_ARC_STEP = Math.PI / 16;
/** Max free sector before inserting midpoints. Chord stays outside R with FREE_OVERSIZE. */
const MAX_FREE_GAP = Math.PI / 2;
/** 1/cos(MAX_FREE_GAP/2) — chord of a max free sector lies on/outside radius R. */
const FREE_OVERSIZE = 1 / Math.cos(MAX_FREE_GAP * 0.5);

/** Circle occluder (analytical tangents + ray-circle). */
export const OCC_CIRCLE = 0;
/** Convex polygon occluder (world-space verts in shared pool). */
export const OCC_POLY = 1;

/** Squared distance from a point to a segment. */
export function segmentDistSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq > 0 ? (apx * abx + apy * aby) / abLenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = ax + abx * t - px;
  const dy = ay + aby * t - py;
  return dx * dx + dy * dy;
}

const MAX_EVENTS = 2048;

const MAX_OCC_CACHE = 1024;

const MAX_ACTIVE = 256;

/** Prebaked unit circle for empty-light full disc (step = MAX_ARC_STEP). */
const FULL_CIRCLE_SEGS = Math.ceil(TWO_PI / MAX_ARC_STEP);
const _fullCircleC = new Float64Array(FULL_CIRCLE_SEGS);
const _fullCircleS = new Float64Array(FULL_CIRCLE_SEGS);
for (let i = 0; i < FULL_CIRCLE_SEGS; i++) {
  const a = -Math.PI + i * (TWO_PI / FULL_CIRCLE_SEGS);
  _fullCircleC[i] = Math.cos(a);
  _fullCircleS[i] = Math.sin(a);
}
let _warnedEventOverflow = false;
let _warnedActiveOverflow = false;

function warnEventCap(occCount) {
  if (_warnedEventOverflow) return;
  _warnedEventOverflow = true;
  console.warn(
    `[AngularSweep] Event cap exceeded (${MAX_EVENTS} max events, ${occCount} occluders). ` +
    `Falling back to full-circle visibility for this light.`
  );
}

function warnActiveCap() {
  if (_warnedActiveOverflow) return;
  _warnedActiveOverflow = true;
  console.warn(
    `[AngularSweep] Active occluder cap exceeded (${MAX_ACTIVE} max simultaneous). ` +
    `Falling back to full-circle visibility for this light.`
  );
}

/**
 * W2a. The sweep kernel (visibilitySweep.wasm) gave up on a light as buildVisibilityPolygon does at its event
 * or active cap: the same warning, once per kind, shared with the JS sweep.
 */
export function warnSweepOverflow(eventOverflow, occCount) {
  if (eventOverflow) warnEventCap(occCount);
  else warnActiveCap();
}

/** The sweep's caps, for a kernel's scratch (W2a): it holds the JS's, so it gives up where the JS does. */
export const SWEEP_CAPS = Object.freeze({
  maxEvents: MAX_EVENTS,
  occCache: MAX_OCC_CACHE,
  maxActive: MAX_ACTIVE,
  fullCircleSegs: FULL_CIRCLE_SEGS,
});

/**
 * Write 4 world-space corners of an oriented box into a vertex pool.
 * Pass precomputed cos/sin (Transform.rotC/rotS) — no Math.cos/sin here.
 * @returns {number} verts written (always 4)
 */
export function writeOrientedBoxVerts(
  outX, outY, start,
  entityX, entityY, width, height, c, s, offsetX, offsetY
) {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const wx = entityX + c * offsetX - s * offsetY;
  const wy = entityY + s * offsetX + c * offsetY;

  // CCW: BL, BR, TR, TL. No per-call array.
  outX[start] = wx + c * -hw - s * -hh;
  outY[start] = wy + s * -hw + c * -hh;
  outX[start + 1] = wx + c * hw - s * -hh;
  outY[start + 1] = wy + s * hw + c * -hh;
  outX[start + 2] = wx + c * hw - s * hh;
  outY[start + 2] = wy + s * hw + c * hh;
  outX[start + 3] = wx + c * -hw - s * hh;
  outY[start + 3] = wy + s * -hw + c * hh;
  return 4;
}

/**
 * Write world-transformed convex polygon verts (local poly + cos/sin + offset).
 * @returns {number} verts written
 */
export function writePolygonVerts(
  outX, outY, start,
  entityX, entityY, c, s, offsetX, offsetY,
  localX, localY, localBase, count
) {
  const wx = entityX + c * offsetX - s * offsetY;
  const wy = entityY + s * offsetX + c * offsetY;
  for (let i = 0; i < count; i++) {
    const lx = localX[localBase + i];
    const ly = localY[localBase + i];
    outX[start + i] = wx + c * lx - s * ly;
    outY[start + i] = wy + s * lx + c * ly;
  }
  return count;
}

const FIXTURE_NONE = 0xffff;
const EDGE_QUANT = 1000;
const _solids = [];

function growFloats(arr, needed) {
  if (arr.length >= needed) return arr;
  let n = arr.length || 64;
  while (n < needed) n *= 2;
  const next = new Float32Array(n);
  if (arr.length) next.set(arr);
  return next;
}

// Edge table, reused by every rebuild: open addressing on the quantized ends,
// edge ids in first-seen order so the outline comes out in the order a Map
// keyed by strings gave. That Map made a string and an object per edge on
// every rebuild (review G1).
const EDGE_TABLE_START = 256;
let _edgeQ = new Float64Array(EDGE_TABLE_START * 4); // edge id -> quantized ends, canonical order
let _edgeN = new Uint32Array(EDGE_TABLE_START); // edge id -> times seen
let _edgeXY = new Float32Array(EDGE_TABLE_START * 4); // edge id -> first-seen ends
let _edgeSlot = new Int32Array(EDGE_TABLE_START * 2).fill(-1); // slot -> edge id, -1 empty
let _edgeMask = EDGE_TABLE_START * 2 - 1;
let _edgeCount = 0;

function edgeHash(ax, ay, bx, by) {
  let h = Math.imul(ax | 0, 0x9e3779b1) ^ Math.imul(ay | 0, 0x85ebca77)
    ^ Math.imul(bx | 0, 0xc2b2ae3d) ^ Math.imul(by | 0, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) & _edgeMask;
}

function edgeTableClear() {
  if (_edgeCount > 0) _edgeSlot.fill(-1);
  _edgeCount = 0;
}

/** Twice the edges, rehashed; the table stays at most half full. */
function edgeTableGrow() {
  const n = _edgeN.length * 2;
  const q = new Float64Array(n * 4);
  q.set(_edgeQ);
  const seen = new Uint32Array(n);
  seen.set(_edgeN);
  const xy = new Float32Array(n * 4);
  xy.set(_edgeXY);
  _edgeQ = q;
  _edgeN = seen;
  _edgeXY = xy;
  _edgeSlot = new Int32Array(n * 2).fill(-1);
  _edgeMask = n * 2 - 1;
  for (let id = 0; id < _edgeCount; id++) {
    const o = id * 4;
    let slot = edgeHash(q[o], q[o + 1], q[o + 2], q[o + 3]);
    while (_edgeSlot[slot] >= 0) slot = (slot + 1) & _edgeMask;
    _edgeSlot[slot] = id;
  }
}

// E-135. The fill's shared vertices: a soup vertex joins an earlier one only when both of its floats are the same
// bits, so the triangles drawn from them, and every attribute Pixi computes from a vertex, are the soup's.
// Open addressing over the bits; the slot holds a shared vertex's id, its first soup vertex says its bits.
let _vertSlot = new Int32Array(512).fill(-1);
let _vertFirst = new Int32Array(256);

/**
 * solid.fillPts (the distinct vertices, x and y), solid.fillPtCount and solid.fillIdx (per soup vertex, its shared
 * vertex: the triangles in the soup's order) from solid.fill.
 */
function indexFill(solid, n) {
  const fill = solid.fill;
  const bits = new Uint32Array(fill.buffer, fill.byteOffset, n * 2);
  solid.fillPts = growFloats(solid.fillPts, n * 2);
  if (solid.fillIdx.length < n) {
    let cap = solid.fillIdx.length || 64;
    while (cap < n) cap *= 2;
    solid.fillIdx = new Uint32Array(cap);
  }
  let slots = _vertSlot.length;
  if (slots < n * 2) {
    while (slots < n * 2) slots *= 2;
    _vertSlot = new Int32Array(slots);
  }
  if (_vertFirst.length < n) _vertFirst = new Int32Array(slots >> 1);
  _vertSlot.fill(-1);
  const slot = _vertSlot;
  const first = _vertFirst;
  const mask = slots - 1;
  const pts = solid.fillPts;
  const idx = solid.fillIdx;
  let m = 0;
  for (let v = 0; v < n; v++) {
    const bx = bits[v * 2];
    const by = bits[v * 2 + 1];
    let h = Math.imul(bx, 0x9e3779b1) ^ Math.imul(by, 0x85ebca77);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h = (h ^ (h >>> 12)) & mask;
    let id;
    for (;;) {
      id = slot[h];
      if (id < 0) {
        id = m++;
        slot[h] = id;
        first[id] = v;
        pts[id * 2] = fill[v * 2];
        pts[id * 2 + 1] = fill[v * 2 + 1];
        break;
      }
      const f = first[id];
      if (bits[f * 2] === bx && bits[f * 2 + 1] === by) break;
      h = (h + 1) & mask;
    }
    idx[v] = id;
  }
  solid.fillPtCount = m;
}

/**
 * Count one edge by its quantized ends, in canonical order, and return its id.
 * A new edge gets id === the count before the call; the caller stores its
 * float ends then. Only integers cross the call, so nothing is boxed when it
 * is not inlined.
 */
function edgeCount(qax, qay, qbx, qby) {
  if (_edgeCount === _edgeN.length) edgeTableGrow();
  const q = _edgeQ;
  let slot = edgeHash(qax, qay, qbx, qby);
  for (;;) {
    const id = _edgeSlot[slot];
    if (id < 0) break;
    const o = id * 4;
    if (q[o] === qax && q[o + 1] === qay && q[o + 2] === qbx && q[o + 3] === qby) {
      _edgeN[id]++;
      return id;
    }
    slot = (slot + 1) & _edgeMask;
  }
  const id = _edgeCount++;
  const o = id * 4;
  q[o] = qax;
  q[o + 1] = qay;
  q[o + 2] = qbx;
  q[o + 3] = qby;
  _edgeN[id] = 1;
  _edgeSlot[slot] = id;
  return id;
}

/**
 * Boundary segments and solid fill for one compound body.
 * Rebuilt only when the fixture pool revision changes.
 * Edges shared by two triangles are interior and dropped, so a canyon stays a hole.
 * `wantFill` false skips the fill triangles: pre-render reads only the segments,
 * and each worker keeps its own cache (review D1).
 * With the fill, its shared vertices too (E-135): `fillPts` (x, y), `fillPtCount`, and `fillIdx`, the shared vertex of
 * each of the `fillVerts` soup vertices.
 * @returns {{ revision: number, seg: Float32Array, segCount: number, fill: Float32Array, fillVerts: number, fillPts: Float32Array, fillPtCount: number, fillIdx: Uint32Array, hasFill: boolean, chain: Int32Array, chainValid: boolean }}
 */
export function ensureCompoundSolid(
  entityIdx, revision,
  head, next, active, vertCount, vertX, vertY,
  headIdx, poolMax, wantFill = true
) {
  let solid = _solids[entityIdx];
  if (solid && solid.revision === revision && (solid.hasFill || !wantFill)) return solid;
  if (!solid) {
    solid = {
      revision: -1,
      seg: new Float32Array(64),
      segCount: 0,
      fill: new Float32Array(64),
      fillVerts: 0,
      fillPts: new Float32Array(64),
      fillPtCount: 0,
      fillIdx: new Uint32Array(64),
      hasFill: false,
      // Pre-render's walk order over seg (E-61), built on its first use.
      chain: new Int32Array(64),
      chainValid: false,
      // W1: where pre-render's solid raster kernel has its copy of seg and chain (solidSegmentsClient.js):
      // the byte offsets, the edges the slot holds, and the revision and memory epoch it was copied at.
      wasmSegByte: 0,
      wasmChainByte: 0,
      wasmCap: 0,
      wasmRevision: -1,
      wasmEpoch: -1,
    };
    // Fill the gap so the array stays packed: a first write past ~1024 empty
    // slots turns it into a dictionary, and every cache hit then costs a hash
    // lookup (3x slower, review V5).
    while (_solids.length < entityIdx) _solids.push(null);
    _solids[entityIdx] = solid;
  }
  solid.segCount = 0;
  solid.fillVerts = 0;
  solid.fillPtCount = 0;
  solid.chainValid = false;
  edgeTableClear();
  if (head && next && active && vertX && vertY && headIdx != null && headIdx !== FIXTURE_NONE) {
    let cur = headIdx;
    let guard = 0;
    const limit = poolMax | 0;
    let fillN = 0;
    while (cur !== FIXTURE_NONE && guard++ < limit) {
      if (active[cur]) {
        const count = vertCount[cur] | 0;
        if (count >= 3 && count <= MAX_POLYGON_VERTICES) {
          const base = cur * MAX_POLYGON_VERTICES;
          if (wantFill) {
            const need = (fillN + (count - 2) * 3) * 2;
            solid.fill = growFloats(solid.fill, need);
            const fill = solid.fill;
            const x0 = vertX[base];
            const y0 = vertY[base];
            for (let i = 1; i < count - 1; i++) {
              const o = fillN * 2;
              fill[o] = x0;
              fill[o + 1] = y0;
              fill[o + 2] = vertX[base + i];
              fill[o + 3] = vertY[base + i];
              fill[o + 4] = vertX[base + i + 1];
              fill[o + 5] = vertY[base + i + 1];
              fillN += 3;
            }
          }
          for (let i = 0; i < count; i++) {
            const j = i + 1 < count ? i + 1 : 0;
            const ax = vertX[base + i];
            const ay = vertY[base + i];
            const bx = vertX[base + j];
            const by = vertY[base + j];
            const iax = Math.round(ax * EDGE_QUANT);
            const iay = Math.round(ay * EDGE_QUANT);
            const ibx = Math.round(bx * EDGE_QUANT);
            const iby = Math.round(by * EDGE_QUANT);
            if (iax === ibx && iay === iby) continue;
            const swap = ibx < iax || (ibx === iax && iby < iay);
            const fresh = _edgeCount;
            const id = edgeCount(swap ? ibx : iax, swap ? iby : iay, swap ? iax : ibx, swap ? iay : iby);
            if (id === fresh) {
              const e = id * 4;
              _edgeXY[e] = ax;
              _edgeXY[e + 1] = ay;
              _edgeXY[e + 2] = bx;
              _edgeXY[e + 3] = by;
            }
          }
        }
      }
      cur = next[cur];
    }
    solid.fillVerts = fillN;
    if (wantFill && fillN > 0) indexFill(solid, fillN);
    let segN = 0;
    for (let id = 0; id < _edgeCount; id++) {
      if (_edgeN[id] !== 1) continue;
      solid.seg = growFloats(solid.seg, (segN + 1) * 4);
      const o = segN * 4;
      const e = id * 4;
      solid.seg[o] = _edgeXY[e];
      solid.seg[o + 1] = _edgeXY[e + 1];
      solid.seg[o + 2] = _edgeXY[e + 2];
      solid.seg[o + 3] = _edgeXY[e + 3];
      segN++;
    }
    solid.segCount = segN;
  }
  solid.revision = revision;
  solid.hasFill = !!wantFill;
  return solid;
}

/**
 * Whether an outline segment faces a point: the segment's outward normal
 * (dy, -dx) points to the point's side. True for CCW outlines, which is how
 * ensureCompoundSolid keeps each edge (its fixture's order).
 */
export function segmentFacesPoint(x0, y0, x1, y1, px, py) {
  return (y1 - y0) * (px - x0) - (x1 - x0) * (py - y0) > 0;
}

// E-61. Rastering an edge costs two atan2, one per end, and an outline's edges
// share their ends. seg keeps the order the triangles gave (Pixi draws its
// transmit wedges in that order), so collectSolidSegments walks solid.chain
// instead: each edge followed, where there is one, by the edge that starts
// exactly where it ends, and reuses the end angle it just computed as the next
// start. The bins take a minimum, which is the same in any order, and the
// callers read only hit > 0.
let _chainHead = new Int32Array(512).fill(-1); // hash slot -> an edge starting there
let _chainNext = new Int32Array(256); // edge -> the next edge in its slot
let _chainUsed = new Uint8Array(256);

function chainSlot(x, y, mask) {
  let h = Math.imul(Math.round(x * EDGE_QUANT) | 0, 0x9e3779b1) ^ Math.imul(Math.round(y * EDGE_QUANT) | 0, 0x85ebca77);
  h ^= h >>> 15;
  return h & mask;
}

function chainSolidSegments(solid) {
  const n = solid.segCount;
  if (solid.chain.length < n) solid.chain = new Int32Array(n * 2);
  if (_chainNext.length < n) {
    _chainNext = new Int32Array(n * 2);
    _chainUsed = new Uint8Array(n * 2);
  }
  if (_chainHead.length < n * 2) {
    let size = _chainHead.length;
    while (size < n * 2) size *= 2;
    _chainHead = new Int32Array(size).fill(-1);
  }
  const head = _chainHead;
  const mask = head.length - 1;
  const seg = solid.seg;
  for (let i = 0; i < n; i++) {
    const slot = chainSlot(seg[i * 4], seg[i * 4 + 1], mask);
    _chainNext[i] = head[slot];
    head[slot] = i;
  }
  _chainUsed.fill(0, 0, n);
  const chain = solid.chain;
  let out = 0;
  for (let first = 0; first < n; first++) {
    let cur = _chainUsed[first] ? -1 : first;
    while (cur >= 0) {
      _chainUsed[cur] = 1;
      chain[out++] = cur;
      const ex = seg[cur * 4 + 2];
      const ey = seg[cur * 4 + 3];
      let cand = head[chainSlot(ex, ey, mask)];
      while (cand >= 0 && (_chainUsed[cand] || seg[cand * 4] !== ex || seg[cand * 4 + 1] !== ey)) {
        cand = _chainNext[cand];
      }
      cur = cand;
    }
  }
  // Empty only the slots used: the table may be sized for a far larger outline.
  for (let i = 0; i < n; i++) head[chainSlot(seg[i * 4], seg[i * 4 + 1], mask)] = -1;
  solid.chainValid = true;
}

/** W1. The solid's walk order (solid.chain), built if it is not, for a kernel that copies it. */
export function ensureSolidChain(solid) {
  if (!solid.chainValid) chainSolidSegments(solid);
}

/**
 * ponytail: 512 bins is about 0.7°. A canyon narrower than one bin at that
 * distance can seal. More bins is the upgrade; the visibility slot already
 * allows 5000 vertices.
 */
export const POLAR_BINS = 512;
// cos/sin of every angle the polar loops use: index m is -π + m·½·(2π/POLAR_BINS),
// the loops' own expression (bin b centre: m = 2b + 1; a group b0..b1: m = b0 + b1),
// so a lookup gives the same double as the call it replaces (E-42).
const _polarCos = new Float64Array(POLAR_BINS * 2 + 1);
const _polarSin = new Float64Array(POLAR_BINS * 2 + 1);
for (let m = 0; m <= POLAR_BINS * 2; m++) {
  const ang = -Math.PI + m * 0.5 * (TWO_PI / POLAR_BINS);
  _polarCos[m] = Math.cos(ang);
  _polarSin[m] = Math.sin(ang);
}
// The bins are the module's own arrays, or views on pre-render's visibility memory while its kernels run
// (bindPolarBins: W2a, W1), so the kernels (and the JS reference) read and write the same bytes.
const _ownPolarDist = new Float32Array(POLAR_BINS);
// N-19: who stamped each bin's nearest hit (-1: nothing), so the caller can
// tell which solids end up on the polygon.
const _ownPolarOwner = new Int32Array(POLAR_BINS);
let _polarDist = _ownPolarDist;
let _polarOwner = _ownPolarOwner;
let _polarActive = 0;

export function clearPolarBins(radius) {
  const r = radius > 0 ? radius : 0;
  _polarActive = 0;
  _polarDist.fill(r);
  _polarOwner.fill(-1);
}

/**
 * W2b: clearPolarBins' state for a light whose solids are not known yet, without the fill: nothing reads the bins
 * while polarBinsActive() is 0, and the light's first raster calls clearPolarBins first.
 */
export function skipPolarBins() {
  _polarActive = 0;
}

export function polarBinsActive() {
  return _polarActive;
}

/** W1. A kernel stamped the bins (solidSegments.wasm's active word): what rasterPolarSpan records. */
export function markPolarBinsActive() {
  _polarActive = 1;
}

/** W1. Each bin's centre ray (stampPolarBin's _polarCos / _polarSin at 2b + 1), copied for a kernel. */
export function polarCentreTables() {
  const cos = new Float64Array(POLAR_BINS);
  const sin = new Float64Array(POLAR_BINS);
  for (let b = 0; b < POLAR_BINS; b++) {
    cos[b] = _polarCos[2 * b + 1];
    sin[b] = _polarSin[2 * b + 1];
  }
  return { cos, sin };
}

/**
 * W2a, W1. Raster and merge into `dist` (Float32Array) and `owner` (Int32Array) of POLAR_BINS each, views on
 * pre-render's visibility memory where its kernels read and write the bins; null puts the module's own
 * arrays back (a scene on the JS path). The bins are cleared either way.
 */
export function bindPolarBins(dist, owner) {
  if (dist === null || owner === null) {
    _polarDist = _ownPolarDist;
    _polarOwner = _ownPolarOwner;
  } else {
    if (!(dist instanceof Float32Array) || !(owner instanceof Int32Array) ||
        dist.length !== POLAR_BINS || owner.length !== POLAR_BINS) {
      throw new Error(`bindPolarBins: a Float32Array and an Int32Array of ${POLAR_BINS}`);
    }
    _polarDist = dist;
    _polarOwner = owner;
  }
  clearPolarBins(0);
}

/** The arrays the bins are in now (bindPolarBins); for tests. */
export function polarBinArrays() {
  return { dist: _polarDist, owner: _polarOwner, own: _polarDist === _ownPolarDist };
}

// A stand-in for atan2(y, x) that keeps its order over (-π, π]: -2 at -π, 0 at
// 0, 2 at π, one unit per quarter turn. Its slope is 1/2 to 1 per radian, so a
// pad of ARC_PAD units covers at least ARC_PAD radians.
function pseudoAngle(x, y) {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const p = ay / (ax + ay);
  if (y < 0) return x < 0 ? p - 2 : -p;
  return x < 0 ? 2 - p : p;
}
const _polarPseudo = new Float64Array(POLAR_BINS * 2 + 1);
for (let m = 0; m <= POLAR_BINS * 2; m++) _polarPseudo[m] = pseudoAngle(_polarCos[m], _polarSin[m]);
/**
 * W2a. This module's constant tables, copied for the sweep kernel, which reads them from its memory and so
 * computes with these doubles: `consts` [1 / cos(MAX_FREE_GAP / 2), cos(END_ANGLE), sin(END_ANGLE)], the empty
 * light's 32-gon (`fullC`, `fullS`: SWEEP_CAPS.fullCircleSegs each) and the polar angles' cos, sin and
 * pseudoAngle (POLAR_BINS * 2 + 1 each).
 */
export function copySweepTables({ consts, fullC, fullS, polarCos, polarSin, polarPseudo }) {
  consts[0] = FREE_OVERSIZE;
  consts[1] = END_DIR_C;
  consts[2] = END_DIR_S;
  fullC.set(_fullCircleC);
  fullS.set(_fullCircleS);
  polarCos.set(_polarCos);
  polarSin.set(_polarSin);
  polarPseudo.set(_polarPseudo);
}
