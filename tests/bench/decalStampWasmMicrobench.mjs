#!/usr/bin/env node
/**
 * Kernel (E-76 W26): the particle worker's decal stamping in WASM (wasm/decalStamp.c, src/workers/decalStamp.wasm)
 * against the JS stamp the engine shipped (Decal.stampToTileBuffers, now tests/reference/decalStamp.mjs), on the stamps
 * decalStampStressScene makes: DecalStampDriver's 768 seeded Decal.stamp calls a tick (blood.png, 32 × 32;
 * scale 0.4–2, alpha 0.4–1, a random tint, every third one multiply) on a 1920 × 1080 world, decalsTileSize
 * 256 at resolution 0.5: 8 × 5 tiles of 128 px.
 *
 *   js           the reference stamp, once per drained stamp, called as ParticleWorker.stampParticleToTile
 *                called it (the engine itself only stamps in WASM now), on a real particle worker's tiles
 *   wasm         the same worker with decalStamp.wasm bound: stampParticleToTile writes each drained stamp as
 *                a 64-byte record, flushDecalStamps stamps the frame's records in one call
 *   wasm-scalar  the same call with the kernel's scalar loop forced (the JS pixel loop line for line)
 *
 * The stamps reach the particle worker through the stamp ring, so x, y, scale and alpha arrive as float32:
 * the fixture passes each frame through Decal's ring once and keeps what the drain hands out, and both
 * sides stamp those numbers. The drain is the same JS on both sides and is not timed. The tiles (from byte
 * 0, as every worker views them), their dirty flags and the texture live in one shared WebAssembly.Memory;
 * the worker's views point there, so the JS and the kernel read and write the same bytes.
 *
 * One variant per process, through runKernelVariants.mjs, which rejects a variant whose checksum differs:
 * the dirty flags after each of 8 frames (cleared after each, as Pixi claims them) and the tiles after the
 * last, from clear tiles. --check runs only those frames and prints the checksum.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/decalStampWasmMicrobench.mjs --variants js,wasm,wasm-scalar --rounds 5
 *   node tests/bench/decalStampWasmMicrobench.mjs --variant wasm [--check] [--output path]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

import { Decal } from '../../src/core/decal.js';
import { stampToTileBuffers } from '../reference/decalStamp.mjs';
import { createDecalMemory } from '../../src/util/decalMemory.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { initWorker, loadWorker } from './workerHarness.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
export const KERNEL_URL = pathToFileURL(path.join(repoRoot, 'src/workers/decalStamp.wasm'));

/** decalStamp.c's table, slot for slot. */
export const DECAL_SLOTS = ['tiles', 'dirty', 'tilesX', 'tilesY', 'tilePixels', 'stamps', 'columns', 'columnsCap', 'flags'];
/** Table flag: every stamp through the kernel's scalar loop. */
export const F_SCALAR = 1;
/** decalStamp.c's Stamp: f64 x, y, scaleX, scaleY, alpha; u32 tint, blendMode, texture byte, width, height, pad. */
export const STAMP_BYTES = 64;

/** The column map's bytes for clips up to `cap` columns (decalStamp.c column_stride, two u32 arrays). */
export function columnBytes(cap) {
  return ((cap + 6) & ~3) * 4 * 2;
}

/**
 * RGBA bytes of an 8-bit, non-interlaced PNG (palette with tRNS, RGB or RGBA). The scene reads its
 * textures through a canvas, which can move a partly transparent texel's colour by a step; the file's
 * bytes are as good a texture for the stamp.
 */
export function decodePng(file) {
  const u8 = new Uint8Array(fs.readFileSync(file));
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette = null;
  let alphas = null;
  const idat = [];
  for (let pos = 8; pos < u8.length;) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const data = u8.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`${file}: only 8-bit, non-interlaced PNGs`);
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alphas = data;
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = { 2: 3, 3: 1, 6: 4 }[colorType];
  if (!bpp) throw new Error(`${file}: colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0;
      let v = raw[line + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + i] = v;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    if (colorType === 3) {
      const k = px[p];
      rgba.set(palette.subarray(k * 3, k * 3 + 3), p * 4);
      rgba[p * 4 + 3] = alphas && k < alphas.length ? alphas[k] : 255;
    } else if (colorType === 2) {
      rgba.set(px.subarray(p * 3, p * 3 + 3), p * 4);
      rgba[p * 4 + 3] = 255;
    } else {
      rgba.set(px.subarray(p * 4, p * 4 + 4), p * 4);
    }
  }
  return { width, height, rgba };
}

/** demos/img/blood.png, the scene's stamp. */
export function bloodTexture() {
  return decodePng(path.join(repoRoot, 'demos/img/blood.png'));
}

// decalStampStressScene's config and its DecalStampDriver.
const WORLD_W = 1920;
const WORLD_H = 1080;
const TILE_SIZE = 256;
const RESOLUTION = 0.5;
const TILE_PIXELS = Math.floor(TILE_SIZE * RESOLUTION); // Scene's decalsTilePixelSize
const TILES_X = Math.ceil(WORLD_W / TILE_SIZE);
const TILES_Y = Math.ceil(WORLD_H / TILE_SIZE);
const TOTAL_TILES = TILES_X * TILES_Y;
const STAMPS_PER_TICK = 768;
const SEED = 0xdec411;
const MULTIPLY = 1; // DECAL_STAMPS_BLEND_MODE.multiply
const BLOOD = 0; // its texture id
const FRAMES = 8;
const WARM_STAMPS = 8;

/**
 * Each frame's stamps as the particle worker drains them: DecalStampDriver.tick's Decal.stamp calls
 * (mulberry32 is the driver's _rng) enqueued on the stamp ring the way stamp() enqueues them, then drained.
 */
function drainedFrames(frames) {
  const n = frames * STAMPS_PER_TICK;
  const fx = {
    x: new Float64Array(n),
    y: new Float64Array(n),
    tint: new Float64Array(n),
    scaleX: new Float64Array(n),
    scaleY: new Float64Array(n),
    textureId: new Int32Array(n),
    alpha: new Float64Array(n),
    blendMode: new Int32Array(n),
  };
  const rng = mulberry32(SEED);
  let at = 0;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < STAMPS_PER_TICK; i++) {
      const x = rng() * WORLD_W;
      const y = rng() * WORLD_H;
      const scale = 0.4 + rng() * 1.6;
      const alpha = 0.4 + rng() * 0.6;
      const tint = ((rng() * 0xffffff) | 0) >>> 0;
      const blendMode = i % 3 === 0 ? MULTIPLY : 0;
      if (!Decal.enqueueStamp(x, y, BLOOD, scale, scale, tint, alpha, blendMode)) throw new Error('stamp ring full');
    }
    Decal.drainStampRing((x, y, tint, scaleX, scaleY, textureId, alpha, blendMode) => {
      fx.x[at] = x;
      fx.y[at] = y;
      fx.tint[at] = tint;
      fx.scaleX[at] = scaleX;
      fx.scaleY[at] = scaleY;
      fx.textureId[at] = textureId;
      fx.alpha[at] = alpha;
      fx.blendMode[at] = blendMode;
      at++;
    });
  }
  if (at !== n) throw new Error(`drained ${at} of ${n} stamps`);
  return fx;
}

export async function setupDecalKernel({ flags = 0 } = {}) {
  const blood = bloodTexture();
  const tileBytes = TOTAL_TILES * TILE_PIXELS * TILE_PIXELS * 4;
  const textures = { [BLOOD]: { width: blood.width, height: blood.height, rgba: blood.rgba.slice().buffer } };
  // The decal memory as the scene makes it (installDecalMemory): the tiles from byte 0, as every worker views
  // them, then the kernel's scratch and the texture.
  const m = createDecalMemory({ totalTiles: TOTAL_TILES, tilePixelSize: TILE_PIXELS, textures });
  if (!m) throw new Error('the decal memory does not fit');

  // The particle worker as the scene starts it, decals on: the ring, the atlas, its stamp apply and the kernel.
  const ring = Decal.createStampRingSab();
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await initWorker(worker, {
    config: {
      worldWidth: WORLD_W,
      worldHeight: WORLD_H,
      particle: { decals: true, decalsTileSize: TILE_SIZE, decalsResolution: RESOLUTION, decalsTilePixelSize: TILE_PIXELS },
      wasm: { decalStamp: true },
    },
    globalEntityCount: 16,
    buffers: { decalStampRing: ring, decalsTilesRGBA: m.buffer },
    extra: {
      decals: {
        enabled: true,
        tileSize: TILE_SIZE,
        tilePixelSize: TILE_PIXELS,
        resolution: RESOLUTION,
        tilesX: TILES_X,
        tilesY: TILES_Y,
        totalTiles: TOTAL_TILES,
        tilesRGBA: m.buffer,
        tilesDirty: new SharedArrayBuffer(TOTAL_TILES),
        stampRing: ring,
        textures,
        memory: m.memory,
        memoryLayout: m.layout,
      },
    },
  });
  const kernel = worker._decalWasm;
  if (!kernel) throw new Error('the worker did not bind decalStamp.wasm');
  kernel.table[DECAL_SLOTS.indexOf('flags')] = flags;

  const fx = drainedFrames(FRAMES);

  /**
   * The JS stamp the engine shipped (tests/reference/decalStamp.mjs), once per drained stamp, as
   * stampParticleToTile called it: the texture by id, one reused argument object.
   */
  const p = {
    worldX: 0, worldY: 0, tint: 0, scaleX: 1, scaleY: 1, alpha: 1, blendMode: 0,
    textureRgba: null, texWidth: 0, texHeight: 0,
    decalsTiles: worker.decalsTilesRGBA,
    decalsTilesDirty: worker.decalsTilesDirty,
    decalsTileSize: worker.decalsTileSize,
    decalsTilePixelSize: worker.decalsTilePixelSize,
    decalsTilesX: worker.decalsTilesX,
    decalsTilesY: worker.decalsTilesY,
    decalsResolution: worker.decalsResolution,
  };
  const stampFrameJs = (frame, count = STAMPS_PER_TICK) => {
    for (let k = frame * STAMPS_PER_TICK, end = k + count; k < end; k++) {
      const texture = worker.decalTextures[fx.textureId[k]];
      if (!texture) continue;
      p.worldX = fx.x[k];
      p.worldY = fx.y[k];
      p.tint = fx.tint[k];
      p.scaleX = fx.scaleX[k];
      p.scaleY = fx.scaleY[k];
      p.alpha = fx.alpha[k];
      p.blendMode = fx.blendMode[k];
      p.textureRgba = texture.rgba;
      p.texWidth = texture.width;
      p.texHeight = texture.height;
      stampToTileBuffers(p);
    }
    return 0;
  };
  /** The shipped path, once per drained stamp: a record, then the frame's flush. */
  const stampFrameWasm = (frame, count = STAMPS_PER_TICK) => {
    for (let k = frame * STAMPS_PER_TICK, end = k + count; k < end; k++) {
      worker.stampParticleToTile(fx.x[k], fx.y[k], fx.tint[k], fx.scaleX[k], fx.scaleY[k], fx.textureId[k], fx.alpha[k], fx.blendMode[k]);
    }
    return worker.flushDecalStamps();
  };

  const tiles = new Uint8Array(m.buffer, 0, tileBytes);
  const dirty = worker.decalsTilesDirty;
  /** From clear tiles: the dirty flags after each frame, then the tiles; and what stamp_tiles returned. */
  function checksumFrames(stampFrame) {
    tiles.fill(0);
    dirty.fill(0);
    let h = 2166136261;
    let stamped = 0;
    for (let f = 0; f < FRAMES; f++) {
      stamped += stampFrame(f);
      h = hashBytes(h, dirty);
      dirty.fill(0);
    }
    return { checksum: hashBytes(h, tiles), stamped };
  }

  // Stamps the kernel's vector loop takes (decalStamp.c: a float32 alpha in (0, 256/255)).
  let vectorStamps = 0;
  for (let k = 0; k < fx.alpha.length; k++) {
    const a = fx.alpha[k];
    if (a > 0 && a * 255 < 256 && Math.fround(a) === a) vectorStamps++;
  }
  return {
    worker, texture: blood, fx, stampFrameJs, stampFrameWasm, stampTiles: kernel.stampTiles, checksumFrames,
    vectorStamps: flags & F_SCALAR ? 0 : vectorStamps,
  };
}

function hashBytes(h, bytes) {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}

async function main() {
  const args = parseArgs();
  // The shipped path by default (the engine catalog runs it with no flags); js is the reference.
  const variant = String(args.variant || 'wasm');
  if (!['js', 'wasm', 'wasm-scalar'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const k = await setupDecalKernel({ flags: variant === 'wasm-scalar' ? F_SCALAR : 0 });
  const stampFrame = variant === 'js' ? k.stampFrameJs : k.stampFrameWasm;
  const { checksum, stamped } = k.checksumFrames(stampFrame);
  const stampsTotal = FRAMES * STAMPS_PER_TICK;
  const tail = variant === 'js' ? '' : ` tiles stamped ${stamped}, vector stamps ${k.vectorStamps}/${stampsTotal}`;
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} frames ${FRAMES} × ${STAMPS_PER_TICK} stamps${tail}`);
    return;
  }

  // Normal compiles, not OSR: short calls over the first stamps of frame 0.
  let tier = null;
  if (variant === 'js') warmNormalCompile(() => k.stampFrameJs(0, WARM_STAMPS));
  else tier = await warmWasm(k.stampTiles, () => k.stampFrameWasm(0, WARM_STAMPS));
  let next = 0;
  const run = () => stampFrame(next++ % FRAMES);
  const label = `decal stamp ${variant} (${STAMPS_PER_TICK} stamps, ${TILES_X}×${TILES_Y} tiles of ${TILE_PIXELS} px)`;
  const cases = { stamp: timeIt(label, run, { iterations: 20, warmup: 10 }) };
  const report = {
    feature: 'decal-stamp-wasm',
    variant,
    functions: ['stampToTileBuffers (tests/reference)', 'decalStamp.stamp_tiles'],
    stampsPerFrame: STAMPS_PER_TICK,
    frames: FRAMES,
    tiles: { x: TILES_X, y: TILES_Y, pixels: TILE_PIXELS },
    texture: { width: k.texture.width, height: k.texture.height },
    checksum,
    tilesStamped: variant === 'js' ? null : stamped,
    vectorStamps: variant === 'js' ? null : k.vectorStamps,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum}${tier ? ` tier ${tier}` : ''} stamp ${cases.stamp.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
