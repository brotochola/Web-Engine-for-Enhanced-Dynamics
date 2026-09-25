/**
 * Shared GPU-format queues: pre-render writes interleaved instance rows,
 * pixi copies those bytes into the Mesh buffer and draws.
 *
 * Regions (after an 8-int header): sprites, glows, sun casters, point-light
 * stamped casters, cookies. Caster rows are the 15 sprite floats plus
 * shadowH/off and a light vec4 (22 floats). Cookies are 15-float rows already
 * in shadow-RT pixels.
 */

import { DECORATION_Y_SORT_SCALE } from '../util/configDefaults.js';
import { depthFromOrderKey, depthFromSortKey } from '../util/sortIndexByKey.js';

export const GPU_SPRITE_FLOATS = 15;
export const GPU_CASTER_FLOATS = 22;
export const GPU_HEADER_INTS = 8;
export const GPU_QUEUE_VERSION = 1;

export const GPU_HDR_SPRITE = 0;
export const GPU_HDR_GLOW = 1;
export const GPU_HDR_SUN = 2;
export const GPU_HDR_STAMP = 3;
export const GPU_HDR_COOKIE = 4;
export const GPU_HDR_PARTICLE = 5;
export const GPU_HDR_FLAGS = 6;
export const GPU_HDR_VERSION = 7;

export const GPU_FLAG_SORTED = 1;

export const GPU_SPACE_WORLD = 0;
export const GPU_SPACE_SCREEN = 1;

function align4(n) {
  return (n + 3) & ~3;
}

function snapWorldToPixel(v, cam, zoom) {
  if (!(zoom > 0)) return v;
  return Math.round((v - cam) * zoom) / zoom + cam;
}

function instanceDepth(out, depthDenom, o, i) {
  if (o.useZBuffer && o.sortKey) {
    if (o.keySpan > 0) return depthFromOrderKey(o.sortKey[i], o.keySpan, o.keyHalf);
    return depthFromSortKey(o.sortKey[i], o.worldHeight, DECORATION_Y_SORT_SCALE);
  }
  return 1.0 - (out + 1) / depthDenom;
}

/**
 * @param {number} maxSprites
 * @param {object} [lighting]
 * @param {number} [workerCount]
 */
export function gpuQueueCaps(maxSprites, lighting, workerCount) {
  const sprites = Math.max(1, maxSprites | 0);
  const lightsOn = !!(lighting && lighting.enabled);
  const shadowOn = !!(lighting && lighting.shadowsEnabled);
  const maxLights = Math.max(1, (lighting && lighting.maxLights) | 0 || 1);
  const shards = Math.max(1, workerCount | 0);
  const castLights = shadowOn
    ? Math.max(1, (lighting.maxShadowCastingLights | 0) || maxLights)
    : 0;
  const perLight = shadowOn ? Math.max(0, lighting.maxShadowsPerLight | 0) : 0;
  const perEnt = shadowOn ? Math.max(0, lighting.maxShadowsPerEntity | 0) : 0;
  let stamp = 0;
  if (shadowOn && castLights > 0) {
    const lightCap = perLight > 0 ? perLight : sprites;
    const fromLights = castLights * lightCap;
    const fromEnt = perEnt > 0 ? sprites * perEnt : sprites * castLights;
    stamp = Math.max(1, Math.min(fromLights, fromEnt)) * shards;
  }
  return {
    maxSprites: sprites,
    maxGlow: lightsOn ? sprites : 0,
    maxSun: shadowOn ? sprites : 0,
    maxStamp: stamp,
    maxCookie: shadowOn ? Math.max(1, Math.min(maxLights, castLights || maxLights)) : 0,
  };
}

export function computeGpuQueueBufferSize(caps) {
  const c = caps || gpuQueueCaps(1, null);
  let offset = GPU_HEADER_INTS * 4;
  offset += (c.maxSprites | 0) * GPU_SPRITE_FLOATS * 4;
  offset += (c.maxGlow | 0) * GPU_SPRITE_FLOATS * 4;
  offset += (c.maxSun | 0) * GPU_CASTER_FLOATS * 4;
  offset += (c.maxStamp | 0) * GPU_CASTER_FLOATS * 4;
  offset += (c.maxCookie | 0) * GPU_SPRITE_FLOATS * 4;
  offset = align4(offset);
  offset += (c.maxStamp | 0) * 2;
  return align4(offset);
}

function regionF32(sab, offset, count) {
  const n = count | 0;
  if (n <= 0) return { view: new Float32Array(0), u32: new Uint32Array(0), next: offset };
  const bytes = n * 4;
  const view = new Float32Array(sab, offset, n);
  const u32 = new Uint32Array(sab, offset, n);
  return { view, u32, next: offset + bytes };
}

export function createGpuQueueViews(sab, caps) {
  const c = caps || gpuQueueCaps(1, null);
  let offset = 0;
  const header = new Int32Array(sab, offset, GPU_HEADER_INTS);
  offset += GPU_HEADER_INTS * 4;
  const sprites = regionF32(sab, offset, (c.maxSprites | 0) * GPU_SPRITE_FLOATS);
  offset = sprites.next;
  const glow = regionF32(sab, offset, (c.maxGlow | 0) * GPU_SPRITE_FLOATS);
  offset = glow.next;
  const sun = regionF32(sab, offset, (c.maxSun | 0) * GPU_CASTER_FLOATS);
  offset = sun.next;
  const stamp = regionF32(sab, offset, (c.maxStamp | 0) * GPU_CASTER_FLOATS);
  offset = stamp.next;
  const cookie = regionF32(sab, offset, (c.maxCookie | 0) * GPU_SPRITE_FLOATS);
  offset = align4(cookie.next);
  const stampN = c.maxStamp | 0;
  const stampLightIdx = stampN > 0 ? new Uint16Array(sab, offset, stampN) : new Uint16Array(0);
  offset = align4(offset + stampN * 2);
  return {
    header,
    sprites: sprites.view,
    spritesU32: sprites.u32,
    glow: glow.view,
    glowU32: glow.u32,
    sun: sun.view,
    sunU32: sun.u32,
    stamp: stamp.view,
    stampU32: stamp.u32,
    cookie: cookie.view,
    cookieU32: cookie.u32,
    stampLightIdx,
    caps: c,
    byteLength: offset,
  };
}

/** Private (non-shared) views with the same shapes as a SAB queue. */
export function createGpuQueueScratch(caps) {
  const size = computeGpuQueueBufferSize(caps);
  return createGpuQueueViews(new ArrayBuffer(size), caps);
}

export function clearGpuQueueHeader(header) {
  if (!header) return;
  header[GPU_HDR_SPRITE] = 0;
  header[GPU_HDR_GLOW] = 0;
  header[GPU_HDR_SUN] = 0;
  header[GPU_HDR_STAMP] = 0;
  header[GPU_HDR_COOKIE] = 0;
  header[GPU_HDR_PARTICLE] = 0;
  header[GPU_HDR_FLAGS] = 0;
  header[GPU_HDR_VERSION] = GPU_QUEUE_VERSION;
}

export function writeGpuQueueHeader(header, counts, flags) {
  if (!header) return;
  header[GPU_HDR_SPRITE] = counts.sprite | 0;
  header[GPU_HDR_GLOW] = counts.glow | 0;
  header[GPU_HDR_SUN] = counts.sun | 0;
  header[GPU_HDR_STAMP] = counts.stamp | 0;
  header[GPU_HDR_COOKIE] = counts.cookie | 0;
  header[GPU_HDR_PARTICLE] = counts.particle | 0;
  header[GPU_HDR_FLAGS] = flags | 0;
  header[GPU_HDR_VERSION] = GPU_QUEUE_VERSION;
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
  let base = 0;
  let out = 0;
  let particles = 0;
  for (let k = 0; k < scanCount; k++) {
    const i = useIndices ? indices[k] : k;
    if (filterTypes) {
      const t = typeArr[i];
      if (hasInclude && t !== includeType) continue;
      if ((exclude0 >= 0 && t === exclude0) || (exclude1 >= 0 && t === exclude1)) continue;
    }
    if (out >= cap) break;
    if (!useIndices && typeArr && typeArr[i] === 1) particles++;
    else if (useIndices && typeArr && typeArr[i] === 1) particles++;

    let x = rqX[i];
    let y = rqY[i];
    let sx = rqScaleX[i];
    let sy = rqScaleY[i];
    if (useScreen) {
      x = (x - cameraX) * screenScale;
      y = (y - cameraY) * screenScale;
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
    const depth = instanceDepth(out, depthDenom, o, i);

    let a = rqAlpha[i];
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);

    const rx = rqRepeatX ? rqRepeatX[i] : 0;
    const ry = rqRepeatY ? rqRepeatY[i] : 0;
    const invX = rqTileMulX ? rqTileMulX[i] : (rx > 0 ? 1 / rx : 0);
    const invY = rqTileMulY ? rqTileMulY[i] : (ry > 0 ? 1 / ry : 0);
    dst[base] = x;
    dst[base + 1] = y;
    dst[base + 2] = sx;
    dst[base + 3] = sy;
    dst[base + 4] = rqAnchorX[i];
    dst[base + 5] = rqAnchorY[i];
    dst[base + 6] = rqRotC[i];
    dst[base + 7] = rqRotS[i];
    dst[base + 8] = depth;
    dstU32[base + 9] = packed >>> 0;
    dst[base + 10] = rqTextureId[i];
    dst[base + 11] = invX;
    dst[base + 12] = invY;
    dst[base + 13] = rqTileOffU ? rqTileOffU[i] * (1 / 65535) : 0;
    dst[base + 14] = rqTileOffV ? rqTileOffV[i] * (1 / 65535) : 0;
    if (shadowCast && fp >= GPU_CASTER_FLOATS) {
      const sh = q.shadowH;
      dst[base + 15] = sh ? sh[i] : 0;
      dst[base + 16] = q.shadowOffX ? q.shadowOffX[i] : 0;
      dst[base + 17] = q.shadowOffY ? q.shadowOffY[i] : 0;
      dst[base + 18] = 0;
      dst[base + 19] = 0;
      dst[base + 20] = 0;
      dst[base + 21] = 0;
    }
    base += fp;
    out++;
  }
  ctx.particleCount = particles;
  return out;
}

/**
 * Call-level setup matching InstancedSpriteBatch._beginUpload, without touching a Mesh.
 */
export function makePackContext(q, opts, capacity) {
  const o = opts || {};
  const count = q && q.count != null ? q.count | 0 : 0;
  const indices = o.indices;
  const indexCount = o.indexCount | 0;
  const useIndices = indices != null;
  if ((!useIndices && count <= 0) || (useIndices && indexCount <= 0)) return null;
  const includeType = o.includeType == null ? -1 : o.includeType | 0;
  const hasInclude = includeType >= 0;
  if (!useIndices && hasInclude && !o.type) return null;
  const space = o.space | 0;
  const zoom = o.zoom ?? 1;
  const cameraX = o.cameraX ?? 0;
  const cameraY = o.cameraY ?? 0;
  const resolution = o.resolution ?? 1;
  const useScreen = space === GPU_SPACE_SCREEN;
  const screenScale = zoom * resolution;
  const typeArr = o.type || null;
  const exclude0 = o.excludeType0 == null ? -1 : o.excludeType0 | 0;
  const exclude1 = o.excludeType1 == null ? -1 : o.excludeType1 | 0;
  const hasExclude = exclude0 >= 0 || exclude1 >= 0;
  const filterTypes = !useIndices && typeArr && (hasInclude || hasExclude);
  return {
    o,
    indices,
    useIndices,
    useScreen,
    cameraX,
    cameraY,
    screenScale,
    typeArr,
    includeType,
    exclude0,
    exclude1,
    hasInclude,
    hasExclude,
    filterTypes,
    depthDenom: (o.depthDenom || capacity) + 1,
    scanCount: useIndices
      ? indexCount
      : count > capacity && !filterTypes
        ? capacity
        : count,
    particleCount: 0,
  };
}

export function fillQueueIndices(typeArr, count, includeType, excludeType, outIdx) {
  let n = 0;
  const cap = outIdx.length;
  const inc = includeType | 0;
  const exc = excludeType | 0;
  const hasInc = inc >= 0;
  const hasExc = exc >= 0;
  const nSrc = count | 0;
  for (let i = 0; i < nSrc && n < cap; i++) {
    const t = typeArr ? typeArr[i] : 0;
    if (hasInc && t !== inc) continue;
    if (hasExc && t === exc) continue;
    outIdx[n++] = i;
  }
  return n;
}

export function copyPackedRows(src, dst, count, floatsPer, prefix) {
  const n = count | 0;
  const fp = floatsPer | 0;
  if (!src || !dst || n <= 0 || fp <= 0) return;
  const from = 0;
  const to = (prefix | 0) * fp;
  const len = n * fp;
  if (to + len > dst.length || from + len > src.length) {
    const keep = Math.min(n, ((dst.length - to) / fp) | 0, ((src.length - from) / fp) | 0);
    if (keep <= 0) return;
    dst.set(src.subarray(from, from + keep * fp), to);
    return;
  }
  dst.set(src.subarray(from, from + len), to);
}
