/**
 * Compact shadow casters and honor maxShadowsPerLight / maxShadowsPerEntity
 * without packing CPU shadow sprites. Lights closest to the caster, then
 * casters closest to that light.
 */

/** Drop casters whose shadow is under `minPx` screen pixels. Returns the new count. */
export function dropTinyFloorShadows(idx, n, scaleY, shadowH, zoom, minPx) {
  const z = zoom > 0 ? zoom : 1;
  const min = minPx > 0 ? minPx : 0;
  let w = 0;
  const count = n | 0;
  for (let i = 0; i < count; i++) {
    const s = idx[i] | 0;
    const ext = Math.abs(scaleY[s] || 1) * (shadowH[s] || 0) * z;
    if (ext < min) continue;
    idx[w++] = s;
  }
  return w;
}

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

export function resolveGpuShadowPath(value) {
  if (value === 'reuse' || value === 'queue' || value === 'resident' || value === 'batch') return value;
  return 'copy';
}

/** Per-instance light sits after the 18 caster floats (xy…shadow). */
export const CASTER_LIGHT_FLOAT = 18;

/**
 * Copy packed caster slots and stamp one light vec4 on each.
 * `indices` are source instance slots. Stops at `cap` instances.
 * Returns how many were written (dstBase + written).
 */
export function appendStampedCasters(dst, dstFloats, dstBase, src, srcFloats, indices, n, light, cap) {
  const sf = srcFloats | 0;
  const df = dstFloats | 0;
  const limit = cap | 0;
  let out = dstBase | 0;
  const count = n | 0;
  const lx = light[0];
  const ly = light[1];
  const lz = light[2];
  const lw = light[3];
  const lightAt = CASTER_LIGHT_FLOAT;
  for (let k = 0; k < count && out < limit; k++) {
    const i = indices[k] | 0;
    const s0 = i * sf;
    const d0 = out * df;
    dst.set(src.subarray(s0, s0 + Math.min(sf, df)), d0);
    dst[d0 + lightAt] = lx;
    dst[d0 + lightAt + 1] = ly;
    dst[d0 + lightAt + 2] = lz;
    dst[d0 + lightAt + 3] = lw;
    out++;
  }
  return out;
}

export function resolveGpuShadowCookies(value) {
  return value === 'night' ? 'night' : 'always';
}

/** 1 = every frame; N>1 holds caster silhouettes for N-1 frames. Cookies still redraw. */
export function resolveShadowUpdateInterval(value) {
  const n = value | 0;
  return n > 1 ? n : 1;
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

export function samePackedIndices(prev, prevN, next, n) {
  if ((prevN | 0) !== (n | 0) || !prev || !next) return false;
  for (let i = 0; i < n; i++) {
    if ((prev[i] | 0) !== (next[i] | 0)) return false;
  }
  return true;
}

/** Pose slice of an 18-float caster instance (xy, rotCS, shadowH/off). */
export function writeCasterPose(data, base, x, y, rotC, rotS, height, offX, offY) {
  data[base] = x;
  data[base + 1] = y;
  data[base + 6] = rotC;
  data[base + 7] = rotS;
  data[base + 15] = height;
  data[base + 16] = offX;
  data[base + 17] = offY;
}

export function takeClosest(tmpIdx, tmpDist, order, m, limit, outIdx) {
  if (limit > 0 && m > limit) {
    for (let k = 0; k < m; k++) order[k] = k;
    const d = tmpDist;
    order.subarray(0, m).sort((a, b) => d[a] - d[b]);
    for (let k = 0; k < limit; k++) outIdx[k] = tmpIdx[order[k]];
    return limit;
  }
  for (let k = 0; k < m; k++) outIdx[k] = tmpIdx[k];
  return m;
}

export function selectClosestCasters(casterIdx, casterCount, qx, qy, lx, ly, limit, tmpDist, order, outIdx) {
  const m = casterCount | 0;
  for (let c = 0; c < m; c++) {
    const i = casterIdx[c];
    const dx = qx[i] - lx;
    const dy = qy[i] - ly;
    tmpDist[c] = dx * dx + dy * dy;
  }
  if (limit > 0 && m > limit) {
    for (let k = 0; k < m; k++) order[k] = k;
    const d = tmpDist;
    order.subarray(0, m).sort((a, b) => d[a] - d[b]);
    for (let k = 0; k < limit; k++) outIdx[k] = casterIdx[order[k]];
    return limit;
  }
  for (let k = 0; k < m; k++) outIdx[k] = casterIdx[k];
  return m;
}

/**
 * Link each caster into its `maxPerEntity` closest lights (by caster–light dist).
 * head[light] is a node index or -1. Returns nodes used.
 */
export function linkCastersToClosestLights({
  casterIdx,
  casterCount,
  qx,
  qy,
  lightData,
  nLights,
  maxPerEntity,
  head,
  nodeNext,
  nodeCaster,
  scratchSlots,
  scratchDist,
}) {
  const L = nLights | 0;
  for (let j = 0; j < L; j++) head[j] = -1;
  const k = maxPerEntity | 0;
  if (!(k > 0) || !(casterCount > 0) || L <= 0) return 0;
  let node = 0;
  const nodeCap = nodeCaster.length;
  const nC = casterCount | 0;
  for (let c = 0; c < nC; c++) {
    const i = casterIdx[c];
    const x = qx[i];
    const y = qy[i];
    let filled = 0;
    for (let j = 0; j < L; j++) {
      const o = j * 4;
      const dx = x - lightData[o];
      const dy = y - lightData[o + 1];
      const d = dx * dx + dy * dy;
      if (filled < k) {
        let p = filled;
        while (p > 0 && scratchDist[p - 1] > d) {
          scratchDist[p] = scratchDist[p - 1];
          scratchSlots[p] = scratchSlots[p - 1];
          p--;
        }
        scratchDist[p] = d;
        scratchSlots[p] = j;
        filled++;
      } else if (d < scratchDist[k - 1]) {
        let p = k - 1;
        while (p > 0 && scratchDist[p - 1] > d) {
          scratchDist[p] = scratchDist[p - 1];
          scratchSlots[p] = scratchSlots[p - 1];
          p--;
        }
        scratchDist[p] = d;
        scratchSlots[p] = j;
      }
    }
    for (let t = 0; t < filled && node < nodeCap; t++) {
      const light = scratchSlots[t];
      nodeCaster[node] = i;
      nodeNext[node] = head[light];
      head[light] = node;
      node++;
    }
  }
  return node;
}

export function collectLightCasters(
  head,
  nodeNext,
  nodeCaster,
  lightSlot,
  qx,
  qy,
  lx,
  ly,
  limit,
  tmpIdx,
  tmpDist,
  order,
  outIdx
) {
  let m = 0;
  for (let n = head[lightSlot]; n >= 0; n = nodeNext[n]) {
    const i = nodeCaster[n];
    tmpIdx[m] = i;
    const dx = qx[i] - lx;
    const dy = qy[i] - ly;
    tmpDist[m] = dx * dx + dy * dy;
    m++;
  }
  return takeClosest(tmpIdx, tmpDist, order, m, limit, outIdx);
}
