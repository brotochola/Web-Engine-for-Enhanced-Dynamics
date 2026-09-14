/**
 * Viewport-chunk helpers for tilemap background culling.
 * Chunks are prebuilt meshes; runtime only toggles visibility / streams new ones.
 */

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
 * @param {number} cx
 * @param {number} cy
 * @returns {string}
 */
export function chunkKey(cx, cy) {
  return cx + ',' + cy;
}

/**
 * Inclusive chunk index range overlapping [viewMin, viewMax) expanded by ring.
 * @returns {{ minC: number, maxC: number }} maxC < minC means empty
 */
export function overlappingChunkRange(viewMin, viewMax, chunkSize, mapTiles, ring = 0) {
  const cs = Math.max(1, chunkSize | 0);
  const last = Math.max(0, Math.ceil(mapTiles / cs) - 1);
  const r = Math.max(0, ring | 0);
  if (!(mapTiles > 0) || !(viewMax > viewMin)) {
    return { minC: 0, maxC: -1 };
  }
  let minC = Math.floor(viewMin / cs) - r;
  let maxC = Math.floor((viewMax - 1e-9) / cs) + r;
  if (minC < 0) minC = 0;
  if (maxC > last) maxC = last;
  if (minC > maxC) return { minC: 0, maxC: -1 };
  return { minC, maxC };
}

/**
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function chunkTileRect(cx, cy, chunkW, chunkH, mapW, mapH) {
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
  return { minX, minY, maxX, maxY };
}

/**
 * Chunks overlapping the view tile rect, plus `ring` neighbors.
 *
 * @param {object} args
 * @param {number} args.viewMinX
 * @param {number} args.viewMinY
 * @param {number} args.viewMaxX - exclusive
 * @param {number} args.viewMaxY - exclusive
 * @param {number} args.chunkW
 * @param {number} args.chunkH
 * @param {number} [args.ring=1]
 * @param {number} args.mapW
 * @param {number} args.mapH
 * @returns {{ cx: number, cy: number, key: string, tileRect: { minX: number, minY: number, maxX: number, maxY: number } }[]}
 */
export function listVisibleChunks({
  viewMinX,
  viewMinY,
  viewMaxX,
  viewMaxY,
  chunkW,
  chunkH,
  ring = 1,
  mapW,
  mapH,
}) {
  const xr = overlappingChunkRange(viewMinX, viewMaxX, chunkW, mapW, ring);
  const yr = overlappingChunkRange(viewMinY, viewMaxY, chunkH, mapH, ring);
  const out = [];
  if (xr.maxC < xr.minC || yr.maxC < yr.minC) return out;
  const cw = Math.max(1, chunkW | 0);
  const ch = Math.max(1, chunkH | 0);
  for (let cy = yr.minC; cy <= yr.maxC; cy++) {
    for (let cx = xr.minC; cx <= xr.maxC; cx++) {
      out.push({
        cx,
        cy,
        key: chunkKey(cx, cy),
        tileRect: chunkTileRect(cx, cy, cw, ch, mapW, mapH),
      });
    }
  }
  return out;
}

/**
 * Cached keys that are not in the keep set (outside cacheGrid).
 * @param {Iterable<string>} cachedKeys
 * @param {Iterable<string>|Set<string>} keepKeys
 * @returns {string[]}
 */
export function listEvictChunkKeys(cachedKeys, keepKeys) {
  const keep = keepKeys instanceof Set ? keepKeys : new Set(keepKeys);
  const evict = [];
  for (const key of cachedKeys) {
    if (!keep.has(key)) evict.push(key);
  }
  return evict;
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
