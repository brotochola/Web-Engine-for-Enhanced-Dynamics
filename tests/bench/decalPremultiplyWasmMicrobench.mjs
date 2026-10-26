#!/usr/bin/env node
/**
 * Kernel (E-76 W21c): Pixi's decal tile premultiply in WASM (wasm/decalPremultiply.c) against
 * the shipped copyPremultiplyRgba, on decalStampStressScene's tiles: the 40 tiles of 128 px that eight frames of
 * DecalStampDriver's stamps leave (decalStampWasmMicrobench's fixture), all of them premultiplied per op, as Pixi
 * does for each dirty tile.
 *
 *   js           copyPremultiplyRgba from the tile's view of the decal memory into the tile's own array, with the
 *                word views Pixi caches (E-107)
 *   wasm         premultiplyDecalTile (shipped): premultiply_simd from the tile into the memory's scratch tile,
 *                then the copy into the tile's own array (an upload from shared memory cost the other workers, E-123)
 *   wasm-scalar  the same with premultiply_scalar (the JS line for line)
 *
 * One variant per process, through runKernelVariants.mjs (it rejects a variant whose checksum differs: the bytes
 * every tile's own array holds after a premultiply).
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/decalPremultiplyWasmMicrobench.mjs --variants js,wasm,wasm-scalar --rounds 5
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { copyPremultiplyRgba } from '../reference/decalPremultiply.mjs';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { createDecalMemory } from '../../src/util/decalMemory.js';
import { bindDecalPremultiply, premultiplyDecalTile } from '../../src/render/decalPremultiplyClient.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { quietly } from './workerHarness.mjs';
import { setupDecalKernel } from './decalStampWasmMicrobench.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const KERNEL_URL = pathToFileURL(path.join(repoRoot, 'src/wasm/engine.wasm'));
const TILE_PIXELS = 128;
const TILE_BYTES = TILE_PIXELS * TILE_PIXELS * 4;

export async function setupPremultiplyKernel() {
  // The scene's tiles after eight frames of its stamps (the shipped stamp, from clear tiles).
  const stamp = await quietly(() => setupDecalKernel());
  stamp.checksumFrames(stamp.stampFrameJs);
  const stamped = new Uint8Array(stamp.worker.decalsTilesRGBA.buffer, 0, stamp.worker.decalsTilesRGBA.length);
  const tiles = stamped.length / TILE_BYTES;

  // The decal memory as the scene makes it, those tiles from byte 0, and Pixi's binding of the kernel on it.
  const m = createDecalMemory({ totalTiles: tiles, tilePixelSize: TILE_PIXELS, textures: null });
  const memory = m.memory;
  const buffer = memory.buffer;
  new Uint8Array(buffer, 0, stamped.length).set(stamped);
  const bound = await bindDecalPremultiply(memory, m.layout);
  const k = await loadWasmKernel('decalPremultiply', KERNEL_URL, memory, ['premultiply_scalar', 'premultiply_simd']);
  const scratchByte = m.layout.premultipliedByte;
  const scratch = new Uint8ClampedArray(buffer, scratchByte, TILE_BYTES);

  // Pixi's per-tile state: the view of the tile in the memory and the tile's own array, with their word views.
  const shared = [];
  const own = [];
  const sharedWords = [];
  const ownWords = [];
  for (let t = 0; t < tiles; t++) {
    shared.push(new Uint8ClampedArray(buffer, t * TILE_BYTES, TILE_BYTES));
    own.push(new Uint8ClampedArray(TILE_BYTES));
    sharedWords.push(new Uint32Array(buffer, t * TILE_BYTES, TILE_BYTES >> 2));
    ownWords.push(new Uint32Array(own[t].buffer));
  }
  const runJs = (n = tiles) => {
    for (let t = 0; t < n; t++) copyPremultiplyRgba(own[t], shared[t], ownWords[t], sharedWords[t]);
    return n;
  };
  const runWith = (fn) => (n = tiles) => {
    for (let t = 0; t < n; t++) {
      fn(t * TILE_BYTES, scratchByte, TILE_PIXELS * TILE_PIXELS);
      own[t].set(scratch);
    }
    return n;
  };
  const hash = () => {
    let h = 2166136261;
    for (const a of own) for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) >>> 0;
    return h;
  };
  let partial = 0;
  for (let i = 3; i < stamped.length; i += 4) if (stamped[i] !== 0 && stamped[i] !== 255) partial++;
  // wasm: the shipped path (premultiplyDecalTile, as Pixi's dirty-tile sweep calls it).
  const runShipped = (n = tiles) => {
    for (let t = 0; t < n; t++) premultiplyDecalTile(bound, t, own[t]);
    return n;
  };
  return { tiles, runJs, runSimd: runShipped, runScalar: runWith(k.premultiply_scalar), k: { ...k, premultiply_simd: bound.premultiply }, hash, partial };
}

async function main() {
  const args = parseArgs();
  // The shipped path by default (the engine catalog runs it with no flags); js is the reference.
  const variant = String(args.variant || 'wasm');
  if (!['js', 'wasm', 'wasm-scalar'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const s = await setupPremultiplyKernel();
  const run = variant === 'js' ? s.runJs : variant === 'wasm' ? s.runSimd : s.runScalar;
  run();
  const checksum = s.hash();
  let tier = null;
  if (variant === 'js') warmNormalCompile(() => run(1));
  else tier = await warmWasm(variant === 'wasm' ? s.k.premultiply_simd : s.k.premultiply_scalar, () => run(1));
  const cases = {
    premultiply: timeIt(`decal premultiply ${variant} (${s.tiles} tiles of ${TILE_PIXELS} px)`, () => run(), { iterations: 20, warmup: 5 }),
  };
  const report = {
    feature: 'decal-premultiply-wasm',
    variant,
    functions: ['copyPremultiplyRgba', 'decalPremultiply.premultiply_simd', 'decalPremultiply.premultiply_scalar'],
    n: s.tiles,
    seed: 0xdec411,
    partialAlphaPixels: s.partial,
    checksum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum}${tier ? ` tier ${tier}` : ''} premultiply ${cases.premultiply.opsPerSec.toFixed(1)} ops/s (${s.partial} partial-alpha pixels)`);
}

if (isCli(import.meta.url)) await main();
