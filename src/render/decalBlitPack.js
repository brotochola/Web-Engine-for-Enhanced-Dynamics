/**
 * Pack dirty decal tiles into InstancedSpriteBatch stride (SoA → one mesh).
 * Kernel / future blit batch. Not the ImageBitmap upload.
 */

/** Same stride as InstancedSpriteBatch. Do not import that file (Pixi). */
export const INSTANCED_SPRITE_FLOATS = 15;

/**
 * Dummy “one PIXI.Sprite record” write: x, y, visible. Baseline for the kernel.
 * @param {Float32Array} out
 * @param {number} i
 * @param {number} x
 * @param {number} y
 * @param {number} visible
 */
export function writeDecalSpriteRecord(out, i, x, y, visible) {
  const o = i * 3;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = visible;
}

/**
 * One visible tile as an instanced sprite row (world xy, tile size, texId).
 * @param {Float32Array} out
 * @param {Uint32Array} outU32
 * @param {number} i
 * @param {number} x
 * @param {number} y
 * @param {number} tileSize
 * @param {number} texId
 * @param {number} depth
 */
export function writeDecalBlitInstance(out, outU32, i, x, y, tileSize, texId, depth) {
  const o = i * INSTANCED_SPRITE_FLOATS;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = tileSize;
  out[o + 3] = tileSize;
  out[o + 4] = 0;
  out[o + 5] = 0;
  out[o + 6] = 1;
  out[o + 7] = 0;
  out[o + 8] = depth;
  outU32[o + 9] = 0xffffffff;
  out[o + 10] = texId;
  out[o + 11] = 0;
  out[o + 12] = 0;
  out[o + 13] = 0;
  out[o + 14] = 0;
}

/**
 * Pack dirty tiles from a flat dirty[] + grid.
 * @param {Float32Array} out
 * @param {object} views
 * @returns {number} instance count
 */
export function packDecalBlit(out, views) {
  const tilesX = views.tilesX | 0;
  const tilesY = views.tilesY | 0;
  const tileSize = views.tileSize || 1;
  const dirty = views.dirty;
  const cap = views.cap | 0;
  const outU32 = views.outU32 || new Uint32Array(out.buffer, out.byteOffset, out.length);
  const depthDenom = cap + 1;
  let written = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const idx = tx + ty * tilesX;
      if (!dirty[idx]) continue;
      if (written >= cap) return written;
      writeDecalBlitInstance(
        out,
        outU32,
        written,
        tx * tileSize,
        ty * tileSize,
        tileSize,
        idx,
        1 - (written + 1) / depthDenom,
      );
      written++;
    }
  }
  return written;
}

/**
 * @param {Float32Array} out
 * @param {object} views
 * @returns {number}
 */
export function packDecalSpriteRecords(out, views) {
  const tilesX = views.tilesX | 0;
  const tilesY = views.tilesY | 0;
  const tileSize = views.tileSize || 1;
  const dirty = views.dirty;
  const cap = views.cap | 0;
  let written = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const idx = tx + ty * tilesX;
      if (!dirty[idx]) continue;
      if (written >= cap) return written;
      writeDecalSpriteRecord(out, written, tx * tileSize, ty * tileSize, 1);
      written++;
    }
  }
  return written;
}

/**
 * @param {Float32Array} inst
 * @param {Float32Array} sprites
 * @param {number} n
 * @returns {number}
 */
export function checksumDecalBlit(inst, sprites, n) {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const io = i * INSTANCED_SPRITE_FLOATS;
    const so = i * 3;
    acc = (acc + (inst[io] | 0) + (inst[io + 1] | 0) + (sprites[so] | 0) + (sprites[so + 1] | 0)) | 0;
    if (inst[io] !== sprites[so] || inst[io + 1] !== sprites[so + 1]) return -1;
  }
  return acc >>> 0;
}
