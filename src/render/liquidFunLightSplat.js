/**
 * Pack lit LiquidFun group slabs into a density-splat instance buffer (CPU, no GPU).
 * Layout matches LiquidFunDensitySplat: float32 x,y,radius + packed unorm8x4 RGBA.
 * Intensity / sqrt live on group id. Pose is HEAP x/y. Radius = 10 * sqrtI.
 */

import { lightInfluenceRadius } from './utils.js';

export const LF_LIGHT_SPLAT_FLOATS = 4;
export const LF_LIGHT_SPLAT_STRIDE = LF_LIGHT_SPLAT_FLOATS * 4;

/**
 * @param {Float32Array} data
 * @param {Uint32Array} dataU32
 * @param {number} capacity
 * @param {{ x: Float32Array, y: Float32Array, tint?: Uint32Array, alpha?: Float32Array, baseAlpha?: Float32Array, maxCount: number }} views
 * @param {{ count: Int32Array, id: Int32Array, particleCount: Int32Array, firstIndex?: Int32Array, lastIndex?: Int32Array, lightIntensity: Float32Array, sqrtLightIntensity?: Float32Array, maxGroups?: number }} groups
 * @param {{ zoom?: number, cameraX?: number, cameraY?: number, resolution?: number, canvasW?: number, canvasH?: number }} opts
 * @returns {number} packed instance count
 */
export function packLiquidFunLightSlabs(data, dataU32, capacity, views, groups, opts) {
  if (!data || !dataU32 || !views?.x || !views?.y || !groups?.count || !groups.lightIntensity) {
    return 0;
  }
  const cap = capacity | 0;
  if (cap <= 0) return 0;

  const groupN = groups.count[0] | 0;
  if (groupN <= 0) return 0;

  const zoom = opts.zoom ?? 1;
  const cameraX = opts.cameraX ?? 0;
  const cameraY = opts.cameraY ?? 0;
  const resolution = opts.resolution ?? 1;
  const screenScale = zoom * resolution;
  if (!(screenScale > 0)) return 0;

  const xArr = views.x;
  const yArr = views.y;
  const tintArr = views.tint;
  const baseAlpha = views.baseAlpha;
  const alphaArr = views.alpha;
  const maxP = views.maxCount | 0;
  const ids = groups.id;
  const particleCount = groups.particleCount;
  const firstIndex = groups.firstIndex;
  const lastIndex = groups.lastIndex;
  const lightById = groups.lightIntensity;
  const sqrtById = groups.sqrtLightIntensity;
  const maxG = (groups.maxGroups | 0) || lightById.length;
  const canvasW = opts.canvasW > 0 ? opts.canvasW : 0;
  const canvasH = opts.canvasH > 0 ? opts.canvasH : 0;
  const cull = canvasW > 0 && canvasH > 0;
  const rtW = canvasW * resolution;
  const rtH = canvasH * resolution;

  let out = 0;
  for (let g = 0; g < groupN; g++) {
    const gid = ids[g] | 0;
    if (gid < 0 || gid >= maxG) continue;
    if (!(lightById[gid] > 0)) continue;
    const sqrtI = sqrtById ? sqrtById[gid] : 0;
    const worldRadius = lightInfluenceRadius(sqrtI);
    if (!(worldRadius > 0)) continue;
    const screenRadius = worldRadius * screenScale;
    const pad = screenRadius;
    const screenMaxX = rtW + pad;
    const screenMaxY = rtH + pad;

    const first = firstIndex ? firstIndex[g] | 0 : 0;
    const nPart = particleCount ? particleCount[g] | 0 : 0;
    let last = lastIndex ? lastIndex[g] | 0 : first + nPart;
    if (nPart > 0 && last < first + nPart) last = first + nPart;
    if (last > maxP) last = maxP;
    if (first < 0 || last <= first) continue;

    for (let i = first; i < last; i++) {
      const sx = (xArr[i] - cameraX) * screenScale;
      const sy = (yArr[i] - cameraY) * screenScale;
      if (cull) {
        if (sx < -pad || sy < -pad || sx > screenMaxX || sy > screenMaxY) continue;
      }
      if (out >= cap) return out;

      let r = 255;
      let g8 = 255;
      let b = 255;
      if (tintArr) {
        const tint = tintArr[i] >>> 0;
        if (tint) {
          r = (tint >> 16) & 0xff;
          g8 = (tint >> 8) & 0xff;
          b = tint & 0xff;
        }
      }

      let a = 1;
      if (baseAlpha) a *= baseAlpha[i];
      if (alphaArr) a *= alphaArr[i];
      let ai = (a * 255 + 0.5) | 0;
      if (ai < 0) ai = 0;
      else if (ai > 255) ai = 255;

      const base = out * LF_LIGHT_SPLAT_FLOATS;
      data[base] = sx;
      data[base + 1] = sy;
      data[base + 2] = screenRadius;
      dataU32[base + 3] = r | (g8 << 8) | (b << 16) | (ai << 24);
      out++;
    }
  }
  return out;
}
