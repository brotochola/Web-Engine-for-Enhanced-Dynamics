/**
 * Shared GPU-format queues: pre-render writes interleaved instance rows,
 * pixi copies those bytes into the Mesh buffer and draws.
 *
 * Regions (after an 8-int header): sprites, glows, sun casters, point-light
 * stamped casters, cookies. Caster rows are the 15 sprite floats plus
 * shadowH/off and a light vec4 (22 floats). Cookies are 15-float rows already
 * in shadow-RT pixels.
 */

export const GPU_SPRITE_FLOATS = 15;
/** x, y, intensity, rangeSq. Sits after shadowH, shadowOffX, shadowOffY. */
export const GPU_CASTER_LIGHT_FLOAT = GPU_SPRITE_FLOATS + 3;
export const GPU_CASTER_FLOATS = GPU_CASTER_LIGHT_FLOAT + 4;
/**
 * E-82b. With GPU_FLAG_SPLIT the sprite region holds the same terms in two streams instead of 15-float
 * rows: the poses first (x, y, rotC, rotS, GPU_POSE_FLOATS a row), then the statics (scale, anchor, depth,
 * packed tint, texture, tile terms, GPU_STATIC_FLOATS a row: E-82's static order). GPU_HDR_STATIC_GEN is
 * the queue's staticGen when the statics are those of that generation, else 0, so Pixi uploads the statics
 * only when it changes. Same bytes as the 15-float rows.
 */
export const GPU_POSE_FLOATS = 4;
export const GPU_STATIC_FLOATS = 11;
export const GPU_HEADER_INTS = 12;
export const GPU_QUEUE_VERSION = 6;

export const GPU_HDR_SPRITE = 0;
export const GPU_HDR_GLOW = 1;
export const GPU_HDR_SUN = 2;
export const GPU_HDR_STAMP = 3;
export const GPU_HDR_COOKIE = 4;
export const GPU_HDR_PARTICLE = 5;
export const GPU_HDR_FLAGS = 6;
export const GPU_HDR_VERSION = 7;
export const GPU_HDR_STATIC_GEN = 8;

export const GPU_FLAG_SORTED = 1;
export const GPU_FLAG_SPLIT = 2;

export const GPU_SPACE_WORLD = 0;
export const GPU_SPACE_SCREEN = 1;

function align4(n) {
  return (n + 3) & ~3;
}

function snapWorldToPixel(v, cam, zoom) {
  if (!(zoom > 0)) return v;
  return Math.round((v - cam) * zoom) / zoom + cam;
}

/**
 * @param {number} maxSprites
 * @param {object} [lighting]
 */
export function gpuQueueCaps(maxSprites, lighting) {
  const sprites = Math.max(1, maxSprites | 0);
  const lightsOn = !!(lighting && lighting.enabled);
  const shadowOn = !!(lighting && lighting.shadowsEnabled);
  const maxLights = Math.max(1, (lighting && lighting.maxLights) | 0 || 1);
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
    stamp = Math.max(1, Math.min(fromLights, fromEnt));
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

/** The GPU queue's views on `sab`, from byte `base` (a region of the render-queue memory, or 0). */
export function createGpuQueueViews(sab, caps, base = 0) {
  const c = caps || gpuQueueCaps(1, null);
  const start = base | 0;
  let offset = start;
  const header = new Int32Array(sab, offset, GPU_HEADER_INTS);
  offset += GPU_HEADER_INTS * 4;
  const sprites = regionF32(sab, offset, (c.maxSprites | 0) * GPU_SPRITE_FLOATS);
  // E-82b: the same region as two streams.
  const spritePose = regionF32(sab, offset, (c.maxSprites | 0) * GPU_POSE_FLOATS);
  const spriteStatic = regionF32(sab, spritePose.next, (c.maxSprites | 0) * GPU_STATIC_FLOATS);
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
  // A spriteKeys region (maxSprites floats) used to follow; nothing read or
  // wrote it, so it is gone (review D6).
  offset = align4(offset + stampN * 2);
  return {
    header,
    sprites: sprites.view,
    spritesU32: sprites.u32,
    spritePose: spritePose.view,
    spriteStatic: spriteStatic.view,
    spriteStaticU32: spriteStatic.u32,
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
    byteLength: offset - start,
  };
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
  header[GPU_HDR_STATIC_GEN] = 0;
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
  header[GPU_HDR_STATIC_GEN] = counts.staticGen | 0;
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

/**
 * Call-level setup matching InstancedSpriteBatch._beginUpload, without touching a Mesh.
 */
export function makePackContext(q, opts, capacity, out) {
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
  const ctx = out || {};
  ctx.o = o;
  ctx.indices = indices;
  ctx.useIndices = useIndices;
  ctx.useScreen = useScreen;
  ctx.cameraX = cameraX;
  ctx.cameraY = cameraY;
  ctx.screenScale = screenScale;
  const rot = o.cameraRot || 0;
  ctx.cameraRot = rot;
  if (rot && useScreen) {
    const z = zoom || 1;
    const canvasW = o.canvasW || 0;
    const canvasH = o.canvasH || 0;
    const res = resolution || 1;
    ctx.camC = Math.cos(rot);
    ctx.camS = Math.sin(rot);
    ctx.focusX = cameraX + canvasW / (2 * z);
    ctx.focusY = cameraY + canvasH / (2 * z);
    ctx.halfW = canvasW * 0.5 * res;
    ctx.halfH = canvasH * 0.5 * res;
  } else {
    ctx.camC = 1;
    ctx.camS = 0;
    ctx.focusX = 0;
    ctx.focusY = 0;
    ctx.halfW = 0;
    ctx.halfH = 0;
  }
  ctx.typeArr = typeArr;
  ctx.includeType = includeType;
  ctx.exclude0 = exclude0;
  ctx.exclude1 = exclude1;
  ctx.hasInclude = hasInclude;
  ctx.hasExclude = hasExclude;
  ctx.filterTypes = filterTypes;
  ctx.depthDenom = (o.depthDenom || capacity) + 1;
  ctx.scanCount = useIndices
    ? indexCount
    : count > capacity && !filterTypes
      ? capacity
      : count;
  ctx.particleCount = 0;
  return ctx;
}

export function fillQueueIndices(typeArr, count, includeType, excludeType, outIdx) {
  const cap = outIdx.length;
  const inc = includeType | 0;
  const exc = excludeType | 0;
  const hasInc = inc >= 0;
  const hasExc = exc >= 0;
  const nSrc = count | 0;
  const limit = nSrc < cap ? nSrc : cap;
  let n = 0;

  if (!hasInc && !hasExc) {
    for (let i = 0; i < limit; i++) outIdx[i] = i;
    return limit;
  }

  if (hasInc && !hasExc) {
    if (!typeArr) {
      if (inc === 0) {
        for (let i = 0; i < limit; i++) outIdx[i] = i;
        return limit;
      }
      return 0;
    }
    for (let i = 0; i < limit; i++) {
      if (typeArr[i] === inc) outIdx[n++] = i;
    }
    return n;
  }

  if (!hasInc && hasExc) {
    if (!typeArr) {
      if (exc !== 0) {
        for (let i = 0; i < limit; i++) outIdx[i] = i;
        return limit;
      }
      return 0;
    }
    for (let i = 0; i < limit; i++) {
      if (typeArr[i] !== exc) outIdx[n++] = i;
    }
    return n;
  }

  if (!typeArr) {
    if (inc === 0 && exc !== 0) {
      for (let i = 0; i < limit; i++) outIdx[i] = i;
      return limit;
    }
    return 0;
  }
  for (let i = 0; i < limit; i++) {
    const t = typeArr[i];
    if (t === inc && t !== exc) outIdx[n++] = i;
  }
  return n;
}
