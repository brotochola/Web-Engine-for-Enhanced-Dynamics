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
/**
 * E-162. An indexed frame's statics, in the queue's row order: GPU_STATIC_FLOATS and a zero, so a row is three RGBA
 * texels of the texture its vertex shader fetches them from (gpuPack.c pack_sprites_indexed_scatter).
 */
export const GPU_INDEXED_STATIC_FLOATS = 12;
/** E-162. An indexed frame's slot pair, in draw order: the statics' row (a float) and the slot's depth. */
export const GPU_INDEXED_SLOT_FLOATS = 2;
/** E-162. Statics rows a texture row holds: three RGBA32UI texels each, a texture 3 072 texels wide. */
export const GPU_INDEXED_TEX_ROW = 1024;
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
/**
 * E-162. The sprite region holds an indexed frame: the poses and slot pairs in draw order, every queue row's statics in
 * row order; GPU_HDR_STATIC_GEN names those statics' generation and GPU_HDR_INDEXED_ROWS how many queue rows they cover.
 */
export const GPU_FLAG_INDEXED = 4;
export const GPU_HDR_INDEXED_ROWS = 9;

export const GPU_SPACE_WORLD = 0;
export const GPU_SPACE_SCREEN = 1;

/** E-162. An indexed frame's statics rows for `maxSprites`: whole texture rows. */
export function gpuIndexedStaticRows(maxSprites) {
  const n = maxSprites | 0;
  return n > 0 ? Math.ceil(n / GPU_INDEXED_TEX_ROW) * GPU_INDEXED_TEX_ROW : 0;
}

/**
 * The sprite region's floats: the 15-float rows, which E-82b's two streams fill too; with `indexed` (caps.indexedSprites)
 * room for E-162's indexed frame as well (the poses, the slot pairs, then every row's statics in whole texture rows).
 */
export function gpuSpriteRegionFloats(maxSprites, indexed) {
  const n = maxSprites | 0;
  if (n <= 0) return 0;
  const rows = n * GPU_SPRITE_FLOATS;
  if (!indexed) return rows;
  const frame = n * (GPU_POSE_FLOATS + GPU_INDEXED_SLOT_FLOATS) + gpuIndexedStaticRows(n) * GPU_INDEXED_STATIC_FLOATS;
  return frame > rows ? frame : rows;
}

function align4(n) {
  return (n + 3) & ~3;
}

/**
 * @param {number} maxSprites
 * @param {object} [lighting]
 * @param {boolean} [indexedSprites] E-162: room for indexed frames (rendererBackend.indexedSpritesEnabled)
 */
export function gpuQueueCaps(maxSprites, lighting, indexedSprites = false) {
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
    indexedSprites: !!indexedSprites,
  };
}

export function computeGpuQueueBufferSize(caps) {
  const c = caps || gpuQueueCaps(1, null);
  let offset = GPU_HEADER_INTS * 4;
  offset += gpuSpriteRegionFloats(c.maxSprites, c.indexedSprites) * 4;
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
  // E-162: and, with caps.indexedSprites, as an indexed frame: the same poses, the slot pairs, then every row's statics
  // in whole texture rows.
  const indexed = !!c.indexedSprites;
  const spriteSlots = regionF32(sab, spritePose.next, indexed ? (c.maxSprites | 0) * GPU_INDEXED_SLOT_FLOATS : 0);
  const spriteRowStatics = regionF32(sab, spriteSlots.next, indexed ? gpuIndexedStaticRows(c.maxSprites) * GPU_INDEXED_STATIC_FLOATS : 0);
  offset += gpuSpriteRegionFloats(c.maxSprites, indexed) * 4;
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
    spriteSlots: spriteSlots.view,
    spriteRowStatics: spriteRowStatics.view,
    spriteRowStaticsU32: spriteRowStatics.u32,
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
  header[GPU_HDR_INDEXED_ROWS] = 0;
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
  header[GPU_HDR_INDEXED_ROWS] = counts.indexedRows | 0;
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
