// Decal — floor stamp API + tile atlas. Not LiquidFun. Not ParticleEmitter.
// Game: Decal.stamp (local apply on particle worker, else stamp ring).
// Atlas / save: stampToTileBuffers, packSnapshot, applySnapshot.
// Pixel loop is not a scene API.

import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { calculateDecalTileBounds, calculateTileClipRegion, randomRange, rng, _decalTileBounds, _tileClipRegion } from '../util/utils.js';
import { resolveParticleOp, resolveParticleColorOp } from '../util/particleTween.js';

const STAMP_HDR_WRITE = 0;
const STAMP_HDR_READ = 1;
const STAMP_HDR_CAP = 2;
const STAMP_HDR_OVERFLOW = 3;
const STAMP_HEADER_I32 = 4;
const STAMP_STRIDE_I32 = 9;
const STAMP_RING_DEFAULT_CAPACITY = 1024;

let stampRingI32 = null;
let stampRingF32 = null;
let stampRingCap = 0;
let stampOverflowWarned = false;
let stampLocalApply = null;

let atlasRgba = null;
let atlasTileSize = 0;
let atlasTilePixelSize = 0;
let atlasTilesX = 0;
let atlasTilesY = 0;

const stampOpA = { from: 0, to: 0, tween: false, ease: 0 };
const stampOpB = { from: 0, to: 0, tween: false, ease: 0 };

function resolveStampTextureId(config) {
  let textureName = config.texture;
  if (config.spritesheet && config.animation !== undefined && !Array.isArray(config.frame)) {
    textureName = SpriteSheetRegistry.getFrameName(
      config.spritesheet,
      config.animation,
      config.frame ?? 0
    );
  }
  let textureId = textureName ? SpriteSheetRegistry.getTextureId(textureName) : 0;
  if (Array.isArray(config.frame) && config.spritesheet && config.animation !== undefined) {
    const frames = config.frame;
    const n = Math.min(8, frames.length);
    const ids = [];
    for (let f = 0; f < n; f++) {
      const fname = SpriteSheetRegistry.getFrameName(config.spritesheet, config.animation, frames[f]);
      if (!fname) continue;
      ids.push(SpriteSheetRegistry.getTextureId(fname));
    }
    if (ids.length > 0) {
      textureId = ids.length === 1 ? ids[0] : ids[(rng() * ids.length) | 0];
    }
  }
  return textureId | 0;
}

function tileHasContent(rgba, byteOffset, bytesPerTile) {
  const end = byteOffset + bytesPerTile;
  for (let i = byteOffset + 3; i < end; i += 4) {
    if (rgba[i] !== 0) return true;
  }
  return false;
}

function canEncodePng() {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
}

async function encodeTilePng(rgba, byteOffset, tilePixelSize, bytesPerTile) {
  const canvas = new OffscreenCanvas(tilePixelSize, tilePixelSize);
  const ctx = canvas.getContext('2d');
  const copy = new Uint8ClampedArray(bytesPerTile);
  copy.set(rgba.subarray(byteOffset, byteOffset + bytesPerTile));
  const imageData = new ImageData(copy, tilePixelSize, tilePixelSize);
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function decodeTilePng(bytes, tilePixelSize, bytesPerTile) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bitmap = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(tilePixelSize, tilePixelSize);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  const imageData = ctx.getImageData(0, 0, tilePixelSize, tilePixelSize);
  if (imageData.data.byteLength !== bytesPerTile) {
    throw new Error(
      `Decal: PNG decode size mismatch (got ${imageData.data.byteLength}, expected ${bytesPerTile})`
    );
  }
  return imageData.data;
}

export class Decal {
  static STAMP_RING_DEFAULT_CAPACITY = STAMP_RING_DEFAULT_CAPACITY;

  static createStampRingSab(capacity) {
    const cap = Math.max(64, (capacity == null ? STAMP_RING_DEFAULT_CAPACITY : capacity) | 0);
    const sab = new SharedArrayBuffer((STAMP_HEADER_I32 + cap * STAMP_STRIDE_I32) * 4);
    const i32 = new Int32Array(sab);
    Atomics.store(i32, STAMP_HDR_WRITE, 0);
    Atomics.store(i32, STAMP_HDR_READ, 0);
    Atomics.store(i32, STAMP_HDR_CAP, cap);
    Atomics.store(i32, STAMP_HDR_OVERFLOW, 0);
    for (let i = 0; i < cap; i++) {
      i32[STAMP_HEADER_I32 + i * STAMP_STRIDE_I32] = i;
    }
    return sab;
  }

  static bindStampRing(sab) {
    if (!sab) {
      stampRingI32 = null;
      stampRingF32 = null;
      stampRingCap = 0;
      stampOverflowWarned = false;
      return;
    }
    stampRingI32 = new Int32Array(sab);
    stampRingF32 = new Float32Array(sab);
    stampRingCap = Atomics.load(stampRingI32, STAMP_HDR_CAP) | 0;
  }

  static isStampRingBound() {
    return stampRingI32 != null && stampRingCap > 0;
  }

  /**
   * Particle worker only: apply stamps here (owns textures + tile SAB).
   * Logic / main leave this null so stamp() enqueues the ring.
   * @param {((x:number,y:number,tint:number,scaleX:number,scaleY:number,textureId:number,alpha:number,blendMode:number)=>void)|null} fn
   */
  static bindStampApply(fn) {
    stampLocalApply = typeof fn === 'function' ? fn : null;
  }

  /**
   * Bind the decal tile atlas SAB for getColor (main + logic).
   * @param {{ tilesSab: SharedArrayBuffer, tileSize: number, tilePixelSize: number, tilesX: number, tilesY: number }|null} opts
   */
  static bindAtlas(opts) {
    if (!opts?.tilesSab || !(opts.tileSize > 0) || !(opts.tilePixelSize > 0)) {
      atlasRgba = null;
      atlasTileSize = 0;
      atlasTilePixelSize = 0;
      atlasTilesX = 0;
      atlasTilesY = 0;
      return;
    }
    atlasRgba = new Uint8ClampedArray(opts.tilesSab);
    atlasTileSize = opts.tileSize;
    atlasTilePixelSize = opts.tilePixelSize | 0;
    atlasTilesX = opts.tilesX | 0;
    atlasTilesY = opts.tilesY | 0;
  }

  /**
   * Sample atlas RGBA at world (x, y). Packed 0xRRGGBBAA, or 0 if empty / unbound.
   * Not sync with stamp — blend is on the particle worker.
   */
  static getColor(x, y) {
    if (!atlasRgba || !(atlasTileSize > 0)) return 0;
    const tx = Math.floor(x / atlasTileSize);
    const ty = Math.floor(y / atlasTileSize);
    if (tx < 0 || ty < 0 || tx >= atlasTilesX || ty >= atlasTilesY) return 0;
    const px = (((x - tx * atlasTileSize) * atlasTilePixelSize) / atlasTileSize) | 0;
    const py = (((y - ty * atlasTileSize) * atlasTilePixelSize) / atlasTileSize) | 0;
    if (px < 0 || py < 0 || px >= atlasTilePixelSize || py >= atlasTilePixelSize) return 0;
    const off = ((tx + ty * atlasTilesX) * atlasTilePixelSize * atlasTilePixelSize + py * atlasTilePixelSize + px) * 4;
    const a = atlasRgba[off + 3];
    if (a === 0) return 0;
    return ((atlasRgba[off] << 24) | (atlasRgba[off + 1] << 16) | (atlasRgba[off + 2] << 8) | a) >>> 0;
  }

  static enqueueStamp(x, y, textureId, scaleX, scaleY, tint, alpha, blendMode) {
    if (!stampRingI32) return false;
    const cap = stampRingCap;
    for (;;) {
      const write = Atomics.load(stampRingI32, STAMP_HDR_WRITE);
      const read = Atomics.load(stampRingI32, STAMP_HDR_READ);
      if (write - read >= cap) {
        Atomics.add(stampRingI32, STAMP_HDR_OVERFLOW, 1);
        if (!stampOverflowWarned) {
          stampOverflowWarned = true;
          console.warn(`[Decal] stamp ring full (cap=${cap}); dropping stamps`);
        }
        return false;
      }
      if (Atomics.compareExchange(stampRingI32, STAMP_HDR_WRITE, write, write + 1) !== write) {
        continue;
      }
      const base = STAMP_HEADER_I32 + (write % cap) * STAMP_STRIDE_I32;
      while (Atomics.load(stampRingI32, base) !== write) {
        /* wait prior lap */
      }
      stampRingI32[base + 1] = textureId | 0;
      stampRingI32[base + 2] = tint | 0;
      stampRingI32[base + 3] = blendMode | 0;
      stampRingF32[base + 4] = x;
      stampRingF32[base + 5] = y;
      stampRingF32[base + 6] = scaleX;
      stampRingF32[base + 7] = scaleY;
      stampRingF32[base + 8] = alpha;
      Atomics.store(stampRingI32, base, write + 1);
      return true;
    }
  }

  static drainStampRing(onStamp) {
    if (!stampRingI32 || typeof onStamp !== 'function') return 0;
    const cap = stampRingCap;
    let n = 0;
    for (;;) {
      const read = Atomics.load(stampRingI32, STAMP_HDR_READ);
      const write = Atomics.load(stampRingI32, STAMP_HDR_WRITE);
      if (read === write) break;
      const base = STAMP_HEADER_I32 + (read % cap) * STAMP_STRIDE_I32;
      while (Atomics.load(stampRingI32, base) !== read + 1) {
        /* wait publish */
      }
      onStamp(
        stampRingF32[base + 4],
        stampRingF32[base + 5],
        stampRingI32[base + 2] >>> 0,
        stampRingF32[base + 6],
        stampRingF32[base + 7],
        stampRingI32[base + 1] | 0,
        stampRingF32[base + 8],
        stampRingI32[base + 3] | 0
      );
      Atomics.store(stampRingI32, base, read + cap);
      Atomics.store(stampRingI32, STAMP_HDR_READ, read + 1);
      n++;
    }
    return n;
  }

  /**
   * Floor stamp. Particle worker (bindStampApply) blends now.
   * Logic / main enqueue the ring; particle worker drains next tick.
   * @param {Object} config
   * @returns {number} applied or enqueued count (0 if nowhere to send)
   */
  static stamp(config) {
    if (!config) return 0;
    const apply = stampLocalApply;
    if (!apply && !this.isStampRingBound()) return 0;
    const textureId = resolveStampTextureId(config);
    const count = Math.max(1, Math.round(randomRange(config.count, 1)));
    let n = 0;
    for (let i = 0; i < count; i++) {
      let scaleX;
      let scaleY;
      if (config.scale == null && config.scaleX != null && config.scaleY != null) {
        scaleX = resolveParticleOp(config.scaleX, 1, stampOpA).from;
        scaleY = resolveParticleOp(config.scaleY, 1, stampOpB).from;
      } else {
        const s = resolveParticleOp(config.scale ?? config.scaleX ?? config.scaleY, 1, stampOpA).from;
        scaleX = s;
        scaleY = s;
      }
      const x = randomRange(config.x);
      const y = randomRange(config.y);
      const tint = resolveParticleColorOp(config.tint, 0xffffff, stampOpA).from;
      const alpha = resolveParticleOp(config.alpha, 1, stampOpA).from;
      const blendMode = config.blendMode ?? 0;
      if (apply) {
        apply(x, y, tint, scaleX, scaleY, textureId, alpha, blendMode);
        n++;
        continue;
      }
      if (!this.enqueueStamp(x, y, textureId, scaleX, scaleY, tint, alpha, blendMode)) break;
      n++;
    }
    return n;
  }

  /**
   * Blend one stamp onto the shared decal tile buffers.
   * Pure over the buffers passed in — no `this` access.
   * @param {Object} params
   */
  static stampToTileBuffers({
    worldX,
    worldY,
    tint,
    scaleX,
    scaleY,
    alpha,
    blendMode,
    textureRgba,
    texWidth,
    texHeight,
    decalsTiles,
    decalsTilesDirty,
    decalsTileSize,
    decalsTilePixelSize,
    decalsTilesX,
    decalsTilesY,
    decalsResolution,
  }) {
    const tileSize = decalsTileSize;
    const tilePixelSize = decalsTilePixelSize;
    const tilesX = decalsTilesX;
    const tilesY = decalsTilesY;

    const scaledWidthWorld = texWidth * scaleX;
    const scaledHeightWorld = texHeight * scaleY;
    const halfWidthWorld = scaledWidthWorld / 2;
    const halfHeightWorld = scaledHeightWorld / 2;

    const resolution = decalsResolution;
    const scaledWidthPixels = (scaledWidthWorld * resolution + 0.999) | 0;
    const scaledHeightPixels = (scaledHeightWorld * resolution + 0.999) | 0;

    calculateDecalTileBounds(worldX, worldY, halfWidthWorld, halfHeightWorld, tileSize, tilesX, tilesY, _decalTileBounds);

    if (!_decalTileBounds.valid) return;

    const tintR = (tint >> 16) & 0xff;
    const tintG = (tint >> 8) & 0xff;
    const tintB = tint & 0xff;

    const invScaledWidth = texWidth / scaledWidthPixels;
    const invScaledHeight = texHeight / scaledHeightPixels;

    for (let ty = _decalTileBounds.minTileY; ty <= _decalTileBounds.maxTileY; ty++) {
      for (let tx = _decalTileBounds.minTileX; tx <= _decalTileBounds.maxTileX; tx++) {
        calculateTileClipRegion(worldX, worldY, halfWidthWorld, halfHeightWorld, tx, ty, tileSize, tilePixelSize, texWidth, texHeight, scaledWidthPixels, scaledHeightPixels, _tileClipRegion);

        if (!_tileClipRegion.valid) continue;

        const tileIndex = tx + ty * tilesX;
        const tileByteOffset = tileIndex * tilePixelSize * tilePixelSize * 4;

        const dstStartX = _tileClipRegion.dstStartX;
        const dstStartY = _tileClipRegion.dstStartY;
        const dstEndX = _tileClipRegion.dstEndX;
        const dstEndY = _tileClipRegion.dstEndY;
        const srcOffsetX = _tileClipRegion.srcOffsetX;
        const srcOffsetY = _tileClipRegion.srcOffsetY;
        const uvScaleX = _tileClipRegion.uvScaleX;
        const uvScaleY = _tileClipRegion.uvScaleY;

        const stepX = uvScaleX * invScaledWidth;
        const stepY = uvScaleY * invScaledHeight;
        let srcYAccum = srcOffsetY * invScaledHeight;

        for (let dstY = dstStartY; dstY < dstEndY; dstY++, srcYAccum += stepY) {
          const srcY = srcYAccum | 0;

          if (srcY < 0 || srcY >= texHeight) continue;

          const srcRowOffset = srcY * texWidth;
          const dstRowOffset = tileByteOffset + dstY * tilePixelSize * 4;

          let srcXAccum = srcOffsetX * invScaledWidth;
          for (let dstX = dstStartX; dstX < dstEndX; dstX++, srcXAccum += stepX) {
            const srcX = srcXAccum | 0;

            if (srcX < 0 || srcX >= texWidth) continue;

            const srcOffset = (srcRowOffset + srcX) * 4;
            const texAlpha = textureRgba[srcOffset + 3];

            if (texAlpha < 1) continue;

            const srcR = textureRgba[srcOffset];
            const srcG = textureRgba[srcOffset + 1];
            const srcB = textureRgba[srcOffset + 2];

            const dstOffset = dstRowOffset + dstX * 4;

            if (blendMode === 1) {
              const tintedR = (srcR * tintR + 127) >> 8;
              const tintedG = (srcG * tintG + 127) >> 8;
              const tintedB = (srcB * tintB + 127) >> 8;

              const luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;
              const darkness = 255 - luminance;

              const effectiveAlpha = (((texAlpha * darkness) >> 8) * alpha) | 0;

              if (effectiveAlpha < 2) continue;

              const invEffectiveAlpha = 255 - effectiveAlpha;
              const dstR = decalsTiles[dstOffset];
              const dstG = decalsTiles[dstOffset + 1];
              const dstB = decalsTiles[dstOffset + 2];
              const dstA = decalsTiles[dstOffset + 3];

              decalsTiles[dstOffset] = (dstR * invEffectiveAlpha + 127) >> 8;
              decalsTiles[dstOffset + 1] = (dstG * invEffectiveAlpha + 127) >> 8;
              decalsTiles[dstOffset + 2] = (dstB * invEffectiveAlpha + 127) >> 8;
              decalsTiles[dstOffset + 3] = effectiveAlpha + ((dstA * invEffectiveAlpha + 127) >> 8);
            } else {
              const srcA = (texAlpha * alpha) | 0;

              if (srcA < 1) continue;

              const finalR = (srcR * tintR + 127) >> 8;
              const finalG = (srcG * tintG + 127) >> 8;
              const finalB = (srcB * tintB + 127) >> 8;

              const invSrcA = 255 - srcA;
              const dstR = decalsTiles[dstOffset];
              const dstG = decalsTiles[dstOffset + 1];
              const dstB = decalsTiles[dstOffset + 2];
              const dstA = decalsTiles[dstOffset + 3];

              decalsTiles[dstOffset] = dstR + (((finalR - dstR) * srcA + 127) >> 8);
              decalsTiles[dstOffset + 1] = dstG + (((finalG - dstG) * srcA + 127) >> 8);
              decalsTiles[dstOffset + 2] = dstB + (((finalB - dstB) * srcA + 127) >> 8);
              decalsTiles[dstOffset + 3] = srcA + ((dstA * invSrcA + 127) >> 8);
            }
          }
        }

        decalsTilesDirty[tileIndex] = 1;
      }
    }
  }

  /**
   * Pack non-empty decal tiles from scene SharedArrayBuffer.
   * Browser: PNG bytes per tile. Node / no OffscreenCanvas: raw RGBA bytes.
   * @param {object} scene
   * @returns {Promise<object|null>}
   */
  static async packSnapshot(scene) {
    if (!scene?.config?.particle?.decals) return null;
    const sab = scene.buffers?.decalsTilesRGBA;
    if (!sab) return null;

    const tilesX = scene.decalsTilesX | 0;
    const tilesY = scene.decalsTilesY | 0;
    const totalTiles = scene.decalsTotalTiles | (tilesX * tilesY);
    const tilePixelSize = scene.config.particle.decalsTilePixelSize | 0;
    const tileSize = scene.config.particle.decalsTileSize | 0;
    if (!(totalTiles > 0) || !(tilePixelSize > 0)) return null;

    const bytesPerTile = tilePixelSize * tilePixelSize * 4;
    const rgba = new Uint8ClampedArray(sab);
    const usePng = canEncodePng();
    const tiles = [];

    for (let i = 0; i < totalTiles; i++) {
      const byteOffset = i * bytesPerTile;
      if (!tileHasContent(rgba, byteOffset, bytesPerTile)) continue;
      if (usePng) {
        const bytes = await encodeTilePng(rgba, byteOffset, tilePixelSize, bytesPerTile);
        tiles.push({ i, fmt: 'png', bytes });
      } else {
        tiles.push({
          i,
          fmt: 'raw',
          bytes: new Uint8Array(rgba.subarray(byteOffset, byteOffset + bytesPerTile)),
        });
      }
    }

    if (!tiles.length) return null;

    return {
      tilesX,
      tilesY,
      tilePixelSize,
      tileSize,
      tiles,
    };
  }

  /**
   * Restore packed decal tiles into scene SAB and mark dirty for pixi upload.
   * @param {object} scene
   * @param {object|null} blob
   * @returns {Promise<{ ok: boolean, restored: number, reason?: string }>}
   */
  static async applySnapshot(scene, blob) {
    if (!blob || !Array.isArray(blob.tiles) || !blob.tiles.length) {
      return { ok: true, restored: 0 };
    }
    if (!scene?.config?.particle?.decals) {
      console.warn('[Decal] decals disabled on scene; skip restore');
      return { ok: false, restored: 0, reason: 'decals-disabled' };
    }

    const tilesX = scene.decalsTilesX | 0;
    const tilesY = scene.decalsTilesY | 0;
    const tilePixelSize = scene.config.particle.decalsTilePixelSize | 0;
    if (
      (blob.tilesX | 0) !== tilesX ||
      (blob.tilesY | 0) !== tilesY ||
      (blob.tilePixelSize | 0) !== tilePixelSize
    ) {
      console.warn(
        `[Decal] layout mismatch (save=${blob.tilesX}x${blob.tilesY}@${blob.tilePixelSize}, live=${tilesX}x${tilesY}@${tilePixelSize}); skip`
      );
      return { ok: false, restored: 0, reason: 'layout-mismatch' };
    }

    const sab = scene.buffers?.decalsTilesRGBA;
    const dirtySab = scene.buffers?.decalsTilesDirty;
    if (!sab || !dirtySab) {
      return { ok: false, restored: 0, reason: 'no-buffers' };
    }

    const bytesPerTile = tilePixelSize * tilePixelSize * 4;
    const totalTiles = scene.decalsTotalTiles | (tilesX * tilesY);
    const rgba = new Uint8ClampedArray(sab);
    const dirty = new Uint8Array(dirtySab);
    let restored = 0;

    for (const tile of blob.tiles) {
      const i = tile.i | 0;
      if (i < 0 || i >= totalTiles || !tile.bytes) continue;
      const byteOffset = i * bytesPerTile;
      let pixels;
      if (tile.fmt === 'png') {
        if (!canEncodePng()) {
          console.warn('[Decal] PNG tile but OffscreenCanvas unavailable; skip tile', i);
          continue;
        }
        pixels = await decodeTilePng(tile.bytes, tilePixelSize, bytesPerTile);
      } else {
        pixels = tile.bytes instanceof Uint8Array ? tile.bytes : new Uint8Array(tile.bytes);
        if (pixels.byteLength !== bytesPerTile) {
          console.warn('[Decal] raw tile size mismatch; skip tile', i);
          continue;
        }
      }
      rgba.set(pixels, byteOffset);
      dirty[i] = 1;
      restored++;
    }

    return { ok: true, restored };
  }
}
