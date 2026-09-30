/**
 * Compact shadow casters and honor maxShadowsPerLight / maxShadowsPerEntity
 * without packing CPU shadow sprites. Lights closest to the caster, then
 * casters closest to that light.
 */

import { GPU_CASTER_LIGHT_FLOAT, GPU_SPRITE_FLOATS } from './gpuQueueLayout.js';

export function compactShadowCasterIndices(shadowH, typeArr, count, outIdx) {
  let n = 0;
  const cap = outIdx.length;
  const nSrc = count | 0;
  for (let i = 0; i < nSrc && n < cap; i++) {
    if (typeArr && typeArr[i] === 3) continue;
    if (shadowH && shadowH[i] > 0) outIdx[n++] = i;
  }
  return n;
}

/** Light vec4 on a caster row: x, y, intensity, rangeSq. Same slot as aInstLight. */
export const CASTER_LIGHT_FLOAT = GPU_CASTER_LIGHT_FLOAT;

/** Copy n typed-array slots. Avoids `.subarray` views in per-instance loops. */
export function copyTypedRange(dst, d0, src, s0, n) {
  for (let i = 0; i < n; i++) dst[d0 + i] = src[s0 + i];
}

/**
 * Copy packed caster slots and stamp one light vec4 on each.
 * `indices` are source instance slots. Stops at `cap` instances.
 * `lightOffset` indexes into `light` (0 when `light` is already a vec4).
 * Returns how many were written (dstBase + written).
 */
export function appendStampedCasters(dst, dstFloats, dstBase, src, srcFloats, indices, n, light, cap, lightOffset) {
  const sf = srcFloats | 0;
  const df = dstFloats | 0;
  const limit = cap | 0;
  let out = dstBase | 0;
  const count = n | 0;
  const o = lightOffset | 0;
  const lx = light[o];
  const ly = light[o + 1];
  const lz = light[o + 2];
  const lw = light[o + 3];
  const lightAt = CASTER_LIGHT_FLOAT;
  const row = sf < df ? sf : df;
  for (let k = 0; k < count && out < limit; k++) {
    const i = indices[k] | 0;
    const s0 = i * sf;
    const d0 = out * df;
    copyTypedRange(dst, d0, src, s0, row);
    dst[d0 + lightAt] = lx;
    dst[d0 + lightAt + 1] = ly;
    dst[d0 + lightAt + 2] = lz;
    dst[d0 + lightAt + 3] = lw;
    out++;
  }
  return out;
}

/** World-unit bins for the per-light caster walk. Larger than a character, smaller than the zoom-0.4 view. */
const STAMP_CELL = 256;
/** ponytail: above this the bin grid is skipped and the full caster scan runs. Raise the arrays if a map is wider than 128 cells. */
const STAMP_GRID_MAX_CELLS = 128 * 128;

const _stampGridResult = { minX: 0, minY: 0, gw: 0, gh: 0, cells: 0 };

function buildStampGrid(sun, nSun, sf, counts, starts, items) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    const x = sun[b];
    const y = sun[b + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  const gw = (Math.floor((maxX - minX) / STAMP_CELL) | 0) + 1;
  const gh = (Math.floor((maxY - minY) / STAMP_CELL) | 0) + 1;
  const cells = gw * gh;
  if (gw < 1 || gh < 1 || cells > counts.length || cells > STAMP_GRID_MAX_CELLS || nSun > items.length) {
    return null;
  }
  counts.fill(0, 0, cells);
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    let col = Math.floor((sun[b] - minX) / STAMP_CELL) | 0;
    let row = Math.floor((sun[b + 1] - minY) / STAMP_CELL) | 0;
    if (col < 0) col = 0;
    else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0;
    else if (row >= gh) row = gh - 1;
    counts[row * gw + col]++;
  }
  let sum = 0;
  for (let i = 0; i < cells; i++) {
    starts[i] = sum;
    sum += counts[i];
  }
  starts[cells] = nSun;
  const cursor = counts;
  for (let i = 0; i < cells; i++) cursor[i] = starts[i];
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    let col = Math.floor((sun[b] - minX) / STAMP_CELL) | 0;
    let row = Math.floor((sun[b + 1] - minY) / STAMP_CELL) | 0;
    if (col < 0) col = 0;
    else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0;
    else if (row >= gh) row = gh - 1;
    const cell = row * gw + col;
    items[cursor[cell]++] = c;
  }
  _stampGridResult.minX = minX;
  _stampGridResult.minY = minY;
  _stampGridResult.gw = gw;
  _stampGridResult.gh = gh;
  _stampGridResult.cells = cells;
  return _stampGridResult;
}

function sortPairsByIndex(idx, distArr, count) {
  const m = count | 0;
  let gap = 1;
  while (gap < m) gap = gap * 3 + 1;
  while (gap > 1) {
    gap = (gap / 3) | 0;
    if (gap < 1) gap = 1;
    for (let i = gap; i < m; i++) {
      const ic = idx[i];
      const id = distArr[i];
      let j = i;
      while (j >= gap && idx[j - gap] > ic) {
        idx[j] = idx[j - gap];
        distArr[j] = distArr[j - gap];
        j -= gap;
      }
      idx[j] = ic;
      distArr[j] = id;
    }
    if (gap === 1) break;
  }
}

/** Integer RT pixels. Nominal resolution is not the framebuffer size. */
export function rtPixelSize(canvasPx, resolution) {
  const r = resolution > 0 ? +resolution : 1;
  return Math.max(1, Math.round((+canvasPx || 0) * r));
}

/** RT pixels / canvas pixels. Projection and display use this, not the nominal resolution. */
export function rtPixelScale(canvasPx, rtPx) {
  return canvasPx > 0 ? rtPx / canvasPx : 1;
}


/**
 * Stamp a strided light range against packed sun rows (xy in each instance).
 * `lightBegin` + `lightStride` split `_collectStampLights` across workers.
 * Returns the stamp instance cursor (dstBase + written).
 * Pair set matches a serial walk when maxPerEntity is 0 (default).
 */
export function stampLightRange({
  sun,
  sunN,
  sunFloats,
  lights,
  lightBegin,
  lightEnd,
  lightStride,
  maxPerLight,
  maxPerEntity,
  used,
  tmpIdx,
  dist,
  order,
  keepIdx,
  gridCounts,
  gridStarts,
  gridItems,
  stamp,
  stampFloats,
  stampCap,
  stampBase,
  stampLightIdx,
  lightVec,
}) {
  const nSun = sunN | 0;
  const sf = sunFloats | 0;
  const capL = lightEnd | 0;
  const stride = (lightStride | 0) > 0 ? (lightStride | 0) : 1;
  let begin = lightBegin | 0;
  if (begin < 0) begin = 0;
  const maxPL = maxPerLight | 0;
  const maxPE = maxPerEntity | 0;
  if (used && maxPE > 0 && nSun > 0) used.fill(0, 0, nSun);
  let cursor = stampBase | 0;
  const cap = stampCap | 0;
  if (!sun || !stamp || nSun <= 0 || !lights || !tmpIdx || !dist || !keepIdx || !lightVec) return cursor;
  const tmpCap = tmpIdx.length | 0;
  const grid = gridCounts && gridStarts && gridItems
    ? buildStampGrid(sun, nSun, sf, gridCounts, gridStarts, gridItems)
    : null;
  for (let i = begin; i < capL && cursor < cap; i += stride) {
    const L = lights[i];
    if (!L || !(L.rangeSq > 0) || !(L.intensity > 0)) continue;
    const lim = maxPL > 0 ? maxPL : nSun;
    let m = 0;
    const lx = L.x;
    const ly = L.y;
    const rangeSq = L.rangeSq;
    if (grid) {
      const r = Math.sqrt(rangeSq);
      let col0 = Math.floor((lx - r - grid.minX) / STAMP_CELL) | 0;
      let col1 = Math.floor((lx + r - grid.minX) / STAMP_CELL) | 0;
      let row0 = Math.floor((ly - r - grid.minY) / STAMP_CELL) | 0;
      let row1 = Math.floor((ly + r - grid.minY) / STAMP_CELL) | 0;
      if (col0 < 0) col0 = 0;
      if (row0 < 0) row0 = 0;
      if (col1 >= grid.gw) col1 = grid.gw - 1;
      if (row1 >= grid.gh) row1 = grid.gh - 1;
      for (let row = row0; row <= row1 && m < tmpCap; row++) {
        const rowBase = row * grid.gw;
        for (let col = col0; col <= col1 && m < tmpCap; col++) {
          const cell = rowBase + col;
          const from = gridStarts[cell];
          const to = gridStarts[cell + 1];
          for (let p = from; p < to && m < tmpCap; p++) {
            const c = gridItems[p];
            if (maxPE > 0 && used[c] >= maxPE) continue;
            const b = c * sf;
            const dx = sun[b] - lx;
            const dy = sun[b + 1] - ly;
            const d2 = dx * dx + dy * dy;
            if (d2 > rangeSq) continue;
            tmpIdx[m] = c;
            dist[m] = d2;
            m++;
          }
        }
      }
    } else {
      for (let c = 0; c < nSun && m < tmpCap; c++) {
        if (maxPE > 0 && used[c] >= maxPE) continue;
        const b = c * sf;
        const dx = sun[b] - lx;
        const dy = sun[b + 1] - ly;
        const d2 = dx * dx + dy * dy;
        if (d2 > rangeSq) continue;
        tmpIdx[m] = c;
        dist[m] = d2;
        m++;
      }
    }
    if (grid && m > 1) sortPairsByIndex(tmpIdx, dist, m);
    if (m <= 0) continue;
    m = takeClosest(tmpIdx, dist, order, m, lim, keepIdx);
    if (maxPE > 0) {
      for (let k = 0; k < m; k++) used[keepIdx[k]]++;
    }
    lightVec[0] = lx;
    lightVec[1] = ly;
    lightVec[2] = L.intensity;
    lightVec[3] = rangeSq;
    const written = appendStampedCasters(
      stamp, stampFloats, cursor, sun, sf, keepIdx, m, lightVec, cap, 0
    );
    if (stampLightIdx) {
      for (let k = cursor; k < written; k++) stampLightIdx[k] = i;
    }
    cursor = written;
  }
  return cursor;
}

/** Dist array for the module-level order comparator (set only around native sort). */
let _orderDist = null;

function compareOrderByDist(a, b) {
  return _orderDist[a] - _orderDist[b];
}

function sortOrderByDist(order, dist, m) {
  for (let k = 0; k < m; k++) order[k] = k;
  _orderDist = dist;
  order.subarray(0, m).sort(compareOrderByDist);
  _orderDist = null;
}

export function takeClosest(tmpIdx, tmpDist, order, m, limit, outIdx) {
  if (limit > 0 && m > limit) {
    sortOrderByDist(order, tmpDist, m);
    for (let k = 0; k < limit; k++) outIdx[k] = tmpIdx[order[k]];
    return limit;
  }
  for (let k = 0; k < m; k++) outIdx[k] = tmpIdx[k];
  return m;
}


