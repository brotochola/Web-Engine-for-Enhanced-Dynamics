/**
 * Viewport-chunk helpers for tilemap background culling.
 * Chunks are prebuilt meshes; runtime only toggles visibility / streams new ones.
 *
 * Packed keys are `cx << 16 | cy` as uint32. Valid for chunk indices in
 * [0, 65535] on each axis (65536 chunks per side). Maps bigger than that
 * need a different key; current cull never emits negative indices.
 */

/** Max chunk index per axis that still fits `chunkKey`. */
export const CHUNK_KEY_AXIS_MAX = 65535;
const AXIS_MASK = 0xffff;

const _rangeX = { minC: 0, maxC: -1 };
const _rangeY = { minC: 0, maxC: -1 };
const _tileRectScratch = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const _chunkPool = [];
const _listResult = { chunks: _chunkPool, count: 0 };
const _evictKeys = [];
const _keepSetScratch = new Set();

/**
 * @param {number} viewWTiles - Viewport width in tiles
 * @param {number} viewHTiles - Viewport height in tiles
 * @param {number} [fixedChunkTiles=0] - If >0, square chunk size in tiles
 * @returns {{ chunkW: number, chunkH: number }}
 */
export function deriveViewportChunkSize(viewWTiles, viewHTiles, fixedChunkTiles = 0) {
  const fixed = fixedChunkTiles | 0;
  if (fixed > 0) {
    return { chunkW: fixed, chunkH: fixed };
  }
  const chunkW = Math.max(1, Math.ceil(viewWTiles));
  const chunkH = Math.max(1, Math.ceil(viewHTiles));
  return { chunkW, chunkH };
}

/**
 * Force odd positive grid (3, 5, …). Even values bump to next odd.
 * @param {number} chunkGrid
 * @returns {number}
 */
export function normalizeChunkGrid(chunkGrid) {
  let g = chunkGrid | 0;
  if (g < 1) g = 1;
  if ((g & 1) === 0) g += 1;
  return g;
}

/**
 * Rings around the overlap AABB. Odd grid G → ring (G-1)/2.
 * chunkGrid 1 → 0, 3 → 1; cacheGrid 5 → 2. Even values bump to next odd.
 * @param {number} grid
 * @returns {number}
 */
export function chunkRing(grid) {
  return (normalizeChunkGrid(grid) - 1) >> 1;
}

/**
 * Packed chunk key. Ceiling: cx, cy in [0, 65535].
 * @param {number} cx
 * @param {number} cy
 * @returns {number}
 */
export function chunkKey(cx, cy) {
  return (((cx & AXIS_MASK) << 16) | (cy & AXIS_MASK)) >>> 0;
}

/** @param {number} key */
export function chunkKeyCx(key) {
  return (key >>> 16) & AXIS_MASK;
}

/** @param {number} key */
export function chunkKeyCy(key) {
  return key & AXIS_MASK;
}

function fillRange(viewMin, viewMax, chunkSize, mapTiles, ring, out) {
  const cs = Math.max(1, chunkSize | 0);
  const last = Math.max(0, Math.ceil(mapTiles / cs) - 1);
  const r = Math.max(0, ring | 0);
  if (!(mapTiles > 0) || !(viewMax > viewMin)) {
    out.minC = 0;
    out.maxC = -1;
    return out;
  }
  let minC = Math.floor(viewMin / cs) - r;
  let maxC = Math.floor((viewMax - 1e-9) / cs) + r;
  if (minC < 0) minC = 0;
  if (maxC > last) maxC = last;
  if (minC > maxC) {
    out.minC = 0;
    out.maxC = -1;
    return out;
  }
  out.minC = minC;
  out.maxC = maxC;
  return out;
}

/**
 * Inclusive chunk index range overlapping [viewMin, viewMax) expanded by ring.
 * @returns {{ minC: number, maxC: number }} maxC < minC means empty
 */
export function overlappingChunkRange(viewMin, viewMax, chunkSize, mapTiles, ring = 0, out = _rangeX) {
  return fillRange(viewMin, viewMax, chunkSize, mapTiles, ring, out);
}

/**
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function chunkTileRect(cx, cy, chunkW, chunkH, mapW, mapH, out = _tileRectScratch) {
  const cw = Math.max(1, chunkW | 0);
  const ch = Math.max(1, chunkH | 0);
  let minX = cx * cw;
  let minY = cy * ch;
  let maxX = minX + cw;
  let maxY = minY + ch;
  if (minX < 0) minX = 0;
  if (minY < 0) minY = 0;
  if (maxX > mapW) maxX = mapW;
  if (maxY > mapH) maxY = mapH;
  if (minX > maxX) minX = maxX;
  if (minY > maxY) minY = maxY;
  out.minX = minX;
  out.minY = minY;
  out.maxX = maxX;
  out.maxY = maxY;
  return out;
}

function acquireChunk(pool, i) {
  let c = pool[i];
  if (!c) {
    c = { cx: 0, cy: 0, key: 0, tileRect: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
    pool[i] = c;
  }
  return c;
}

/**
 * Chunks overlapping the view tile rect, plus `ring` neighbors.
 * Fills `out.chunks[0..out.count)` from a pool. Shared module `out` is
 * clobbered by the next call — pass a distinct `out` when two lists live at once.
 *
 * @param {object} args reused visArgs (no ring field)
 * @param {number} [ring=1]
 * @param {{ chunks: object[], count: number }} [out]
 * @returns {{ chunks: object[], count: number }}
 */
export function listVisibleChunks(args, ring = 1, out = _listResult) {
  const xr = fillRange(args.viewMinX, args.viewMaxX, args.chunkW, args.mapW, ring, _rangeX);
  const yr = fillRange(args.viewMinY, args.viewMaxY, args.chunkH, args.mapH, ring, _rangeY);
  if (!out.chunks) out.chunks = [];
  const pool = out.chunks;
  if (xr.maxC < xr.minC || yr.maxC < yr.minC) {
    out.count = 0;
    return out;
  }
  const cw = Math.max(1, args.chunkW | 0);
  const ch = Math.max(1, args.chunkH | 0);
  const mapW = args.mapW;
  const mapH = args.mapH;
  let n = 0;
  for (let cy = yr.minC; cy <= yr.maxC; cy++) {
    for (let cx = xr.minC; cx <= xr.maxC; cx++) {
      const chunk = acquireChunk(pool, n);
      chunk.cx = cx;
      chunk.cy = cy;
      chunk.key = chunkKey(cx, cy);
      chunkTileRect(cx, cy, cw, ch, mapW, mapH, chunk.tileRect);
      n++;
    }
  }
  out.count = n;
  return out;
}

/**
 * Cached keys that are not in the keep set (outside cacheGrid).
 * Mutates `out` (default module scratch) and truncates `.length` to the fill count.
 * @param {Iterable<number>} cachedKeys
 * @param {Iterable<number>|Set<number>} keepKeys
 * @param {number[]} [out]
 * @returns {number[]}
 */
export function listEvictChunkKeys(cachedKeys, keepKeys, out = _evictKeys) {
  const keep = keepKeys instanceof Set ? keepKeys : _keepSetScratch;
  if (!(keepKeys instanceof Set)) {
    keep.clear();
    for (const k of keepKeys) keep.add(k);
  }
  let n = 0;
  for (const key of cachedKeys) {
    if (!keep.has(key)) {
      out[n++] = key;
    }
  }
  out.length = n;
  return out;
}

/**
 * Camera tile coords → chunk index + clamped tileRect for the NxN neighborhood.
 *
 * @param {object} args
 * @param {number} args.cameraTileX - Camera center in tile space (can be fractional)
 * @param {number} args.cameraTileY
 * @param {number} args.chunkW
 * @param {number} args.chunkH
 * @param {number} [args.chunkGrid=3]
 * @param {number} [args.margin=0]
 * @param {number} args.mapW
 * @param {number} args.mapH
 * @returns {{ chunkX: number, chunkY: number, tileRect: { minX: number, minY: number, maxX: number, maxY: number } }}
 */
export function computeChunkTileRect({
  cameraTileX,
  cameraTileY,
  chunkW,
  chunkH,
  chunkGrid = 3,
  margin = 0,
  mapW,
  mapH,
}) {
  const cw = Math.max(1, chunkW | 0);
  const ch = Math.max(1, chunkH | 0);
  const grid = normalizeChunkGrid(chunkGrid);
  const half = (grid - 1) >> 1;
  const m = margin | 0;

  const chunkX = Math.floor(cameraTileX / cw);
  const chunkY = Math.floor(cameraTileY / ch);

  let minX = (chunkX - half) * cw - m;
  let minY = (chunkY - half) * ch - m;
  let maxX = (chunkX + half + 1) * cw + m;
  let maxY = (chunkY + half + 1) * ch + m;

  if (minX < 0) minX = 0;
  if (minY < 0) minY = 0;
  if (maxX > mapW) maxX = mapW;
  if (maxY > mapH) maxY = mapH;
  if (minX > maxX) minX = maxX;
  if (minY > maxY) minY = maxY;

  return {
    chunkX,
    chunkY,
    tileRect: { minX, minY, maxX, maxY },
  };
}
