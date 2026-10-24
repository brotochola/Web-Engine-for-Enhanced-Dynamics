// E-76 W26, wired: the particle worker's decal stamping through decalStamp.wasm. stampParticleToTile writes each
// stamp as a record in the decal memory and flushDecalStamps stamps them in one call, then sets the dirty flags
// of the tiles it touched; the tiles and the flags must come out byte for byte as the shipped JS stamp leaves
// them, frame after frame, including a frame with more stamps than one flush holds and a texture the memory
// does not have (stamped in JS, after the records before it).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDecalMemory, installDecalMemory } from '../../src/util/decalMemory.js';
import { DECAL_MAX_STAMPS } from '../../src/util/wasmMemoryMap.js';
import { Decal } from '../../src/core/decal.js';
import { bloodTexture } from '../bench/decalStampWasmMicrobench.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

const WORLD_W = 1920;
const WORLD_H = 1080;
const TILE_SIZE = 256;
const RESOLUTION = 0.5;
const TILE_PIXELS = TILE_SIZE * RESOLUTION;
const TILES_X = Math.ceil(WORLD_W / TILE_SIZE);
const TILES_Y = Math.ceil(WORLD_H / TILE_SIZE);
const TOTAL_TILES = TILES_X * TILES_Y;
const BLOOD = 0;
const LOOSE = 7; // a texture the decal memory does not hold

async function bootWorker() {
  const blood = bloodTexture();
  const textures = { [BLOOD]: { width: blood.width, height: blood.height, rgba: blood.rgba.slice().buffer } };
  const m = createDecalMemory({ totalTiles: TOTAL_TILES, tilePixelSize: TILE_PIXELS, textures });
  assert.ok(m, 'the decal memory');
  const ring = Decal.createStampRingSab();
  const dirty = new SharedArrayBuffer(TOTAL_TILES);
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  const loose = { width: 5, height: 3, rgba: Uint8ClampedArray.from({ length: 60 }, (_, i) => (i * 37) & 255).buffer };
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
        tilesDirty: dirty,
        stampRing: ring,
        textures: { ...textures, [LOOSE]: loose },
        memory: m.memory,
        memoryLayout: m.layout,
      },
    },
  });
  return { worker, m };
}

/** A frame of stamps: float32 values (the ring's), doubles, both blends, edges and outside the world. */
function frameStamps(seed, n) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const f32 = rng() < 0.7;
    const num = (v) => (f32 ? Math.fround(v) : v);
    out.push([
      num((rng() * 1.1 - 0.05) * WORLD_W),
      num((rng() * 1.1 - 0.05) * WORLD_H),
      ((rng() * 0xffffff) | 0) >>> 0,
      num(0.3 + rng() * 2),
      num(0.3 + rng() * 2),
      rng() < 0.02 ? LOOSE : BLOOD,
      num(rng() < 0.05 ? 1 : 0.2 + rng() * 0.8),
      i % 3 === 0 ? 1 : 0,
    ]);
  }
  return out;
}

const FRAMES = [frameStamps(1, 300), frameStamps(2, DECAL_MAX_STAMPS + 500), frameStamps(3, 40)];

function run(worker, m, withKernel, kernel) {
  const tiles = new Uint8Array(m.buffer, 0, m.layout.tileBytes);
  const dirty = worker.decalsTilesDirty;
  tiles.fill(0);
  dirty.fill(0);
  worker._decalWasm = withKernel ? kernel : null;
  const shots = [];
  for (const stamps of FRAMES) {
    for (const s of stamps) worker.stampParticleToTile(...s);
    worker.flushDecalStamps();
    shots.push({ dirty: Array.from(dirty), tiles: Buffer.from(tiles).toString('base64') });
    dirty.fill(0); // as Pixi claims them
  }
  return shots;
}

test('the particle worker stamps decals through the kernel exactly as the JS does', async () => {
  const { worker, m } = await bootWorker();
  const kernel = worker._decalWasm;
  assert.ok(kernel, 'the worker bound decalStamp.wasm');
  assert.equal(worker.decalTextures[BLOOD].wasmByte, m.layout.textures[BLOOD].byte);
  assert.equal(worker.decalTextures[LOOSE].wasmByte, -1, 'a texture the memory does not hold');
  let calls = 0;
  const stampTiles = kernel.stampTiles;
  kernel.stampTiles = (...a) => {
    calls++;
    return stampTiles(...a);
  };
  const js = run(worker, m, false, kernel);
  const wasm = run(worker, m, true, kernel);
  assert.ok(calls > FRAMES.length, `the kernel ran, one call per flush (${calls})`);
  assert.ok(js.every((f) => f.dirty.some((d) => d === 1)), 'every frame dirtied tiles');
  for (let f = 0; f < FRAMES.length; f++) {
    assert.deepEqual(wasm[f].dirty, js[f].dirty, `frame ${f}: dirty flags`);
    assert.equal(wasm[f].tiles, js[f].tiles, `frame ${f}: tiles`);
  }
  assert.equal(kernel.count, 0, 'nothing left queued');
  worker._decalWasm = kernel;
});

test('installDecalMemory puts the tiles at byte 0 of the decal memory and binds the atlas there', () => {
  const blood = bloodTexture();
  const scene = {
    config: {
      particle: { decals: true, decalsTileSize: TILE_SIZE, decalsTilePixelSize: TILE_PIXELS },
      wasm: { decalStamp: true },
    },
    buffers: { decalsTilesRGBA: new SharedArrayBuffer(TOTAL_TILES * TILE_PIXELS * TILE_PIXELS * 4) },
    decalsTotalTiles: TOTAL_TILES,
    decalsTilesX: TILES_X,
    decalsTilesY: TILES_Y,
    decalTextureData: { [BLOOD]: { width: blood.width, height: blood.height, rgba: blood.rgba.slice().buffer } },
  };
  const m = installDecalMemory(scene);
  assert.ok(m);
  assert.equal(scene.decalMemory, m);
  assert.equal(scene.buffers.decalsTilesRGBA, m.memory.buffer);
  const t = m.layout.textures[BLOOD];
  assert.deepEqual(new Uint8Array(m.buffer, t.byte, blood.rgba.length), new Uint8Array(blood.rgba.buffer, blood.rgba.byteOffset, blood.rgba.length));
  assert.ok(m.layout.touchedByte >= m.layout.tileBytes, 'the scratch is after the tiles');

  const off = { ...scene, config: { ...scene.config, wasm: { decalStamp: false } }, buffers: { decalsTilesRGBA: new SharedArrayBuffer(16) } };
  assert.equal(installDecalMemory(off), null);
  assert.equal(off.decalMemory, null);
  Decal.bindAtlas(null);
});
