#!/usr/bin/env node
/**
 * Kernel: packInstancedRows + makePackContext + fillQueueIndices, the pixi
 * entity pack, on a 16k-row render queue built from the Predator fixture
 * (positions, rotations), painter order = foot-Y order, world space.
 *   - sprites: entity rows through the painter index list (Pixi entitiesBatch).
 *   - casters: caster rows with shadowCast (pre-render _packGpuSun).
 *
 *   node tests/bench/gpuQueuePackMicrobench.mjs
 *   node tests/bench/gpuQueuePackMicrobench.mjs --output out.json
 */
import {
  GPU_CASTER_FLOATS,
  GPU_SPACE_WORLD,
  GPU_SPRITE_FLOATS,
  fillQueueIndices,
  makePackContext,
  packInstancedRows,
} from '../../src/render/gpuQueueLayout.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

const PACK = { base: packInstancedRows };

export function buildQueue(fx, rows) {
  const { x, y, rotC, rotS, active, shadowH, shadowActive } = fx.arrays;
  const ids = [];
  for (let i = 0; i < fx.meta.n && ids.length < rows; i++) if (active[i]) ids.push(i);
  const n = ids.length;
  const rng = mulberry32(0x9ac4);
  const f32 = () => new Float32Array(n);
  const q = {
    count: n,
    x: f32(),
    y: f32(),
    scaleX: f32(),
    scaleY: f32(),
    rotC: f32(),
    rotS: f32(),
    alpha: f32(),
    tint: new Uint32Array(n),
    textureId: new Uint16Array(n),
    anchorX: f32(),
    anchorY: f32(),
    repeatX: f32(),
    repeatY: f32(),
    tileMulX: f32(),
    tileMulY: f32(),
    tileOffsetU: new Uint16Array(n),
    tileOffsetV: new Uint16Array(n),
    shadowH: f32(),
    shadowOffX: f32(),
    shadowOffY: f32(),
    type: new Uint8Array(n),
  };
  for (let r = 0; r < n; r++) {
    const i = ids[r];
    q.x[r] = x[i];
    q.y[r] = y[i];
    q.scaleX[r] = 0.8 + rng() * 0.4;
    q.scaleY[r] = q.scaleX[r];
    q.rotC[r] = rotC[i] || 1;
    q.rotS[r] = rotS[i] || 0;
    q.alpha[r] = rng() < 0.9 ? 1 : rng();
    q.tint[r] = 0xffffff;
    q.textureId[r] = (rng() * 400) | 0;
    q.anchorX[r] = 0.5;
    q.anchorY[r] = 1;
    q.shadowH[r] = shadowActive[i] ? shadowH[i] : 0;
    q.type[r] = 0;
  }
  // Painter order: foot-Y ascending (what radixPainterOrder hands Pixi).
  const order = Array.from({ length: n }, (_, r) => r).sort((a, b) => q.y[a] - q.y[b] || a - b);
  return { q, painter: Uint32Array.from(order) };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const pack = PACK[variant];
  if (!pack) throw new Error(`unknown variant ${variant}`);
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const rows = Number(args.rows ?? 16384);
  const { q, painter } = buildQueue(fx, rows);
  const n = q.count;

  const spriteDst = new Float32Array(n * GPU_SPRITE_FLOATS);
  const spriteU32 = new Uint32Array(spriteDst.buffer);
  const spriteOpts = { indices: painter, indexCount: n, space: GPU_SPACE_WORLD, zoom: 0.4, cameraX: 0, cameraY: 0, type: q.type };
  const spriteCtx = {};
  const packSprites = () => {
    const ctx = makePackContext(q, spriteOpts, n, spriteCtx);
    return pack(q, ctx, spriteDst, spriteU32, GPU_SPRITE_FLOATS, n, false);
  };

  const casterIdx = new Uint32Array(n);
  const casterDst = new Float32Array(n * GPU_CASTER_FLOATS);
  const casterU32 = new Uint32Array(casterDst.buffer);
  const casterCtx = {};
  const packCasters = () => {
    let m = 0;
    for (let r = 0; r < n; r++) if (q.shadowH[r] > 0) casterIdx[m++] = r;
    const ctx = makePackContext(q, { indices: casterIdx, indexCount: m, space: GPU_SPACE_WORLD, type: q.type }, n, casterCtx);
    return pack(q, ctx, casterDst, casterU32, GPU_CASTER_FLOATS, n, true);
  };

  const fillIdx = new Uint32Array(n);
  const sprites = packSprites();
  const casters = packCasters();
  const checksum =
    (Math.imul(checksumFloats(spriteDst, sprites * GPU_SPRITE_FLOATS), 16777619) ^
      checksumFloats(casterDst, casters * GPU_CASTER_FLOATS)) >>>
    0;

  const cases = {
    sprites: timeIt(`packInstancedRows ${variant} sprites (${sprites} rows)`, () => packSprites(), { iterations: 50, warmup: 50 }),
    casters: timeIt(`packInstancedRows ${variant} casters (${casters} rows)`, () => packCasters(), { iterations: 50, warmup: 50 }),
    fillQueueIndices: timeIt('fillQueueIndices exclude glow', () => fillQueueIndices(q.type, n, -1, 3, fillIdx), {
      iterations: 200,
      warmup: 50,
    }),
  };
  const report = {
    feature: 'gpu-queue-pack',
    functions: ['packInstancedRows', 'makePackContext', 'fillQueueIndices'],
    variant,
    n,
    seed: 0x9ac4,
    rows: { sprites, casters },
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify(report.rows), checksum);
}

if (isCli(import.meta.url)) await main();
