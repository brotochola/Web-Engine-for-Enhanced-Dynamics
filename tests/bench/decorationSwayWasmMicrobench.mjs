#!/usr/bin/env node
/**
 * Kernel (E-76 W22): the particle worker's decoration sway in WASM (wasm/test/decorationSway.c, a test
 * module) against the shipped ParticleWorker._updateDecorationSwayBuckets, on a real particle worker with
 * Predator's grass.
 *
 *   js    ParticleWorker.updateDecorationSway (shipped), as update() calls it every frame: its bucket
 *         path, _updateDecorationSwayBuckets
 *   wasm  swayDecorationsWasm below, what a product wrapper would do per call: the same guards, the
 *         per-bucket Math.sin / Math.cos and the cache reset in JS, one sway_decorations call, then
 *         Math.sin / Math.cos for the decorations the kernel lists (none of Predator's)
 *
 * Predator's decorations: 20 000 grass blades spawned through the shipped DecorationPool.spawn (what
 * Decoration.spawn calls) with predatorScene.js's spawnGrass config: SWAY_LOOP_SKEW, amplitude 0.05–0.08,
 * frequency 1–3 snapped onto its 100 sway buckets. The scene's free list is sequential, so the snapshot
 * holds 0, 1, 2, … The blades stand at random points of Predator's 10 000 × 5 000 world (the scene picks
 * random tiles of its grass layer; the texture is left out, sway does not read it) and the view takes the
 * left 51 % of it: 10 200 of 20 000 blades on screen, the emit bench's count, with the on-screen flags in
 * snapshot order as random as the positions. Aged from the spawn: the first frame misses every bucket of
 * the cache, the frames after it hit.
 *
 * The sway reads DecorationComponent columns and the particle worker's snapshot, phase tables, bucket
 * tables and bucket cache; the kernel needs them all in the memory it imports. DecorationComponent is a
 * region of the render-queue memory in the product (E-112). The bench builds one shared memory, gives the
 * worker's init the component block at a region of it (componentDataByte, the product's path) and moves
 * the worker's own arrays after it, so the JS and the kernel read and write the same bytes.
 *
 * One variant per process, through runKernelVariants.mjs, which rejects a variant whose checksum differs.
 * The checksum covers rotC, rotS, sway, swayPhase, the bucket tables and the cache after each of the first
 * 8 frames. --check runs those frames only and prints the checksum: no warm-up, no timing.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/decorationSwayWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/decorationSwayWasmMicrobench.mjs --variant wasm [--on-screen 1] [--n 20000] [--check] [--output path]
 *
 * --on-screen is the share of the world's width in view (1: every blade on screen, Q3's fixture).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { SWAY_ANGLE_PER_MS, swayFrequencyForBucket } from '../../src/util/decorationSway.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES } from '../../src/util/wasmMemoryMap.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { initWorker, loadWorker } from './workerHarness.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/decorationSway.wasm'));

/** decorationSway.c's table, slot for slot. */
export const SWAY_SLOTS = [
  'snapshot', 'active', 'parent', 'parentWide', 'noParent', 'onScreen', 'sway', 'amplitude', 'frequency', 'phase',
  'rotC', 'rotS', 'baseRotC', 'baseRotS', 'phaseSin', 'phaseCos', 'bucketSin', 'bucketCos', 'bucketOf', 'bucketFreq',
  'list', 'listCap', 'trig', 'trigValue',
];
const SLOT = Object.fromEntries(SWAY_SLOTS.map((name, k) => [name, k]));
/** decorationSway.c's TRIG_IMPULSE: the trig-list bit of an impulse, whose value is its phase. */
export const TRIG_IMPULSE = 0x10000;
/** The decorations the kernel lets through its early continues at a time: the list region's length. */
export const SWAY_LIST_CAP = 1024;

const DT = 1000 / 60;
/** predatorScene.js: particle.swayFrequencyBuckets, decoration.maxDecorations, the world. */
const BUCKETS = 100;
const GRASS = 20000;
const WORLD_W = 10000;
const WORLD_H = 5000;
const ON_SCREEN = 10200 / 20000;
const CHECK_FRAMES = 8;
/** The scene clock at the first frame (the Predator fixture's 12 s warm-up). */
const START_MS = 12000;

/** A view of the same kind as `from` at `region`, holding what `from` holds. */
function moved(buffer, region, from) {
  const view = new from.constructor(buffer, region.byte, from.length);
  view.set(from);
  return view;
}

/**
 * A real particle worker whose sway arrays all live in one shared memory, Predator's grass spawned and
 * the kernel bound. `kMax` sizes the bucket tables for a grid larger than the one the worker starts with.
 * @param {{ n?: number, k?: number, kMax?: number, listCap?: number, onScreen?: number, seed?: number }} [opts]
 */
export async function setupSwayKernel(opts = {}) {
  const n = opts.n ?? GRASS;
  const k = opts.k ?? BUCKETS;
  const kMax = Math.max(k, opts.kMax ?? k);
  const listCap = opts.listCap ?? SWAY_LIST_CAP;
  const layout = layoutRegions([
    { name: 'guard', bytes: NULL_GUARD_BYTES },
    { name: 'decorations', bytes: DecorationComponent.getBufferSize(n) },
    { name: 'snapshot', bytes: n * 2 },
    { name: 'phaseSin', bytes: n * 4 },
    { name: 'phaseCos', bytes: n * 4 },
    { name: 'bucketSin', bytes: kMax * 4 },
    { name: 'bucketCos', bytes: kMax * 4 },
    { name: 'bucketOf', bytes: n * 2 },
    { name: 'bucketFreq', bytes: n * 4 },
    { name: 'list', bytes: listCap * 2 },
    { name: 'trig', bytes: n * 4 },
    { name: 'trigValue', bytes: n * 8 },
    // The parent column as entityIdWidth 32 lays it out, for the parity test.
    { name: 'parent32', bytes: n * 4 },
    { name: 'table', bytes: SWAY_SLOTS.length * 4 },
  ].map((r) => ({ ...r, owner: 'particle' })));
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;

  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await initWorker(worker, {
    config: { particle: { swayFrequencyBuckets: k }, decoration: { maxDecorations: n } },
    globalEntityCount: 16,
    buffers: {
      componentData: { DecorationComponent: buffer },
      componentDataByte: { DecorationComponent: R.decorations.byte },
    },
    extra: {
      maxDecorations: n,
      decorationFreeList: new SharedArrayBuffer(n * 2),
      decorationFreeListTop: new SharedArrayBuffer(8),
      activeDecorationsData: new SharedArrayBuffer((1 + n) * 2),
      activeDecorationsLock: new SharedArrayBuffer(4),
    },
  });
  if (DecorationComponent.rotC.buffer !== buffer) throw new Error('DecorationComponent is not in the kernel memory');
  if (worker._swayBuckets !== k) throw new Error(`the worker has ${worker._swayBuckets} sway buckets, not ${k}`);

  // The worker's own sway arrays, moved into the memory with what its init put in them.
  worker._activeDecorationSnapshot = moved(buffer, R.snapshot, worker._activeDecorationSnapshot);
  worker._phaseSin = moved(buffer, R.phaseSin, worker._phaseSin);
  worker._phaseCos = moved(buffer, R.phaseCos, worker._phaseCos);
  worker._bucketSin = moved(buffer, R.bucketSin, worker._bucketSin);
  worker._bucketCos = moved(buffer, R.bucketCos, worker._bucketCos);
  worker._swayBucketOf = moved(buffer, R.bucketOf, worker._swayBucketOf);
  worker._swayBucketFreq = moved(buffer, R.bucketFreq, worker._swayBucketFreq);

  // Predator's grass (predatorScene.js spawnGrass), from the scene's sequential free list.
  resetFreeList(DecorationPool.freeListTop, DecorationPool.freeList, n, 1);
  const rng = mulberry32(opts.seed ?? 0x9a55);
  for (let s = 0; s < n; s++) {
    const x = rng() * WORLD_W;
    const y = rng() * WORLD_H;
    const scale = 0.2 + rng() * 0.1;
    rng(); // the grass texture
    const i = DecorationPool.spawn({
      x,
      y,
      scaleX: scale,
      scaleY: scale,
      alpha: 0.7 + rng() * 0.3,
      anchorX: 0.5,
      anchorY: 1.0,
      sway: true,
      swaySkew: true,
      swayAmplitude: 0.05 + rng() * 0.03,
      swayFrequency: 1 + rng() * 2,
    });
    if (i < 0) throw new Error('the decoration pool filled up');
  }
  // What updateDecorationScreenVisibility leaves for a view over the left part of the world.
  const D = DecorationComponent;
  const viewRight = WORLD_W * (opts.onScreen ?? ON_SCREEN);
  let onScreen = 0;
  for (let i = 0; i < n; i++) {
    const on = D.x[i] < viewRight ? 1 : 0;
    D.isItOnScreen[i] = on;
    onScreen += on;
  }
  worker.refreshActiveDecorationSnapshot();
  if (worker._activeDecorationSnapshotCount !== n) throw new Error(`the snapshot holds ${worker._activeDecorationSnapshotCount} of ${n}`);
  worker.accumulatedTime = START_MS;

  const b = await bindSwayKernel(memory, R, worker, listCap);
  return { worker, memory, buffer, layout, regions: R, b, n, k, onScreen };
}

/** Load the kernel onto `memory` and write its table. */
export async function bindSwayKernel(memory, regions, worker, listCap = SWAY_LIST_CAP) {
  if (!(listCap >= 1 && listCap * 2 <= regions.list.bytes)) throw new Error(`sway: a list of ${listCap} does not fit its region`);
  const { sway_decorations: sway } = await loadWasmKernel('decorationSway', KERNEL_URL, memory, ['sway_decorations']);
  const buffer = memory.buffer;
  const b = {
    sway,
    buffer,
    tableByte: regions.table.byte,
    table: new Uint32Array(buffer, regions.table.byte, SWAY_SLOTS.length),
    listByte: regions.list.byte,
    listCap,
    trig: new Uint32Array(buffer, regions.trig.byte, regions.trig.bytes / 4),
    trigValue: new Float64Array(buffer, regions.trigValue.byte, regions.trigValue.bytes / 8),
  };
  writeSwayTable(b, worker);
  return b;
}

/** The table from DecorationComponent's and the worker's views, which must all be in the memory. */
export function writeSwayTable(b, worker) {
  const D = DecorationComponent;
  const t = b.table;
  const at = (slot, view) => {
    if (!view || view.buffer !== b.buffer) throw new Error(`sway: ${slot} is not in the kernel memory`);
    t[SLOT[slot]] = view.byteOffset;
  };
  at('snapshot', worker._activeDecorationSnapshot);
  at('active', D.active);
  at('parent', D.parentEntityIndex);
  t[SLOT.parentWide] = D.parentEntityIndex.BYTES_PER_ELEMENT === 4 ? 1 : 0;
  t[SLOT.noParent] = worker._noParent;
  at('onScreen', D.isItOnScreen);
  at('sway', D.sway);
  at('amplitude', D.swayAmplitude);
  at('frequency', D.swayFrequency);
  at('phase', D.swayPhase);
  at('rotC', D.rotC);
  at('rotS', D.rotS);
  at('baseRotC', D.baseRotC);
  at('baseRotS', D.baseRotS);
  at('phaseSin', worker._phaseSin);
  at('phaseCos', worker._phaseCos);
  at('bucketSin', worker._bucketSin);
  at('bucketCos', worker._bucketCos);
  at('bucketOf', worker._swayBucketOf);
  at('bucketFreq', worker._swayBucketFreq);
  t[SLOT.list] = b.listByte;
  t[SLOT.listCap] = b.listCap;
  at('trig', b.trig);
  at('trigValue', b.trigValue);
}

/** The rest of the JS loop body for the decorations the kernel listed: Math.sin / Math.cos, then the rotation. */
function finishTrig(trig, trigValue, n) {
  const D = DecorationComponent;
  const rotC = D.rotC;
  const rotS = D.rotS;
  const baseRotC = D.baseRotC;
  const baseRotS = D.baseRotS;
  const swayAmplitude = D.swayAmplitude;
  for (let t = 0; t < n; t++) {
    const e = trig[t];
    const i = e & 0xffff;
    let delta = trigValue[t];
    if ((e & TRIG_IMPULSE) !== 0) delta = Math.sin(delta) * swayAmplitude[i];
    const bc = baseRotC[i];
    const bs = baseRotS[i];
    if (delta !== 0) {
      const ad = delta < 0 ? -delta : delta;
      const dc = ad < 0.08 ? 1 : Math.cos(delta);
      const ds = ad < 0.08 ? delta : Math.sin(delta);
      rotC[i] = bc * dc - bs * ds;
      rotS[i] = bs * dc + bc * ds;
    } else {
      rotC[i] = bc;
      rotS[i] = bs;
    }
  }
}

/**
 * ParticleWorker.updateDecorationSway with its bucket loop in the kernel, as a product wrapper would run
 * it each call. Returns the length of the trig list, or -1 when the kernel was not called.
 */
export function swayDecorationsWasm(b, worker, deltaTime = 0) {
  if (!worker.maxDecorations || worker.maxDecorations === 0 || !DecorationComponent.active) return -1;
  const activeCount = worker._activeDecorationSnapshotCount;
  if (activeCount === 0) return -1;
  const k = worker._swayBuckets;
  if (!(k > 1)) {
    // Without buckets every decoration takes a Math.sin: that loop stays JS.
    worker.updateDecorationSway(deltaTime);
    return -1;
  }
  // _updateDecorationSwayBuckets before its loop: this frame's bucket angles, and the cache reset.
  const swayBaseAngle = worker.accumulatedTime * SWAY_ANGLE_PER_MS;
  const sA = worker._bucketSin;
  const cA = worker._bucketCos;
  for (let bk = 0; bk < k; bk++) {
    const a = swayBaseAngle * swayFrequencyForBucket(bk, k);
    sA[bk] = Math.sin(a);
    cA[bk] = Math.cos(a);
  }
  if (worker._swayBucketCacheK !== k) {
    worker._swayBucketCacheK = k;
    worker._swayBucketFreq.fill(-1);
  }
  const n = b.sway(b.tableByte, activeCount, k, deltaTime);
  if (n > 0) finishTrig(b.trig, b.trigValue, n);
  return n;
}

function hashBytes(h, view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}

/** FNV-1a over what a sway frame writes: the rotations, the impulse state, the bucket tables, the cache. */
export function hashSwayState(h, worker) {
  const D = DecorationComponent;
  for (const view of [D.rotC, D.rotS, D.sway, D.swayPhase, worker._bucketSin, worker._bucketCos, worker._swayBucketOf, worker._swayBucketFreq]) {
    h = hashBytes(h, view);
  }
  return h;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const s = await setupSwayKernel({ n: Number(args.n ?? GRASS), onScreen: Number(args['on-screen'] ?? ON_SCREEN) });
  const { worker, b } = s;
  let listed = 0;
  const sway = variant === 'wasm'
    ? () => {
        const n = swayDecorationsWasm(b, worker, DT);
        if (n > 0) listed += n;
      }
    : () => worker.updateDecorationSway(DT);
  const frame = () => {
    worker.accumulatedTime += DT;
    sway();
  };

  // The first frames from the spawn: every bucket misses, then every one hits.
  let checksum = 2166136261;
  for (let f = 0; f < CHECK_FRAMES; f++) {
    frame();
    checksum = hashSwayState(checksum, worker);
  }
  const checkedListed = listed;
  const line = `checksum ${checksum} (${CHECK_FRAMES} frames, ${s.n} decorations, ${s.onScreen} on screen${variant === 'wasm' ? `, ${checkedListed} listed for Math.sin / Math.cos` : ''})`;
  if (args.check) {
    console.log(line);
    return;
  }

  // Normal compiles, not OSR: short calls over the first 64 decorations of the snapshot.
  const count = worker._activeDecorationSnapshotCount;
  const short = () => {
    worker._activeDecorationSnapshotCount = 64;
    frame();
  };
  let tier = null;
  if (variant === 'wasm') tier = await warmWasm(b.sway, short);
  else warmNormalCompile(short);
  worker._activeDecorationSnapshotCount = count;
  const cases = {
    sway: timeIt(`decoration sway ${variant} (${s.n} decorations, ${s.onScreen} on screen)`, frame, { iterations: 50, warmup: 20 }),
  };
  const report = {
    feature: 'decoration-sway-wasm',
    variant,
    functions: ['ParticleWorker._updateDecorationSwayBuckets', 'decorationSway.sway_decorations'],
    n: s.n,
    onScreen: s.onScreen,
    buckets: s.k,
    listCap: b.listCap,
    checksum,
    // Decorations the kernel listed for Math.sin / Math.cos over the checksum frames (wasm).
    listed: variant === 'wasm' ? checkedListed : null,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`${line}${tier ? ` tier ${tier}` : ''} sway ${cases.sway.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
