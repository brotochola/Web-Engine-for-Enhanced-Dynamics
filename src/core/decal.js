// Decal — floor stamp API + tile atlas. Not LiquidFun. Not ParticleEmitter.
// Game: Decal.stamp (local apply on particle worker, else stamp ring).
// Atlas / save: packSnapshot, applySnapshot. The stamp itself is decalStamp.wasm, in the particle worker.
// Pixel loop is not a scene API.

import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { randomRange, rng } from '../util/utils.js';
import { resolveParticleOp, resolveParticleColorOp } from '../util/particleTween.js';
import { spinPause } from '../util/spinPause.js';

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
// E-108. One stamp's doubles (x, y, scaleX, scaleY, alpha) on their way into the ring: through
// this array only integers cross the call, which made a heap number per double before.
const STAMP_IN = new Float64Array(5);
// E-286. A plain stamp's numbers (x, y, scaleX, scaleY, alpha, tint), defaults applied, from stamp() to its body:
// stamp() is small enough to be inlined into the caller, and the body never sees the options object, so escape
// analysis removes the literal games pass (allocated, with a heap number per double field, on every call before).
const STAMP_PLAIN = new Float64Array(6);

/** A stamp field: a plain number as given, anything else (a range, a from/to) resolved. */
function stampNumber(value, defaultVal, op) {
  return typeof value === 'number' ? value : resolveParticleOp(value, defaultVal, op).from;
}

function resolveStampTextureId(texture, spritesheet, animation, frame) {
  let textureName = texture;
  if (spritesheet && animation !== undefined && !Array.isArray(frame)) {
    textureName = SpriteSheetRegistry.getFrameName(
      spritesheet,
      animation,
      frame ?? 0
    );
  }
  let textureId = textureName ? SpriteSheetRegistry.getTextureId(textureName) : 0;
  if (Array.isArray(frame) && spritesheet && animation !== undefined) {
    const frames = frame;
    const n = Math.min(8, frames.length);
    const ids = [];
    for (let f = 0; f < n; f++) {
      const fname = SpriteSheetRegistry.getFrameName(spritesheet, animation, frames[f]);
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

function canDeflate() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

/** Bytes through a CompressionStream or DecompressionStream. */
async function streamBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/**
 * N-314: a save's decal tiles are their RGBA bytes through the browser's deflate (deflate-raw), this many at a time. PNG
 * through a canvas took 3 to 5 ms a tile one after another (Predator's save spent 2.56 s there, R-1528), lost
 * precision on every semi-transparent pixel (the canvas premultiplies), and kept twice the bytes; deflate gives the
 * tile back exactly and decodes several times faster. Each tile in flight holds its copy, so the count is bounded.
 */
const TILE_CODEC_IN_FLIGHT = 16;

/** task(k) for every k below count, at most `limit` running at once; the results by k. */
async function runInFlight(count, limit, task) {
  const results = new Array(count);
  let next = 0;
  const lane = async () => {
    while (next < count) {
      const k = next++;
      results[k] = await task(k);
    }
  };
  const lanes = [];
  for (let l = 0; l < limit && l < count; l++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

/** A deflated tile's RGBA bytes; throws when they are not one tile. */
async function inflateTile(bytes, bytesPerTile) {
  const pixels = await streamBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), new DecompressionStream('deflate-raw'));
  if (pixels.byteLength !== bytesPerTile) {
    throw new Error(`Decal: inflated tile is ${pixels.byteLength} bytes, expected ${bytesPerTile}`);
  }
  return pixels;
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
    STAMP_IN[0] = x;
    STAMP_IN[1] = y;
    STAMP_IN[2] = scaleX;
    STAMP_IN[3] = scaleY;
    STAMP_IN[4] = alpha;
    return this._enqueueStampIn(textureId, tint, blendMode);
  }

  /** enqueueStamp with the doubles already in STAMP_IN (E-108). */
  static _enqueueStampIn(textureId, tint, blendMode) {
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
        spinPause();
      }
      stampRingI32[base + 1] = textureId | 0;
      stampRingI32[base + 2] = tint | 0;
      stampRingI32[base + 3] = blendMode | 0;
      stampRingF32[base + 4] = STAMP_IN[0];
      stampRingF32[base + 5] = STAMP_IN[1];
      stampRingF32[base + 6] = STAMP_IN[2];
      stampRingF32[base + 7] = STAMP_IN[3];
      stampRingF32[base + 8] = STAMP_IN[4];
      Atomics.store(stampRingI32, base, write + 1);
      return true;
    }
  }

  /**
   * The particle worker's drain: each queued stamp to onStamp(x, y, tint, scaleX, scaleY, textureId, alpha, blendMode).
   * E-351: `thisArg` is onStamp's `this`, so the worker passes its method and itself instead of a closure a frame.
   */
  static drainStampRing(onStamp, thisArg) {
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
        spinPause();
      }
      onStamp.call(
        thisArg,
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
    // E-286: the fields are read here, once, and the bodies get only their values: numbers through STAMP_PLAIN when
    // every number a stamp uses is a number (the common stamp), the values as they are otherwise (a range, a from/to).
    // A missing x, y, tint or alpha takes its default here, which the ranged body resolves alike. Each body checks
    // first that the stamp has somewhere to go: this front stays small for its callers' inlining budget.
    const x = config.x ?? 0;
    const y = config.y ?? 0;
    const tint = config.tint ?? 0xffffff;
    const alpha = config.alpha ?? 1;
    const scale = config.scale;
    const scaleX = config.scaleX;
    const scaleY = config.scaleY;
    // The scales a stamp uses: scaleX and scaleY when both are given without scale, else the first given of the three.
    let sx;
    let sy;
    if (scale == null && scaleX != null && scaleY != null) {
      sx = scaleX;
      sy = scaleY;
    } else {
      sx = sy = scale ?? scaleX ?? scaleY ?? 1;
    }
    if (typeof x === 'number' && typeof y === 'number' && typeof sx === 'number' && typeof sy === 'number' &&
      typeof alpha === 'number' && typeof tint === 'number') {
      const f = STAMP_PLAIN;
      f[0] = x;
      f[1] = y;
      f[2] = sx;
      f[3] = sy;
      f[4] = alpha;
      f[5] = tint;
      return this._stampPlain(config.texture, config.spritesheet, config.animation, config.frame, config.count,
        config.blendMode);
    }
    return this._stampFields(config.texture, config.spritesheet, config.animation, config.frame, config.count, x, y,
      scale, scaleX, scaleY, tint, alpha, config.blendMode);
  }

  /**
   * stamp()'s body for a plain stamp (E-286): the numbers in STAMP_PLAIN, the rest as arguments.
   * @private
   */
  static _stampPlain(texture, spritesheet, animation, frame, countField, blendModeField) {
    // The numbers are read before any call (the texture's, the apply), which could reach another stamp.
    const f = STAMP_PLAIN;
    const x = f[0];
    const y = f[1];
    const scaleX = f[2];
    const scaleY = f[3];
    const alpha = f[4];
    const tint = f[5];
    const apply = stampLocalApply;
    if (!apply && !this.isStampRingBound()) return 0;
    const textureId = resolveStampTextureId(texture, spritesheet, animation, frame);
    const count = Math.max(1, Math.round(randomRange(countField, 1)));
    const blendMode = blendModeField ?? 0;
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (apply) {
        apply(x, y, tint, scaleX, scaleY, textureId, alpha, blendMode);
        n++;
        continue;
      }
      STAMP_IN[0] = x;
      STAMP_IN[1] = y;
      STAMP_IN[2] = scaleX;
      STAMP_IN[3] = scaleY;
      STAMP_IN[4] = alpha;
      if (!this._enqueueStampIn(textureId, tint, blendMode)) break;
      n++;
    }
    return n;
  }

  /**
   * stamp()'s body when a field is a range or a from/to: each stamp of the count resolves its own values.
   * @private
   */
  static _stampFields(texture, spritesheet, animation, frame, countField, xField, yField, scaleField, scaleXField,
    scaleYField, tintField, alphaField, blendModeField) {
    const apply = stampLocalApply;
    if (!apply && !this.isStampRingBound()) return 0;
    const textureId = resolveStampTextureId(texture, spritesheet, animation, frame);
    const count = Math.max(1, Math.round(randomRange(countField, 1)));
    let n = 0;
    for (let i = 0; i < count; i++) {
      let scaleX;
      let scaleY;
      if (scaleField == null && scaleXField != null && scaleYField != null) {
        scaleX = stampNumber(scaleXField, 1, stampOpA);
        scaleY = stampNumber(scaleYField, 1, stampOpB);
      } else {
        const s = stampNumber(scaleField ?? scaleXField ?? scaleYField, 1, stampOpA);
        scaleX = s;
        scaleY = s;
      }
      const x = randomRange(xField);
      const y = randomRange(yField);
      const tint = typeof tintField === 'number'
        ? tintField
        : resolveParticleColorOp(tintField, 0xffffff, stampOpA).from;
      const alpha = stampNumber(alphaField, 1, stampOpA);
      const blendMode = blendModeField ?? 0;
      if (apply) {
        apply(x, y, tint, scaleX, scaleY, textureId, alpha, blendMode);
        n++;
        continue;
      }
      STAMP_IN[0] = x;
      STAMP_IN[1] = y;
      STAMP_IN[2] = scaleX;
      STAMP_IN[3] = scaleY;
      STAMP_IN[4] = alpha;
      if (!this._enqueueStampIn(textureId, tint, blendMode)) break;
      n++;
    }
    return n;
  }

  /**
   * Pack non-empty decal tiles from scene SharedArrayBuffer: each tile's RGBA bytes deflated (N-314), or raw with
   * compress false (a save kept in memory) or where CompressionStream is missing.
   * @param {object} scene
   * @param {{ compress?: boolean }} [options]
   * @returns {Promise<object|null>}
   */
  static async packSnapshot(scene, options = {}) {
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
    const compress = options.compress !== false && canDeflate();

    const used = [];
    for (let i = 0; i < totalTiles; i++) {
      if (tileHasContent(rgba, i * bytesPerTile, bytesPerTile)) used.push(i);
    }
    if (!used.length) return null;

    // A tile is copied off the shared buffer (which the particle worker keeps stamping) when its turn comes: a Blob
    // takes no shared memory, and a copy of every tile at once would hold them all.
    const copyOf = (i) => rgba.slice(i * bytesPerTile, (i + 1) * bytesPerTile);
    let tiles;
    if (compress) {
      const packed = await runInFlight(used.length, TILE_CODEC_IN_FLIGHT, (k) =>
        streamBytes(new Uint8Array(copyOf(used[k]).buffer), new CompressionStream('deflate-raw')),
      );
      tiles = used.map((i, k) => ({ i, fmt: 'deflate', bytes: packed[k] }));
    } else {
      tiles = used.map((i) => ({ i, fmt: 'raw', bytes: new Uint8Array(copyOf(i).buffer) }));
    }

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

    // The tiles to write, in the save's order; deflated ones inflated TILE_CODEC_IN_FLIGHT at a time (N-314).
    const kept = [];
    for (const tile of blob.tiles) {
      const i = tile.i | 0;
      if (i < 0 || i >= totalTiles || !tile.bytes) continue;
      if (tile.fmt === 'deflate') {
        if (!canDeflate()) {
          console.warn('[Decal] deflated tile but DecompressionStream unavailable; skip tile', i);
          continue;
        }
      } else {
        const raw = tile.bytes instanceof Uint8Array ? tile.bytes : new Uint8Array(tile.bytes);
        if (raw.byteLength !== bytesPerTile) {
          console.warn('[Decal] raw tile size mismatch; skip tile', i);
          continue;
        }
      }
      kept.push(tile);
    }
    const pixelsOf = await runInFlight(kept.length, TILE_CODEC_IN_FLIGHT, (k) => {
      const tile = kept[k];
      if (tile.fmt === 'deflate') return inflateTile(tile.bytes, bytesPerTile);
      return tile.bytes instanceof Uint8Array ? tile.bytes : new Uint8Array(tile.bytes);
    });

    for (let k = 0; k < kept.length; k++) {
      const i = kept[k].i | 0;
      rgba.set(pixelsOf[k], i * bytesPerTile);
      Atomics.store(dirty, i, 1); // B-03: atomic, matching the stamp path
    }

    return { ok: true, restored: kept.length };
  }
}
