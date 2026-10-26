// The JS instanced-row packers gpuPack.wasm replaced (E-76 W9, W9b, W9d, W9e, E-82b; close-out group B), as they were in
// src/render/gpuQueueLayout.js and InstancedSpriteBatch: packInstancedRows (every call: world and screen space, pixel
// snap, type filters, casters), packSplitRows and splitInterleavedRows (the two streams of a split batch), and a
// batch's pose-batch packers. The kernel's parity tests and the pack benches compare with them; installBatchPackJs
// gives a batch its JS packing back (every upload in JS, as a batch without a kernel packed before).
import {
  GPU_CASTER_FLOATS,
  GPU_CASTER_LIGHT_FLOAT,
  GPU_POSE_FLOATS,
  GPU_SPRITE_FLOATS,
  GPU_STATIC_FLOATS,
} from '../../src/render/gpuQueueLayout.js';
import {
  INSTANCED_SPRITE_FLOATS,
  POSE_DYN_FLOATS,
  POSE_STATIC_FLOATS,
  SPLIT_POSE_FLOATS,
} from '../../src/render/instancedSpriteBatch.js';

export function snapWorldToPixel(v, cam, zoom) {
  if (!(zoom > 0)) return v;
  return Math.round((v - cam) * zoom) / zoom + cam;
}

// The scratch snapSpritePos returns (one call at a time).
const _snapXY = { x: 0, y: 0 };

function snapSpritePos(x, y, o, useScreen) {
  if (!o.pixelSnap) {
    _snapXY.x = x;
    _snapXY.y = y;
    return _snapXY;
  }
  if (useScreen) {
    _snapXY.x = Math.round(x);
    _snapXY.y = Math.round(y);
    return _snapXY;
  }
  _snapXY.x = snapWorldToPixel(x, o.snapCameraX, o.snapZoom);
  _snapXY.y = snapWorldToPixel(y, o.snapCameraY, o.snapZoom);
  return _snapXY;
}

/**
 * Pack SoA queue rows into interleaved instance floats (same layout as
 * InstancedSpriteBatch.upload).
 * @returns {number} instances written
 */
export function packInstancedRows(q, ctx, dst, dstU32, floatsPer, capacity, shadowCast) {
  if (!q || !dst || !ctx) return 0;
  const o = ctx.o || ctx;
  const indices = ctx.indices;
  const useIndices = ctx.useIndices;
  const useScreen = ctx.useScreen;
  const cameraX = ctx.cameraX || 0;
  const cameraY = ctx.cameraY || 0;
  const screenScale = ctx.screenScale || 1;
  const typeArr = ctx.typeArr;
  const includeType = ctx.includeType | 0;
  const exclude0 = ctx.exclude0 | 0;
  const exclude1 = ctx.exclude1 | 0;
  const hasInclude = ctx.hasInclude;
  const filterTypes = ctx.filterTypes;
  const depthDenom = ctx.depthDenom || 1;
  const scanCount = ctx.scanCount | 0;
  const cap = capacity | 0;
  const fp = floatsPer | 0;
  const rqX = q.x;
  const rqY = q.y;
  const rqScaleX = q.scaleX;
  const rqScaleY = q.scaleY;
  const rqRotC = q.rotC;
  const rqRotS = q.rotS;
  const rqAlpha = q.alpha;
  const rqTint = q.tint;
  const rqTextureId = q.textureId;
  const rqAnchorX = q.anchorX;
  const rqAnchorY = q.anchorY;
  const rqRepeatX = q.repeatX;
  const rqRepeatY = q.repeatY;
  const rqTileMulX = q.tileMulX;
  const rqTileMulY = q.tileMulY;
  const rqTileOffU = q.tileOffsetU;
  const rqTileOffV = q.tileOffsetV;
  const pixelSnap = !!o.pixelSnap;
  const snapCamX = o.snapCameraX || 0;
  const snapCamY = o.snapCameraY || 0;
  const snapZoom = o.snapZoom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  const INV_65535 = 1 / 65535;
  let base = 0;
  let out = 0;
  let particles = 0;
  if (!useScreen && !pixelSnap && !filterTypes) {
    if (!shadowCast && fp === GPU_SPRITE_FLOATS) {
      for (let k = 0; k < scanCount; k++) {
        if (out >= cap) break;
        const i = useIndices ? indices[k] : k;
        if (typeArr && typeArr[i] === 1) particles++;

        const depth = 1.0 - (out + 1) * invDepthDenom;
        let a = rqAlpha[i];
        if (a < 0) a = 0;
        else if (a > 1) a = 1;
        const a8 = (a * 255 + 0.5) | 0;
        const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);

        const invX = rqTileMulX ? rqTileMulX[i] : (rqRepeatX && rqRepeatX[i] > 0 ? 1 / rqRepeatX[i] : 0);
        const invY = rqTileMulY ? rqTileMulY[i] : (rqRepeatY && rqRepeatY[i] > 0 ? 1 / rqRepeatY[i] : 0);
        dst[base] = rqX[i];
        dst[base + 1] = rqY[i];
        dst[base + 2] = rqScaleX[i];
        dst[base + 3] = rqScaleY[i];
        dst[base + 4] = rqAnchorX[i];
        dst[base + 5] = rqAnchorY[i];
        dst[base + 6] = rqRotC[i];
        dst[base + 7] = rqRotS[i];
        dst[base + 8] = depth;
        dstU32[base + 9] = packed >>> 0;
        dst[base + 10] = rqTextureId[i];
        dst[base + 11] = invX;
        dst[base + 12] = invY;
        dst[base + 13] = rqTileOffU ? rqTileOffU[i] * INV_65535 : 0;
        dst[base + 14] = rqTileOffV ? rqTileOffV[i] * INV_65535 : 0;
        base += 15;
        out++;
      }
      ctx.particleCount = particles;
      return out;
    }
    if (shadowCast && fp === GPU_CASTER_FLOATS) {
      const qShadowH = q.shadowH;
      const qShadowOffX = q.shadowOffX;
      const qShadowOffY = q.shadowOffY;
      for (let k = 0; k < scanCount; k++) {
        if (out >= cap) break;
        const i = useIndices ? indices[k] : k;
        if (typeArr && typeArr[i] === 1) particles++;

        const depth = 1.0 - (out + 1) * invDepthDenom;
        let a = rqAlpha[i];
        if (a < 0) a = 0;
        else if (a > 1) a = 1;
        const a8 = (a * 255 + 0.5) | 0;
        const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);

        const invX = rqTileMulX ? rqTileMulX[i] : (rqRepeatX && rqRepeatX[i] > 0 ? 1 / rqRepeatX[i] : 0);
        const invY = rqTileMulY ? rqTileMulY[i] : (rqRepeatY && rqRepeatY[i] > 0 ? 1 / rqRepeatY[i] : 0);
        dst[base] = rqX[i];
        dst[base + 1] = rqY[i];
        dst[base + 2] = rqScaleX[i];
        dst[base + 3] = rqScaleY[i];
        dst[base + 4] = rqAnchorX[i];
        dst[base + 5] = rqAnchorY[i];
        dst[base + 6] = rqRotC[i];
        dst[base + 7] = rqRotS[i];
        dst[base + 8] = depth;
        dstU32[base + 9] = packed >>> 0;
        dst[base + 10] = rqTextureId[i];
        dst[base + 11] = invX;
        dst[base + 12] = invY;
        dst[base + 13] = rqTileOffU ? rqTileOffU[i] * INV_65535 : 0;
        dst[base + 14] = rqTileOffV ? rqTileOffV[i] * INV_65535 : 0;
        dst[base + 15] = qShadowH ? qShadowH[i] : 0;
        dst[base + 16] = qShadowOffX ? qShadowOffX[i] : 0;
        dst[base + 17] = qShadowOffY ? qShadowOffY[i] : 0;
        dst[base + 18] = 0;
        dst[base + 19] = 0;
        dst[base + 20] = 0;
        dst[base + 21] = 0;
        base += 22;
        out++;
      }
      ctx.particleCount = particles;
      return out;
    }
  }

  for (let k = 0; k < scanCount; k++) {
    const i = useIndices ? indices[k] : k;
    if (filterTypes) {
      const t = typeArr[i];
      if (hasInclude && t !== includeType) continue;
      if ((exclude0 >= 0 && t === exclude0) || (exclude1 >= 0 && t === exclude1)) continue;
    }
    if (out >= cap) break;
    if (typeArr && typeArr[i] === 1) particles++;

    let x = rqX[i];
    let y = rqY[i];
    let sx = rqScaleX[i];
    let sy = rqScaleY[i];
    let rc = rqRotC[i];
    let rs = rqRotS[i];
    if (useScreen) {
      if (ctx.cameraRot) {
        const c = ctx.camC;
        const s = ctx.camS;
        const dx = x - ctx.focusX;
        const dy = y - ctx.focusY;
        x = ctx.halfW + (dx * c - dy * s) * screenScale;
        y = ctx.halfH + (dx * s + dy * c) * screenScale;
        const nrc = rc * c - rs * s;
        rs = rs * c + rc * s;
        rc = nrc;
      } else {
        x = (x - cameraX) * screenScale;
        y = (y - cameraY) * screenScale;
      }
      sx *= screenScale;
      sy *= screenScale;
    }
    if (pixelSnap) {
      if (useScreen) {
        x = Math.round(x);
        y = Math.round(y);
      } else {
        x = snapWorldToPixel(x, snapCamX, snapZoom);
        y = snapWorldToPixel(y, snapCamY, snapZoom);
      }
    }
    const depth = 1.0 - (out + 1) * invDepthDenom;

    let a = rqAlpha[i];
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);

    const invX = rqTileMulX ? rqTileMulX[i] : (rqRepeatX && rqRepeatX[i] > 0 ? 1 / rqRepeatX[i] : 0);
    const invY = rqTileMulY ? rqTileMulY[i] : (rqRepeatY && rqRepeatY[i] > 0 ? 1 / rqRepeatY[i] : 0);
    dst[base] = x;
    dst[base + 1] = y;
    dst[base + 2] = sx;
    dst[base + 3] = sy;
    dst[base + 4] = rqAnchorX[i];
    dst[base + 5] = rqAnchorY[i];
    dst[base + 6] = rc;
    dst[base + 7] = rs;
    dst[base + 8] = depth;
    dstU32[base + 9] = packed >>> 0;
    dst[base + 10] = rqTextureId[i];
    dst[base + 11] = invX;
    dst[base + 12] = invY;
    dst[base + 13] = rqTileOffU ? rqTileOffU[i] * INV_65535 : 0;
    dst[base + 14] = rqTileOffV ? rqTileOffV[i] * INV_65535 : 0;
    if (shadowCast && fp >= GPU_CASTER_FLOATS) {
      const sh = q.shadowH;
      const shAt = GPU_SPRITE_FLOATS;
      dst[base + shAt] = sh ? sh[i] : 0;
      dst[base + shAt + 1] = q.shadowOffX ? q.shadowOffX[i] : 0;
      dst[base + shAt + 2] = q.shadowOffY ? q.shadowOffY[i] : 0;
      const lightAt = GPU_CASTER_LIGHT_FLOAT;
      dst[base + lightAt] = 0;
      dst[base + lightAt + 1] = 0;
      dst[base + lightAt + 2] = 0;
      dst[base + lightAt + 3] = 0;
    }
    base += fp;
    out++;
  }
  ctx.particleCount = particles;
  return out;
}

/**
 * E-82b: packInstancedRows' sprite fast path (world space, no pixel snap, no type filter) into two streams:
 * each row's pose into `pose` (GPU_POSE_FLOATS a row) and, unless `stat` is null, its statics into `stat`
 * (GPU_STATIC_FLOATS a row). The values are the 15-float row's. Returns -1 for any other call; the
 * caller packs 15-float rows and splits them (splitInterleavedRows).
 * @returns {number} instances written, or -1
 */
export function packSplitRows(q, ctx, pose, stat, statU32, capacity) {
  if (!q || !pose || !ctx) return -1;
  const o = ctx.o || ctx;
  if (ctx.useScreen || o.pixelSnap || ctx.filterTypes) return -1;
  const indices = ctx.indices;
  const useIndices = ctx.useIndices;
  const typeArr = ctx.typeArr;
  const scanCount = ctx.scanCount | 0;
  const cap = capacity | 0;
  const rqX = q.x;
  const rqY = q.y;
  const rqRotC = q.rotC;
  const rqRotS = q.rotS;
  let particles = 0;
  let base = 0;
  let out = 0;
  if (stat === null) {
    // The pose alone: the statics on the GPU are current. A copy of the loop below.
    for (let k = 0; k < scanCount; k++) {
      if (out >= cap) break;
      const i = useIndices ? indices[k] : k;
      if (typeArr && typeArr[i] === 1) particles++;
      pose[base] = rqX[i];
      pose[base + 1] = rqY[i];
      pose[base + 2] = rqRotC[i];
      pose[base + 3] = rqRotS[i];
      base += GPU_POSE_FLOATS;
      out++;
    }
    ctx.particleCount = particles;
    return out;
  }
  const depthDenom = ctx.depthDenom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  const INV_65535 = 1 / 65535;
  const rqScaleX = q.scaleX;
  const rqScaleY = q.scaleY;
  const rqAlpha = q.alpha;
  const rqTint = q.tint;
  const rqTextureId = q.textureId;
  const rqAnchorX = q.anchorX;
  const rqAnchorY = q.anchorY;
  const rqRepeatX = q.repeatX;
  const rqRepeatY = q.repeatY;
  const rqTileMulX = q.tileMulX;
  const rqTileMulY = q.tileMulY;
  const rqTileOffU = q.tileOffsetU;
  const rqTileOffV = q.tileOffsetV;
  let sBase = 0;
  for (let k = 0; k < scanCount; k++) {
    if (out >= cap) break;
    const i = useIndices ? indices[k] : k;
    if (typeArr && typeArr[i] === 1) particles++;

    const depth = 1.0 - (out + 1) * invDepthDenom;
    let a = rqAlpha[i];
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);

    const invX = rqTileMulX ? rqTileMulX[i] : (rqRepeatX && rqRepeatX[i] > 0 ? 1 / rqRepeatX[i] : 0);
    const invY = rqTileMulY ? rqTileMulY[i] : (rqRepeatY && rqRepeatY[i] > 0 ? 1 / rqRepeatY[i] : 0);
    pose[base] = rqX[i];
    pose[base + 1] = rqY[i];
    pose[base + 2] = rqRotC[i];
    pose[base + 3] = rqRotS[i];
    stat[sBase] = rqScaleX[i];
    stat[sBase + 1] = rqScaleY[i];
    stat[sBase + 2] = rqAnchorX[i];
    stat[sBase + 3] = rqAnchorY[i];
    stat[sBase + 4] = depth;
    statU32[sBase + 5] = packed >>> 0;
    stat[sBase + 6] = rqTextureId[i];
    stat[sBase + 7] = invX;
    stat[sBase + 8] = invY;
    stat[sBase + 9] = rqTileOffU ? rqTileOffU[i] * INV_65535 : 0;
    stat[sBase + 10] = rqTileOffV ? rqTileOffV[i] * INV_65535 : 0;
    base += GPU_POSE_FLOATS;
    sBase += GPU_STATIC_FLOATS;
    out++;
  }
  ctx.particleCount = particles;
  return out;
}

/**
 * E-82b: n 15-float sprite rows from `src` into the two streams of packSplitRows (the statics unless `stat`
 * is null). The tint word moves as bits.
 */
export function splitInterleavedRows(src, srcU32, n, pose, stat, statU32) {
  const rows = n | 0;
  let s = 0;
  let p = 0;
  if (stat === null) {
    for (let k = 0; k < rows; k++) {
      pose[p] = src[s];
      pose[p + 1] = src[s + 1];
      pose[p + 2] = src[s + 6];
      pose[p + 3] = src[s + 7];
      s += GPU_SPRITE_FLOATS;
      p += GPU_POSE_FLOATS;
    }
    return;
  }
  let t = 0;
  for (let k = 0; k < rows; k++) {
    pose[p] = src[s];
    pose[p + 1] = src[s + 1];
    pose[p + 2] = src[s + 6];
    pose[p + 3] = src[s + 7];
    stat[t] = src[s + 2];
    stat[t + 1] = src[s + 3];
    stat[t + 2] = src[s + 4];
    stat[t + 3] = src[s + 5];
    stat[t + 4] = src[s + 8];
    statU32[t + 5] = srcU32[s + 9];
    stat[t + 6] = src[s + 10];
    stat[t + 7] = src[s + 11];
    stat[t + 8] = src[s + 12];
    stat[t + 9] = src[s + 13];
    stat[t + 10] = src[s + 14];
    s += GPU_SPRITE_FLOATS;
    p += GPU_POSE_FLOATS;
    t += GPU_STATIC_FLOATS;
  }
}

/** The calls packSplitRows does not take (screen space, pixel snap, a type filter): 15-float rows, split. */
function _packSplitFromRows(q, ctx, current) {
  const floats = this.capacity * INSTANCED_SPRITE_FLOATS;
  if (!this._splitScratch || this._splitScratch.length < floats) {
    this._splitScratch = new Float32Array(floats);
    this._splitScratchU32 = new Uint32Array(this._splitScratch.buffer);
  }
  const rows = this._splitScratch;
  const rowsU32 = this._splitScratchU32;
  const out = packInstancedRows(q, ctx, rows, rowsU32, INSTANCED_SPRITE_FLOATS, this.capacity, false);
  splitInterleavedRows(rows, rowsU32, out, this.data, current ? null : this.staticData, this.staticDataU32);
  return out;
}

/** E-82b: commit `count` 15-float rows into a split batch (a GPU queue frame without GPU_FLAG_SPLIT). */
function commitRowsSplit(src, srcU32, count) {
  const n = count | 0;
  const keep = n > this.capacity ? this.capacity : n;
  if (keep <= 0) return this._finishUpload(0, SPLIT_POSE_FLOATS * 4);
  this._stGen = 0;
  this._stRows = -1;
  this._staticVersion++;
  splitInterleavedRows(src, srcU32, keep, this.data, this.staticData, this.staticDataU32);
  return this._finishUpload(keep, SPLIT_POSE_FLOATS * 4);
}

/** The pose stream alone: the statics on the GPU are current. A copy of the loop below. */
function _packPoseOnly(q, ctx) {
  const o = ctx.o;
  const data = this.data;
  const indices = ctx.indices;
  const useIndices = ctx.useIndices;
  const useScreen = ctx.useScreen;
  const cameraX = ctx.cameraX;
  const cameraY = ctx.cameraY;
  const screenScale = ctx.screenScale;
  const typeArr = ctx.typeArr;
  const includeType = ctx.includeType;
  const exclude0 = ctx.exclude0;
  const exclude1 = ctx.exclude1;
  const hasInclude = ctx.hasInclude;
  const filterTypes = ctx.filterTypes;
  const scanCount = ctx.scanCount;
  const snap = !!o.snap;
  const prevXArr = snap ? null : o.prevX;
  const prevYArr = snap ? null : o.prevY;
  const rqX = q.x;
  const rqY = q.y;
  const rqRotC = q.rotC;
  const rqRotS = q.rotS;
  let base = 0;
  let out = 0;
  for (let k = 0; k < scanCount; k++) {
    const i = useIndices ? indices[k] : k;
    if (filterTypes) {
      const t = typeArr[i];
      if (hasInclude && t !== includeType) continue;
      if ((exclude0 >= 0 && t === exclude0) || (exclude1 >= 0 && t === exclude1)) continue;
    }
    if (out >= this.capacity) break;
    let x = rqX[i];
    let y = rqY[i];
    let px = prevXArr ? prevXArr[i] : x;
    let py = prevYArr ? prevYArr[i] : y;
    if (useScreen) {
      if (ctx.cameraRot) {
        const c = ctx.camC;
        const s = ctx.camS;
        const dx = x - ctx.focusX;
        const dy = y - ctx.focusY;
        x = ctx.halfW + (dx * c - dy * s) * screenScale;
        y = ctx.halfH + (dx * s + dy * c) * screenScale;
        const pdx = px - ctx.focusX;
        const pdy = py - ctx.focusY;
        px = ctx.halfW + (pdx * c - pdy * s) * screenScale;
        py = ctx.halfH + (pdx * s + pdy * c) * screenScale;
      } else {
        x = (x - cameraX) * screenScale;
        y = (y - cameraY) * screenScale;
        px = (px - cameraX) * screenScale;
        py = (py - cameraY) * screenScale;
      }
    }
    const snapped = snapSpritePos(x, y, o, useScreen);
    x = snapped.x;
    y = snapped.y;
    const snappedPrev = snapSpritePos(px, py, o, useScreen);
    px = snappedPrev.x;
    py = snappedPrev.y;
    let rc = rqRotC[i];
    let rs = rqRotS[i];
    if (useScreen && ctx.cameraRot) {
      const c = ctx.camC;
      const s = ctx.camS;
      const nrc = rc * c - rs * s;
      rs = rs * c + rc * s;
      rc = nrc;
    }
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = rc;
    data[base + 3] = rs;
    data[base + 4] = px;
    data[base + 5] = py;
    base += POSE_DYN_FLOATS;
    out++;
  }
  return out;
}

/** Both streams: the pose into data, the statics into staticData. */
function _packPoseAndStatics(q, ctx) {
  const o = ctx.o;
  const data = this.data;
  const stat = this.staticData;
  const statU32 = this.staticDataU32;
  const indices = ctx.indices;
  const useIndices = ctx.useIndices;
  const useScreen = ctx.useScreen;
  const cameraX = ctx.cameraX;
  const cameraY = ctx.cameraY;
  const screenScale = ctx.screenScale;
  const typeArr = ctx.typeArr;
  const includeType = ctx.includeType;
  const exclude0 = ctx.exclude0;
  const exclude1 = ctx.exclude1;
  const hasInclude = ctx.hasInclude;
  const filterTypes = ctx.filterTypes;
  const depthDenom = ctx.depthDenom;
  const scanCount = ctx.scanCount;
  const snap = !!o.snap;
  const prevXArr = snap ? null : o.prevX;
  const prevYArr = snap ? null : o.prevY;
  const rqX = q.x;
  const rqY = q.y;
  const rqScaleX = q.scaleX;
  const rqScaleY = q.scaleY;
  const rqRotC = q.rotC;
  const rqRotS = q.rotS;
  const rqAlpha = q.alpha;
  const rqTint = q.tint;
  const rqTextureId = q.textureId;
  const rqAnchorX = q.anchorX;
  const rqAnchorY = q.anchorY;
  const rqRepeatX = q.repeatX;
  const rqRepeatY = q.repeatY;
  const rqTileMulX = q.tileMulX;
  const rqTileMulY = q.tileMulY;
  const rqTileOffU = q.tileOffsetU;
  const rqTileOffV = q.tileOffsetV;
  let base = 0;
  let sBase = 0;
  let out = 0;
  for (let k = 0; k < scanCount; k++) {
    const i = useIndices ? indices[k] : k;
    if (filterTypes) {
      const t = typeArr[i];
      if (hasInclude && t !== includeType) continue;
      if ((exclude0 >= 0 && t === exclude0) || (exclude1 >= 0 && t === exclude1)) continue;
    }
    if (out >= this.capacity) break;
    let x = rqX[i];
    let y = rqY[i];
    let px = prevXArr ? prevXArr[i] : x;
    let py = prevYArr ? prevYArr[i] : y;
    let sx = rqScaleX[i];
    let sy = rqScaleY[i];
    if (useScreen) {
      if (ctx.cameraRot) {
        const c = ctx.camC;
        const s = ctx.camS;
        const dx = x - ctx.focusX;
        const dy = y - ctx.focusY;
        x = ctx.halfW + (dx * c - dy * s) * screenScale;
        y = ctx.halfH + (dx * s + dy * c) * screenScale;
        const pdx = px - ctx.focusX;
        const pdy = py - ctx.focusY;
        px = ctx.halfW + (pdx * c - pdy * s) * screenScale;
        py = ctx.halfH + (pdx * s + pdy * c) * screenScale;
      } else {
        x = (x - cameraX) * screenScale;
        y = (y - cameraY) * screenScale;
        px = (px - cameraX) * screenScale;
        py = (py - cameraY) * screenScale;
      }
      sx *= screenScale;
      sy *= screenScale;
    }
    const snapped = snapSpritePos(x, y, o, useScreen);
    x = snapped.x;
    y = snapped.y;
    const snappedPrev = snapSpritePos(px, py, o, useScreen);
    px = snappedPrev.x;
    py = snappedPrev.y;
    const depth = 1.0 - (out + 1) / depthDenom;
    let a = rqAlpha[i];
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);
    const rx = rqRepeatX ? rqRepeatX[i] : 0;
    const ry = rqRepeatY ? rqRepeatY[i] : 0;
    const invX = rqTileMulX ? rqTileMulX[i] : (rx > 0 ? 1 / rx : 0);
    const invY = rqTileMulY ? rqTileMulY[i] : (ry > 0 ? 1 / ry : 0);
    let rc = rqRotC[i];
    let rs = rqRotS[i];
    if (useScreen && ctx.cameraRot) {
      const c = ctx.camC;
      const s = ctx.camS;
      const nrc = rc * c - rs * s;
      rs = rs * c + rc * s;
      rc = nrc;
    }
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = rc;
    data[base + 3] = rs;
    data[base + 4] = px;
    data[base + 5] = py;
    stat[sBase] = sx;
    stat[sBase + 1] = sy;
    stat[sBase + 2] = rqAnchorX[i];
    stat[sBase + 3] = rqAnchorY[i];
    stat[sBase + 4] = depth;
    statU32[sBase + 5] = packed >>> 0;
    stat[sBase + 6] = rqTextureId[i];
    stat[sBase + 7] = invX;
    stat[sBase + 8] = invY;
    stat[sBase + 9] = rqTileOffU ? rqTileOffU[i] * (1 / 65535) : 0;
    stat[sBase + 10] = rqTileOffV ? rqTileOffV[i] * (1 / 65535) : 0;
    base += POSE_DYN_FLOATS;
    sBase += POSE_STATIC_FLOATS;
    out++;
  }
  return out;
}

/** A batch's upload in JS: packInstancedRows into its own arrays (a pose or split batch: their packers). */
function upload(q, opts) {
  if (this.poseInterp) return this._uploadPose(q, opts);
  if (this.split) return this._uploadSplit(q, opts);
  const ctx = this._beginUpload(q, opts);
  if (!ctx) return 0;
  const out = packInstancedRows(q, ctx, this.data, this.dataU32, this._floats, this.capacity, this.shadowCast);
  return this._finishUpload(out, this._strideBytes);
}

/** A pose batch's upload in JS: the pose stream, and the statics when the GPU's are not this upload's. */
function uploadPose(q, opts) {
  const ctx = this._beginUpload(q, opts);
  if (!ctx) return 0;
  const current = this._staticsCurrent(q, ctx);
  const out = current ? _packPoseOnly.call(this, q, ctx) : _packPoseAndStatics.call(this, q, ctx);
  return this._finishUpload(out, POSE_DYN_FLOATS * 4);
}

/** A split batch's upload in JS: packSplitRows, else 15-float rows split afterwards. */
function uploadSplit(q, opts) {
  const ctx = this._beginUpload(q, opts);
  if (!ctx) return 0;
  const current = this._staticsCurrent(q, ctx);
  let out = packSplitRows(q, ctx, this.data, current ? null : this.staticData, this.staticDataU32, this.capacity);
  if (out < 0) out = _packSplitFromRows.call(this, q, ctx, current);
  return this._finishUpload(out, SPLIT_POSE_FLOATS * 4);
}

/**
 * Give `batch` (an InstancedSpriteBatch) its JS packing: every upload packs in JS, into its own arrays, and a pose
 * batch's two packers are its methods again (_packPoseOnly, _packPoseAndStatics), as the pose parity test calls them.
 */
export function installBatchPackJs(batch) {
  batch.upload = upload;
  batch._uploadPose = uploadPose;
  batch._uploadSplit = uploadSplit;
  batch.commitRowsSplit = commitRowsSplit;
  batch._packPoseOnly = _packPoseOnly;
  batch._packPoseAndStatics = _packPoseAndStatics;
  return batch;
}
