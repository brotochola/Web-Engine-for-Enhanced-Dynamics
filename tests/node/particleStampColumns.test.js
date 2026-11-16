// E-336: stampCollectedParticles writes each particle's W26 record straight from its columns instead of passing five
// doubles to stampParticleToTile. The tiles, the dirty flags, the particles returned to the pool and the one warning for
// a texture the decal memory left out must come out as stampParticleToTile per particle left them, including a frame
// with more stamps than one flush holds and particles whose texture has no decal at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDecalMemory } from '../../src/util/decalMemory.js';
import { DECAL_MAX_STAMPS } from '../../src/util/wasmMemoryMap.js';
import { Decal } from '../../src/core/decal.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
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
const NONE = 9; // no decal texture at all
const N = DECAL_MAX_STAMPS + 700;

async function bootWorker() {
  const blood = bloodTexture();
  const textures = { [BLOOD]: { width: blood.width, height: blood.height, rgba: blood.rgba.slice().buffer } };
  const m = createDecalMemory({ totalTiles: TOTAL_TILES, tilePixelSize: TILE_PIXELS, textures });
  const ring = Decal.createStampRingSab();
  const dirty = new SharedArrayBuffer(TOTAL_TILES);
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  const loose = { width: 5, height: 3, rgba: Uint8ClampedArray.from({ length: 60 }, (_, i) => (i * 37) & 255).buffer };
  await initWorker(worker, {
    config: {
      worldWidth: WORLD_W,
      worldHeight: WORLD_H,
      particle: { decals: true, decalsTileSize: TILE_SIZE, decalsResolution: RESOLUTION, decalsTilePixelSize: TILE_PIXELS },
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

/** Particle columns for N particles (float32 like the pool's), and the stamp list in a shuffled order. */
function fillParticles() {
  ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(N)), N);
  const rng = mulberry32(336);
  for (let p = 0; p < N; p++) {
    ParticleComponent.x[p] = (rng() * 1.1 - 0.05) * WORLD_W;
    ParticleComponent.y[p] = (rng() * 1.1 - 0.05) * WORLD_H;
    ParticleComponent.baseTint[p] = ((rng() * 0xffffff) | 0) >>> 0;
    ParticleComponent.scaleX[p] = 0.3 + rng() * 2;
    ParticleComponent.scaleY[p] = 0.3 + rng() * 2;
    const r = rng();
    ParticleComponent.textureId[p] = r < 0.02 ? LOOSE : r < 0.04 ? NONE : BLOOD;
    ParticleComponent.alpha[p] = rng() < 0.05 ? 1 : 0.2 + rng() * 0.8;
    ParticleComponent.blendMode[p] = p % 3 === 0 ? 1 : 0;
  }
  const list = new Uint16Array(N);
  for (let i = 0; i < N; i++) list[i] = (i * 7919) % N;
  return list;
}

function capture(fn) {
  const returned = [];
  const warnings = [];
  const returnToPool = ParticleEmitter.returnToPool;
  const warn = console.warn;
  ParticleEmitter.returnToPool = (index) => returned.push(index);
  console.warn = (msg) => warnings.push(String(msg));
  try {
    fn();
  } finally {
    ParticleEmitter.returnToPool = returnToPool;
    console.warn = warn;
  }
  return { returned, warnings };
}

function shot(worker, m) {
  return {
    dirty: Array.from(worker.decalsTilesDirty),
    tiles: Buffer.from(new Uint8Array(m.buffer, 0, m.layout.tileBytes)).toString('base64'),
  };
}

function clear(worker, m) {
  new Uint8Array(m.buffer, 0, m.layout.tileBytes).fill(0);
  worker.decalsTilesDirty.fill(0);
  worker._decalTexturesMissing.clear();
}

test('stampCollectedParticles stamps from the columns exactly as stampParticleToTile per particle did', async () => {
  const { worker, m } = await bootWorker();
  assert.ok(worker._decalWasm, 'the worker bound decalStamp.wasm');
  assert.ok(worker.particlesToStamp instanceof Uint16Array, 'the stamp list starts as an empty typed array');
  const list = fillParticles();

  clear(worker, m);
  const before = capture(() => {
    for (let i = 0; i < N; i++) {
      const p = list[i];
      worker.stampParticleToTile(
        ParticleComponent.x[p], ParticleComponent.y[p], ParticleComponent.baseTint[p], ParticleComponent.scaleX[p],
        ParticleComponent.scaleY[p], ParticleComponent.textureId[p], ParticleComponent.alpha[p], ParticleComponent.blendMode[p],
      );
      ParticleEmitter.returnToPool(p);
    }
    worker.flushDecalStamps();
  });
  const expected = shot(worker, m);

  clear(worker, m);
  worker.particlesToStamp = list;
  worker.particlesToStampCount = N;
  const now = capture(() => {
    worker.stampCollectedParticles();
    worker.flushDecalStamps();
  });
  const got = shot(worker, m);

  assert.ok(expected.dirty.some((d) => d === 1), 'the frame dirtied tiles');
  assert.deepEqual(got.dirty, expected.dirty, 'dirty flags');
  assert.equal(got.tiles, expected.tiles, 'tiles');
  assert.deepEqual(now.returned, Array.from(list), 'every particle back to the pool, in order');
  assert.deepEqual(now.warnings, before.warnings, 'the loose texture warned once, as before');
  assert.equal(now.warnings.length, 1);
  assert.equal(worker.particlesStampedThisFrame, N);
  assert.equal(worker._decalWasm.count, 0, 'nothing left queued');
});

test('with decals off, the collected particles go back to the pool and nothing stamps', async () => {
  const { worker, m } = await bootWorker();
  const list = fillParticles();
  clear(worker, m);
  worker.decalsEnabled = false;
  worker.particlesToStamp = list;
  worker.particlesToStampCount = 50;
  const { returned } = capture(() => worker.stampCollectedParticles());
  assert.deepEqual(returned, Array.from(list.subarray(0, 50)));
  assert.equal(worker._decalWasm.count, 0, 'no record queued');
  assert.equal(worker.particlesStampedThisFrame, 0);
});
