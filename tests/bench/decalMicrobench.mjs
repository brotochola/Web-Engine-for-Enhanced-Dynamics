// decal-microbench.mjs - Microbenchmark + correctness check for blood decal
// stamping (L1 isolated, no workers).
//
// Sets up a small fake tile atlas + a handful of fake textures (dense/sparse/
// solid alpha), then:
//   1. Verifies stampParticleToTileBuffers against an independent nearest-
//      neighbor + blend reference (reuses the tile-bounds/clip geometry
//      helpers, but reimplements the sampling + blend math from scratch so
//      future hot-loop patches (D1/D2 hyps) are still caught).
//   2. Times normal/multiply blend across single-tile, multi-tile, and
//      sparse-alpha scenarios.
//
// Usage:
//   node tests/bench/decal-microbench.mjs
//   node tests/bench/decal-microbench.mjs --stamps 5000 --seed 12648430 --output tests/results/decal-micro.json

import { stampParticleToTileBuffers } from '../../src/core/decalStamp.js';
import {
  calculateDecalTileBounds,
  calculateTileClipRegion,
} from '../../src/core/utils.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const args = parseArgs();
const STAMPS = Number(args.stamps ?? 5000);
const SEED = Number(args.seed ?? 0xc0ffee);
const OUTPUT = args.output ? String(args.output) : null;
const CORRECTNESS_STAMPS = 400;

// ---------------------------------------------------------------------------
// Fake blood tile atlas
// ---------------------------------------------------------------------------
const TILES_X = 4;
const TILES_Y = 4;
const TILE_PIXEL_SIZE = 64;
const TILE_SIZE_WORLD = 128;
const RESOLUTION = 0.5; // tilePixelSize / tileSize, matches Scene.js decalsTilePixelSize derivation
const WORLD_W = TILES_X * TILE_SIZE_WORLD;
const WORLD_H = TILES_Y * TILE_SIZE_WORLD;
const MARGIN = 32;

function makeTiles() {
  const bytes = TILES_X * TILES_Y * TILE_PIXEL_SIZE * TILE_PIXEL_SIZE * 4;
  return {
    rgba: new Uint8ClampedArray(bytes),
    dirty: new Uint8Array(TILES_X * TILES_Y),
  };
}

function tilesChecksum(tiles) {
  let sum = 0;
  const rgba = tiles.rgba;
  for (let i = 0; i < rgba.length; i++) sum += rgba[i];
  return sum;
}

// ---------------------------------------------------------------------------
// Fake textures
// ---------------------------------------------------------------------------
function makeDenseTexture(size, seedOffset) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const rng = mulberry32((SEED ^ seedOffset) >>> 0);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 40 + ((rng() * 180) | 0);
    rgba[i * 4 + 1] = 40 + ((rng() * 180) | 0);
    rgba[i * 4 + 2] = 40 + ((rng() * 180) | 0);
    rgba[i * 4 + 3] = 200; // dense: alpha 200 everywhere
  }
  return { rgba, width: size, height: size };
}

function makeSparseTexture(size, seedOffset) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const rng = mulberry32((SEED ^ seedOffset) >>> 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const checker = ((x >> 2) + (y >> 2)) % 2 === 0;
      rgba[i * 4] = 40 + ((rng() * 180) | 0);
      rgba[i * 4 + 1] = 40 + ((rng() * 180) | 0);
      rgba[i * 4 + 2] = 40 + ((rng() * 180) | 0);
      rgba[i * 4 + 3] = checker ? 200 : 0; // sparse: checker alpha 0/200
    }
  }
  return { rgba, width: size, height: size };
}

function makeSolidTexture(size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 180;
    rgba[i * 4 + 1] = 30;
    rgba[i * 4 + 2] = 30;
    rgba[i * 4 + 3] = 255; // solid opaque
  }
  return { rgba, width: size, height: size };
}

const texDense16 = makeDenseTexture(16, 0x1111);
const texDense32 = makeDenseTexture(32, 0x2222);
const texSparse16 = makeSparseTexture(16, 0x3333);
const texSolid16 = makeSolidTexture(16);

// ---------------------------------------------------------------------------
// Deterministic stamp parameter pools (cycled with modulo, like ray-microbench)
// ---------------------------------------------------------------------------
const POOL_SIZE = 2048;

function makeStampPool(rng, { texture, scaleRange, blendMode }) {
  const xs = new Float32Array(POOL_SIZE);
  const ys = new Float32Array(POOL_SIZE);
  const tints = new Uint32Array(POOL_SIZE);
  const scales = new Float32Array(POOL_SIZE);
  const alphas = new Float32Array(POOL_SIZE);
  for (let i = 0; i < POOL_SIZE; i++) {
    xs[i] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
    ys[i] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
    tints[i] = ((rng() * 0xffffff) | 0) >>> 0;
    scales[i] = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
    alphas[i] = 120 + ((rng() * 135) | 0);
  }
  return { xs, ys, tints, scales, alphas, texture, blendMode };
}

const rngPools = mulberry32((SEED ^ 0xabc123) >>> 0);
const pools = {
  normal_1tile_dense: makeStampPool(rngPools, { texture: texDense16, scaleRange: [0.5, 1.5], blendMode: 0 }),
  multiply_1tile_dense: makeStampPool(rngPools, { texture: texDense16, scaleRange: [0.5, 1.5], blendMode: 1 }),
  normal_multitile_large: makeStampPool(rngPools, { texture: texDense32, scaleRange: [4, 8], blendMode: 0 }),
  normal_sparse: makeStampPool(rngPools, { texture: texSparse16, scaleRange: [1, 3], blendMode: 0 }),
  multiply_sparse: makeStampPool(rngPools, { texture: texSparse16, scaleRange: [1, 3], blendMode: 1 }),
};

function paramsFromPool(pool, idx) {
  const k = idx % POOL_SIZE;
  return {
    worldX: pool.xs[k],
    worldY: pool.ys[k],
    tint: pool.tints[k],
    scaleX: pool.scales[k],
    scaleY: pool.scales[k],
    alpha: pool.alphas[k],
    blendMode: pool.blendMode,
    textureRgba: pool.texture.rgba,
    texWidth: pool.texture.width,
    texHeight: pool.texture.height,
  };
}

function stampFromPool(tiles, pool, idx) {
  const p = paramsFromPool(pool, idx);
  stampParticleToTileBuffers({
    ...p,
    decalsTiles: tiles.rgba,
    decalsTilesDirty: tiles.dirty,
    decalsTileSize: TILE_SIZE_WORLD,
    decalsTilePixelSize: TILE_PIXEL_SIZE,
    decalsTilesX: TILES_X,
    decalsTilesY: TILES_Y,
    decalsResolution: RESOLUTION,
  });
}

// ---------------------------------------------------------------------------
// CORRECTNESS: independent nearest-neighbor + blend reference.
//
// Reuses the tile-bounds/clip geometry helpers (pure math, not part of the
// per-pixel hot loop hyps target) but reimplements sampling + blending from
// scratch in a plain nested loop (no cached row offsets) so this still
// catches regressions introduced by future D1/D2 hot-loop patches.
// ---------------------------------------------------------------------------
const refBoundsScratch = { minTileX: 0, maxTileX: 0, minTileY: 0, maxTileY: 0, valid: false };
const refClipScratch = {
  dstStartX: 0,
  dstStartY: 0,
  dstEndX: 0,
  dstEndY: 0,
  srcOffsetX: 0,
  srcOffsetY: 0,
  uvScaleX: 1,
  uvScaleY: 1,
  valid: false,
};

function blendNormalPixel(decalsTiles, dstOffset, srcR, srcG, srcB, texAlpha, alpha, tintR, tintG, tintB) {
  const srcA = (texAlpha * alpha) | 0;
  if (srcA < 1) return;
  const mixedR = (srcR * tintR + 127) >> 8;
  const mixedG = (srcG * tintG + 127) >> 8;
  const mixedB = (srcB * tintB + 127) >> 8;
  const keep = 255 - srcA;
  const dstR = decalsTiles[dstOffset];
  const dstG = decalsTiles[dstOffset + 1];
  const dstB = decalsTiles[dstOffset + 2];
  const dstA = decalsTiles[dstOffset + 3];
  decalsTiles[dstOffset] = dstR + (((mixedR - dstR) * srcA + 127) >> 8);
  decalsTiles[dstOffset + 1] = dstG + (((mixedG - dstG) * srcA + 127) >> 8);
  decalsTiles[dstOffset + 2] = dstB + (((mixedB - dstB) * srcA + 127) >> 8);
  decalsTiles[dstOffset + 3] = srcA + ((dstA * keep + 127) >> 8);
}

function blendMultiplyPixel(decalsTiles, dstOffset, srcR, srcG, srcB, texAlpha, alpha, tintR, tintG, tintB) {
  const mixedR = (srcR * tintR + 127) >> 8;
  const mixedG = (srcG * tintG + 127) >> 8;
  const mixedB = (srcB * tintB + 127) >> 8;
  const luminance = (mixedR * 77 + mixedG * 150 + mixedB * 29) >> 8;
  const darkness = 255 - luminance;
  const effAlpha = (((texAlpha * darkness) >> 8) * alpha) | 0;
  if (effAlpha < 2) return;
  const keep = 255 - effAlpha;
  const dstR = decalsTiles[dstOffset];
  const dstG = decalsTiles[dstOffset + 1];
  const dstB = decalsTiles[dstOffset + 2];
  const dstA = decalsTiles[dstOffset + 3];
  decalsTiles[dstOffset] = (dstR * keep + 127) >> 8;
  decalsTiles[dstOffset + 1] = (dstG * keep + 127) >> 8;
  decalsTiles[dstOffset + 2] = (dstB * keep + 127) >> 8;
  decalsTiles[dstOffset + 3] = effAlpha + ((dstA * keep + 127) >> 8);
}

function referenceStamp(tiles, p) {
  const { worldX, worldY, tint, scaleX, scaleY, alpha, blendMode, textureRgba, texWidth, texHeight } = p;

  const scaledWidthWorld = texWidth * scaleX;
  const scaledHeightWorld = texHeight * scaleY;
  const halfWidthWorld = scaledWidthWorld / 2;
  const halfHeightWorld = scaledHeightWorld / 2;
  const scaledWidthPixels = (scaledWidthWorld * RESOLUTION + 0.999) | 0;
  const scaledHeightPixels = (scaledHeightWorld * RESOLUTION + 0.999) | 0;
  const invScaledWidth = texWidth / scaledWidthPixels;
  const invScaledHeight = texHeight / scaledHeightPixels;

  calculateDecalTileBounds(worldX, worldY, halfWidthWorld, halfHeightWorld, TILE_SIZE_WORLD, TILES_X, TILES_Y, refBoundsScratch);
  if (!refBoundsScratch.valid) return;

  const tintR = (tint >> 16) & 0xff;
  const tintG = (tint >> 8) & 0xff;
  const tintB = tint & 0xff;

  for (let ty = refBoundsScratch.minTileY; ty <= refBoundsScratch.maxTileY; ty++) {
    for (let tx = refBoundsScratch.minTileX; tx <= refBoundsScratch.maxTileX; tx++) {
      calculateTileClipRegion(
        worldX,
        worldY,
        halfWidthWorld,
        halfHeightWorld,
        tx,
        ty,
        TILE_SIZE_WORLD,
        TILE_PIXEL_SIZE,
        texWidth,
        texHeight,
        scaledWidthPixels,
        scaledHeightPixels,
        refClipScratch
      );
      if (!refClipScratch.valid) continue;

      const tileIndex = tx + ty * TILES_X;
      const tileByteOffset = tileIndex * TILE_PIXEL_SIZE * TILE_PIXEL_SIZE * 4;

      // Plain nested loop: recompute every offset per pixel, no row caching.
      for (let dstY = refClipScratch.dstStartY; dstY < refClipScratch.dstEndY; dstY++) {
        for (let dstX = refClipScratch.dstStartX; dstX < refClipScratch.dstEndX; dstX++) {
          const srcScaledX = refClipScratch.srcOffsetX + (dstX - refClipScratch.dstStartX) * refClipScratch.uvScaleX;
          const srcScaledY = refClipScratch.srcOffsetY + (dstY - refClipScratch.dstStartY) * refClipScratch.uvScaleY;
          const srcX = (srcScaledX * invScaledWidth) | 0;
          const srcY = (srcScaledY * invScaledHeight) | 0;
          if (srcX < 0 || srcX >= texWidth || srcY < 0 || srcY >= texHeight) continue;

          const srcOffset = (srcY * texWidth + srcX) * 4;
          const texAlpha = textureRgba[srcOffset + 3];
          if (texAlpha < 1) continue;

          const srcR = textureRgba[srcOffset];
          const srcG = textureRgba[srcOffset + 1];
          const srcB = textureRgba[srcOffset + 2];
          const dstOffset = tileByteOffset + dstY * TILE_PIXEL_SIZE * 4 + dstX * 4;

          if (blendMode === 1) {
            blendMultiplyPixel(tiles.rgba, dstOffset, srcR, srcG, srcB, texAlpha, alpha, tintR, tintG, tintB);
          } else {
            blendNormalPixel(tiles.rgba, dstOffset, srcR, srcG, srcB, texAlpha, alpha, tintR, tintG, tintB);
          }
        }
      }

      tiles.dirty[tileIndex] = 1;
    }
  }
}

function runCorrectnessCheck() {
  const actualTiles = makeTiles();
  const referenceTiles = makeTiles();

  const caseNames = Object.keys(pools);
  const solidPool = makeStampPool(mulberry32((SEED ^ 0x9999) >>> 0), {
    texture: texSolid16,
    scaleRange: [1, 8],
    blendMode: 0,
  });

  let mismatches = 0;
  for (let i = 0; i < CORRECTNESS_STAMPS; i++) {
    // Mix all named pools + the solid-opaque pool for extra coverage.
    const useSolid = i % 5 === 4;
    const pool = useSolid ? solidPool : pools[caseNames[i % caseNames.length]];
    const params = paramsFromPool(pool, i);

    stampParticleToTileBuffers({
      ...params,
      decalsTiles: actualTiles.rgba,
      decalsTilesDirty: actualTiles.dirty,
      decalsTileSize: TILE_SIZE_WORLD,
      decalsTilePixelSize: TILE_PIXEL_SIZE,
      decalsTilesX: TILES_X,
      decalsTilesY: TILES_Y,
      decalsResolution: RESOLUTION,
    });
    referenceStamp(referenceTiles, params);
  }

  const actualBytes = actualTiles.rgba;
  const refBytes = referenceTiles.rgba;
  for (let i = 0; i < actualBytes.length; i++) {
    if (actualBytes[i] !== refBytes[i]) {
      mismatches++;
      if (mismatches <= 5) {
        console.error(`MISMATCH byte ${i}: actual=${actualBytes[i]} reference=${refBytes[i]}`);
      }
    }
  }

  const actualSum = tilesChecksum(actualTiles);
  const refSum = tilesChecksum(referenceTiles);

  return { mismatches, actualSum, refSum };
}

const { mismatches, actualSum, refSum } = runCorrectnessCheck();
if (mismatches > 0) {
  console.error(`CORRECTNESS: FAILED (${mismatches} byte mismatches over ${CORRECTNESS_STAMPS} stamps)`);
  process.exit(1);
}
console.log(`CORRECTNESS: OK (${CORRECTNESS_STAMPS} stamps match reference, checksum=${actualSum})`);
console.log(`config: tilesX=${TILES_X} tilesY=${TILES_Y} tilePixelSize=${TILE_PIXEL_SIZE} tileSizeWorld=${TILE_SIZE_WORLD} resolution=${RESOLUTION} stamps=${STAMPS} seed=${SEED}`);

// ---------------------------------------------------------------------------
// TIMED CASES
// ---------------------------------------------------------------------------
// Multi-tile stamps touch far more pixels per call than single-tile ones —
// scale iteration count down so the case pyramid finishes in a reasonable time.
const CASE_ITERATION_SCALE = {
  normal_multitile_large: 0.1,
};

const cases = {};
for (const [name, pool] of Object.entries(pools)) {
  const tiles = makeTiles();
  let cursor = 0;
  const iterations = Math.max(200, Math.round(STAMPS * (CASE_ITERATION_SCALE[name] ?? 1)));
  cases[name] = timeIt(
    name,
    (iters) => {
      for (let i = 0; i < iters; i++) {
        stampFromPool(tiles, pool, cursor++);
      }
    },
    { iterations }
  );
}

if (OUTPUT) {
  const caseSummary = {};
  for (const [key, result] of Object.entries(cases)) {
    caseSummary[key] = {
      ms: result.ms,
      opsPerSec: result.opsPerSec,
      iterations: result.iterations,
    };
  }
  writeReport(OUTPUT, {
    feature: 'decal',
    layer: 'L1',
    seed: SEED,
    stamps: STAMPS,
    tilesX: TILES_X,
    tilesY: TILES_Y,
    tilePixelSize: TILE_PIXEL_SIZE,
    tileSizeWorld: TILE_SIZE_WORLD,
    resolution: RESOLUTION,
    correctnessStamps: CORRECTNESS_STAMPS,
    checksumOk: mismatches === 0,
    referenceChecksum: refSum,
    actualChecksum: actualSum,
    cases: caseSummary,
  });
}
