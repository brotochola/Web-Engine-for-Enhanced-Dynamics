#!/usr/bin/env node
/**
 * Kernel (E-76 W4b): pre-render's sprite collect in WASM (wasm/preRenderCollect.c) against the JS loop it replaced
 * (tests/reference/preRenderCollectJs.mjs), on a real worker, 250 000 sprites, every column in one shared
 * memory (preRenderCollectKernel.mjs).
 *
 *   bunny     BunnyMark: skipCull, every sprite queued, the sprite query's list (copied into the memory)
 *   cull      a straight camera at zoom 0.5 over a world five times the view: about a fifth queued
 *   turned    the same camera turned 0.4 rad (E-51's copy of the loop)
 *   predator  Predator's collect (Phase 4): 60 % of the sprites on bodies, their published pose interpolated,
 *             Y-sort on the foot line of anchors that are mostly not the feet; a straight camera over a world
 *             twice the view, about a quarter queued
 *
 *   js    the JS collect (collectVisibleEntitiesJs) on the worker
 *   wasm  the shipped collectVisibleEntities, the kernel bound (_collectVisibleEntitiesWasm)
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/preRenderCollectWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/preRenderCollectWasmMicrobench.mjs --variant wasm [--scale 0.1] [--output path]
 */
import { Query } from '../../src/core/query.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker, quietly } from './workerHarness.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { bindCollect, collectMemory, useBodies, useSortY } from './preRenderCollectKernel.mjs';
import { collectVisibleEntitiesJs } from '../reference/preRenderCollectJs.mjs';

const ARGS = parseArgs();
const SCALE = Number(ARGS.scale ?? 1);
// --sprites sets the count exactly (262144 puts the columns a multiple of 4 KB apart); --skew 1 starts each
// column a cache line past its boundary (E-113).
const N = ARGS.sprites ? Number(ARGS.sprites) : Math.max(1024, Math.round(250000 * SCALE));
const SKEW = Number(ARGS.skew ?? 0) === 1;

const CASES = {
  bunny: { skipCull: true, rot: 0, zoom: 1, world: 1, list: true },
  cull: { skipCull: false, rot: 0, zoom: 0.5, world: 5, list: false },
  turned: { skipCull: false, rot: 0.4, zoom: 0.5, world: 5, list: false },
  predator: { skipCull: false, rot: 0, zoom: 1, world: 2, list: false, bodies: true, sortY: true },
};

/** Predator's anchors: boids and clouds at the centre, people near the feet, rocks, grass at the feet. */
const ANCHORS = [[0.5, 0.5], [0.5, 0.5], [0.5, 0.98], [0.5, 0.66], [0.5, 1]];

export async function setupCollectKernel(caseName, seed = 0xb0b) {
  const c = CASES[caseName];
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const m = collectMemory(pre, N, N, { skew: SKEW });
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
  if (c.bodies) {
    for (let i = 0; i < N; i++) {
      v.rb[i] = rng() < 0.6 ? 1 : 0;
      const a = rng() * 6.3;
      v.px[i] = v.x[i] + (rng() - 0.5) * 4;
      v.py[i] = v.y[i] + (rng() - 0.5) * 4;
      v.pc[i] = Math.cos(a);
      v.ps[i] = Math.sin(a);
      const a0 = rng() < 0.3 ? a : a + (rng() - 0.5) * 0.2;
      v.qx[i] = v.px[i] + (rng() - 0.5) * 4;
      v.qy[i] = v.py[i] + (rng() - 0.5) * 4;
      v.qc[i] = Math.cos(a0);
      v.qs[i] = Math.sin(a0);
    }
    useBodies(pre, m, { interpolate: true, alpha: 0.5 });
  }
  if (c.sortY) {
    const frames = v.frameW.length;
    for (let f = 0; f < frames; f++) {
      v.frameW[f] = 16 + ((rng() * 112) | 0);
      v.frameH[f] = 16 + ((rng() * 112) | 0);
    }
    for (let i = 0; i < N; i++) {
      const [ax, ay] = ANCHORS[(rng() * ANCHORS.length) | 0];
      v.anchorX[i] = ax;
      v.anchorY[i] = ay;
      v.scaleX[i] = 1;
      v.scaleY[i] = 1;
      v.inherit[i] = rng() < 0.5 ? 1 : 0;
      v.faceC[i] = 1;
      v.faceS[i] = 0;
      v.lastTexture[i] = (rng() * frames) | 0;
    }
    useSortY(pre, m, (i) => i % frames);
  }
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
  const js = (items = N) => sized(items, () => collectVisibleEntitiesJs(pre));
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
    functions: ['collectVisibleEntitiesJs', 'PreRenderWorker.collectVisibleEntities', 'preRenderCollect.collect_sprites', 'preRenderCollect.collect_sprites_turned'],
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
