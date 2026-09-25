/**
 * Compact shadow casters and honor maxShadowsPerLight / maxShadowsPerEntity
 * without packing CPU shadow sprites. Lights closest to the caster, then
 * casters closest to that light.
 */

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

/** Per-instance light sits after the 18 caster floats (xy…shadow). */
export const CASTER_LIGHT_FLOAT = 18;

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

/** Integer RT pixels. Nominal resolution is not the framebuffer size. */
export function rtPixelSize(canvasPx, resolution) {
  const r = resolution > 0 ? +resolution : 1;
  return Math.max(1, Math.round((+canvasPx || 0) * r));
}

/** RT pixels / canvas pixels. Projection and display use this, not the nominal resolution. */
export function rtPixelScale(canvasPx, rtPx) {
  return canvasPx > 0 ? rtPx / canvasPx : 1;
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

/**
 * After concatenating per-worker stamp blocks, keep at most `maxPerLight`
 * closest casters per light index. Rewrites `stamp` / `lightIdx` in place.
 * `scratchF32` must hold `count * floatsPer` floats. `scratchLight` holds `count` light ids.
 */
export function compactStampByLightLimit(
  stamp,
  lightIdx,
  count,
  floatsPer,
  maxPerLight,
  tmpIdx,
  tmpDist,
  order,
  keepIdx,
  keepAll,
  scratchF32,
  scratchLight
) {
  const n = count | 0;
  const lim = maxPerLight | 0;
  const fp = floatsPer | 0;
  if (n <= 0 || !(lim > 0) || !stamp || !lightIdx || !keepAll) return n;
  let maxL = -1;
  for (let i = 0; i < n; i++) {
    const L = lightIdx[i] | 0;
    if (L > maxL) maxL = L;
  }
  if (maxL < 0) return 0;
  let write = 0;
  for (let L = 0; L <= maxL; L++) {
    let m = 0;
    for (let i = 0; i < n; i++) {
      if ((lightIdx[i] | 0) !== L) continue;
      tmpIdx[m] = i;
      const b = i * fp;
      const lx = stamp[b + CASTER_LIGHT_FLOAT];
      const ly = stamp[b + CASTER_LIGHT_FLOAT + 1];
      const dx = stamp[b] - lx;
      const dy = stamp[b + 1] - ly;
      tmpDist[m] = dx * dx + dy * dy;
      m++;
    }
    if (m <= 0) continue;
    const keep = takeClosest(tmpIdx, tmpDist, order, m, lim, keepIdx);
    for (let k = 0; k < keep; k++) keepAll[write++] = keepIdx[k];
  }
  if (write === n) return n;
  const need = n * fp;
  if (!scratchF32 || scratchF32.length < need || !scratchLight) return n;
  scratchF32.set(stamp.subarray(0, need));
  for (let i = 0; i < n; i++) scratchLight[i] = lightIdx[i];
  for (let k = 0; k < write; k++) {
    const src = keepAll[k] | 0;
    copyTypedRange(stamp, k * fp, scratchF32, src * fp, fp);
    lightIdx[k] = scratchLight[src];
  }
  return write;
}
