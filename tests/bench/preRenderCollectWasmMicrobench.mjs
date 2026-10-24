#!/usr/bin/env node
/**
 * Kernel (E-76 W4b): pre-render's sprite collect in WASM (wasm/preRenderCollect.c) against the JS loop of the
 * shipped PreRenderWorker.collectVisibleEntities, on a real worker, 250 000 sprites with no body in a scene
 * without physics, every column in one shared memory (preRenderCollectKernel.mjs).
 *
 *   bunny   BunnyMark: skipCull, every sprite queued, the sprite query's list (copied into the memory)
 *   cull    a straight camera at zoom 0.5 over a world five times the view: about a fifth queued
 *   turned  the same camera turned 0.4 rad (E-51's copy of the loop)
 *
 *   js    the shipped collectVisibleEntities with no kernel bound (its JS loop)
 *   wasm  the same with the kernel bound (_collectVisibleEntitiesWasm)
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/preRenderCollectWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/preRenderCollectWasmMicrobench.mjs --variant wasm [--scale 0.1] [--output path]
 */
import { Query } from '../../src/core/query.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker, quietly } from './workerHarness.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { bindCollect, collectMemory } from './preRenderCollectKernel.mjs';

const ARGS = parseArgs();
const SCALE = Number(ARGS.scale ?? 1);
const N = Math.max(1024, Math.round(250000 * SCALE));

const CASES = {
  bunny: { skipCull: true, rot: 0, zoom: 1, world: 1, list: true },
  cull: { skipCull: false, rot: 0, zoom: 0.5, world: 5, list: false },
  turned: { skipCull: false, rot: 0.4, zoom: 0.5, world: 5, list: false },
};

export async function setupCollectKernel(caseName, seed = 0xb0b) {
  const c = CASES[caseName];
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const m = collectMemory(pre, N, N);
  const v = m.views;
  const rng = mulberry32(seed);
  const w = 1920 * c.world;
  const h = 1080 * c.world;
  for (let i = 0; i < N; i++) {
    v.tActive[i] = 1;
    v.x[i] = 8 + rng() * (w - 16);
    v.y[i] = 8 + rng() * (h - 16);
    v.rotC[i] = 1;
    v.rotS[i] = 0;
    v.sActive[i] = 1;
    v.sVisible[i] = 1;
    v.halfW[i] = 13;
    v.halfH[i] = 18.5;
    v.sheet[i] = 1;
    v.anchorX[i] = 0.5;
    v.anchorY[i] = 0.5;
  }
  pre.cameraData = {};
  pre._querySpriteRenderer = null;
  pre.canvasWidth = 1920;
  pre.canvasHeight = 1080;
  pre.cullingRatio = 0.05;
  pre.skipCull = c.skipCull;
  pre._frameCameraZoom = c.zoom;
  pre._frameCameraX = w / 2;
  pre._frameCameraY = h / 2;
  pre._frameCameraRot = c.rot;
  pre.renderQueueEnabled = true;
  pre._entitySortY = false;
  pre._collectEntityGlow = () => {};
  pre._poseX = null;
  pre._rbActive = null;
  // BunnyMark's sprite query lists every bunny (32-bit ids past 65 535); the other cases scan every index.
  const ids = Uint32Array.from({ length: N }, (_, i) => i);
  let listLength = N;
  Query.queryActiveEntities = () => (c.list ? ids.subarray(0, listLength) : null);
  const k = await bindCollect(m);

  /** One collect of the first `items` entities into an empty collector. */
  const sized = (items, fn) => {
    pre._renderableCount = 0;
    pre.visibleEntitiesCount = 0;
    listLength = items;
    pre.globalEntityCount = items;
    fn();
    pre.globalEntityCount = N;
    listLength = N;
    return pre._renderableCount;
  };
  const js = (items = N) => sized(items, () => { pre._collectWasm = null; pre.collectVisibleEntities(); });
  const wasm = (items = N) => sized(items, () => { pre._collectWasm = k; pre.collectVisibleEntities(); });
  const hash = () => {
    let x = 2166136261;
    const n = pre._renderableCount;
    for (const a of [v.oY, v.oType, v.oIndex, v.oX, v.oPy, v.oRc, v.oRs]) {
      const bytes = new Uint8Array(a.buffer, a.byteOffset, n * a.BYTES_PER_ELEMENT);
      for (let i = 0; i < bytes.length; i++) x = Math.imul(x ^ bytes[i], 16777619) >>> 0;
    }
    return Math.imul(x ^ pre.visibleEntitiesCount, 16777619) >>> 0;
  };
  return { pre, k, js, wasm, hash };
}

async function main() {
  const variant = String(ARGS.variant || 'js');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const cases = {};
  let checksum = 2166136261;
  let tier = null;
  for (const name of Object.keys(CASES)) {
    const s = await quietly(() => setupCollectKernel(name));
    const run = variant === 'wasm' ? s.wasm : s.js;
    const queued = run();
    checksum = Math.imul(checksum ^ s.hash(), 16777619) >>> 0;
    // Normal compiles, not OSR: short calls over the first 64 entities.
    if (variant === 'wasm') {
      const fn = CASES[name].rot ? s.k.collectSpritesTurned : s.k.collectSprites;
      tier = await warmWasm(fn, () => run(64));
    }
    else warmNormalCompile(() => run(64));
    cases[name] = timeIt(`preRender collect ${variant} ${name} (${N} sprites, ${queued} queued)`, () => run(), { iterations: 20, warmup: 5 });
    cases[name].queued = queued;
  }
  const report = {
    feature: 'preRender-collect-wasm',
    variant,
    functions: ['PreRenderWorker.collectVisibleEntities', 'preRenderCollect.collect_sprites', 'preRenderCollect.collect_sprites_turned'],
    n: N,
    seed: 0xb0b,
    checksum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (ARGS.output) writeReport(String(ARGS.output), report);
  else {
    console.log(`checksum ${checksum}${tier ? ` tier ${tier}` : ''}`);
    for (const [name, c] of Object.entries(cases)) console.log(`  ${name}: ${c.opsPerSec.toFixed(1)} ops/s (${c.queued} queued)`);
  }
}

if (isCli(import.meta.url)) await main();
