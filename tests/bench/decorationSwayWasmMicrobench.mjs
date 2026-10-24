#!/usr/bin/env node
/**
 * Kernel (E-76 W22): the particle worker's decoration sway in WASM (wasm/decorationSway.c, src/workers/decorationSway.wasm, a
 * module) against the shipped ParticleWorker._updateDecorationSwayBuckets, on a real particle worker with
 * Predator's grass.
 *
 *   js    ParticleWorker.updateDecorationSway (shipped), as update() calls it every frame: its bucket
 *         path, _updateDecorationSwayBuckets
 *   wasm  the same call with the kernel bound (worker._swayWasm, as its initialize binds it on the
 *         render-queue memory): the per-bucket Math.sin / Math.cos and the cache reset in JS, then
 *         _swayFrameWasm (the column table, one sway_decorations call, Math.sin / Math.cos for the
 *         decorations the kernel lists, none of Predator's). swayDecorationsWasm below is the same
 *         around a fixed table, for the parity test.
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
 *   wasm-f32    the same call with sway_decorations_f32 (wasm/test/decorationSwayF32.c, a test module)
 *               bound in the kernel's place: the sway angle and its rotation in float32, scalar
 *   wasm-f32x4  sway_decorations_f32x4: the same operations, four skew decorations per f32x4 (bit-identical)
 *
 * One variant per process, through runKernelVariants.mjs, which rejects a variant whose checksum differs.
 * The checksum covers rotC, rotS, sway, swayPhase, the bucket tables and the cache after each of the first
 * 8 frames. --check runs those frames only and prints the checksum: no warm-up, no timing. js and wasm hash
 * their own state (E-119: identical). A float32 variant runs those frames in lock-step with the shipped
 * kernel: each frame the shipped kernel sways from the shipped state and gives the hash, then the variant
 * sways the same frame from the same bytes and compareSwayStates checks it (everything exact but rotC and
 * rotS, which take swayF32Slack, and the trig list, whose values take it too), and the run goes on from the
 * shipped state. The checksum is the shipped kernel's (wasm's) when every frame passes, and a string naming
 * the first difference when one does not.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/decorationSwayWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/decorationSwayWasmMicrobench.mjs --variants wasm,wasm-f32,wasm-f32x4 --rounds 5
 *   node tests/bench/decorationSwayWasmMicrobench.mjs --variant wasm [--on-screen 1] [--n 20000] [--check] [--output path]
 *
 * --on-screen is the share of the world's width in view (1: every blade on screen, Q3's fixture).
 */
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { SWAY_ANGLE_PER_MS, SWAY_LOOP, swayFrequencyForBucket } from '../../src/util/decorationSway.js';
import { bindDecorationSway, SWAY_SLOTS, TRIG_IMPULSE } from '../../src/workers/decorationSwayClient.js';
import { layoutRegions, NULL_GUARD_BYTES } from '../../src/util/wasmMemoryMap.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { initWorker, loadWorker } from './workerHarness.mjs';
import { instantiateKernel, machineState, warmWasm } from './wasmKernelHelpers.mjs';

/** The float32 sways: tests/fixtures/wasm/decorationSwayF32.wasm, by variant name. */
export const SWAY_F32_MODULE = 'decorationSwayF32';
export const SWAY_F32_EXPORTS = Object.freeze({ 'wasm-f32': 'sway_decorations_f32', 'wasm-f32x4': 'sway_decorations_f32x4' });

/** The float32 sway functions on `memory`, by variant name. */
export function swayF32Kernels(memory) {
  const exports = instantiateKernel(SWAY_F32_MODULE, memory);
  return Object.fromEntries(Object.entries(SWAY_F32_EXPORTS).map(([variant, name]) => [variant, exports[name]]));
}

/** Away from 0.08 rad by at most this, a float32 angle can take the other side of the JS's small-angle step. */
const SWAY_STEP_COS = 1 - Math.cos(0.08) + (0.08 - Math.sin(0.08));

/**
 * How far a float32 sway may put a decoration's rotC or rotS from the shipped kernel's: a few float32
 * roundings of the angle (relative to the amplitude, since sin a cos p + cos a sin p can cancel) carried
 * through the rotation, 2^-21 · (1 + |amplitude|) · (1 + |baseRotC| + |baseRotS|): 1.2e-6 for Predator's
 * grass. The angle of a trig-list entry takes 2^-21 · (1 + |amplitude|).
 */
export function swayF32Slack(amplitude, baseRotC, baseRotS) {
  // A NaN input gives NaN on both sides (or does not enter: a skew decoration ignores its base rotation).
  const mag = (v) => (Number.isNaN(v) ? 0 : Math.abs(v));
  return 2 ** -21 * (1 + mag(amplitude)) * (1 + mag(baseRotC) + mag(baseRotS));
}

/**
 * An infinite or NaN amplitude or base rotation, or a loop decoration's amplitude past 6.6e6 rad (where a
 * float32 rounding of the angle passes pi): the shipped rotation is then Math.cos / Math.sin of an angle no
 * rounding defines, or infinities whose NaN-ness follows its sign, so nothing holds the variant to it. Not a
 * value a scene sways by; the parity frames reach it with amplitudes of 3e38 and infinite bases.
 */
export function swayF32Free(mode, amplitude, baseRotC, baseRotS) {
  if (!(Math.abs(amplitude) < Infinity && Math.abs(baseRotC) < Infinity && Math.abs(baseRotS) < Infinity)) return true;
  return mode === SWAY_LOOP && Math.abs(amplitude) >= 6.6e6;
}

/** Two values of a float column agree: both NaN (any payload), the same, or within `slack`. */
function close(a, b, slack) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return a === b || Math.abs(a - b) <= slack;
}

/**
 * A float32 sway frame against the shipped kernel's on the same bytes. `views` is the [name, view] list of
 * every array the sway reads or writes (the DecorationComponent columns by their names, the worker's
 * arrays), all in one buffer; `ref` and `got` are copies of that buffer after each kernel's frame, `refTrig`
 * and `gotTrig` their trig lists ({ trig, value } arrays, before the JS finished them). Every array must be
 * the same (a float as Object.is sees it, any NaN for a NaN) but rotC and rotS, which take swayF32Slack; the
 * trig lists must hold the same entries with values within 2^-21 · (1 + |amplitude|), except a sway angle
 * within that of 0.08 rad, which can be in one list only: its rotation then takes the JS's step there too
 * (cos 0.08 against 1). A decoration whose inputs leave nothing to compare (swayF32Free) may differ in
 * both. Counts the step crossings in stats.stepFlips, the free decorations that differ in stats.free, the
 * largest rotation error as a share of its slack in stats.worst and absolute, for amplitudes up to 1 rad, in
 * stats.worstAbs; returns the first difference, or null.
 */
export function compareSwayStates(views, ref, got, refTrig, gotTrig, stats = { stepFlips: 0, worst: 0 }) {
  const at = (bytes, name) => {
    const v = views.find(([n]) => n === name)[1];
    return new v.constructor(bytes.buffer, v.byteOffset, v.length);
  };
  const amp = at(ref, 'swayAmplitude');
  const bc = at(ref, 'baseRotC');
  const bs = at(ref, 'baseRotS');
  const mode = at(ref, 'sway');
  const entries = (list) => {
    const m = new Map();
    for (let e = 0; e < list.trig.length; e++) m.set(list.trig[e], list.value[e]);
    return m;
  };
  const refList = entries(refTrig);
  const gotList = entries(gotTrig);
  const stepped = new Set();
  for (const key of new Set([...refList.keys(), ...gotList.keys()])) {
    const i = key & 0xffff;
    const impulse = (key & TRIG_IMPULSE) !== 0;
    const a = refList.get(key);
    const b = gotList.get(key);
    const slack = 2 ** -21 * (1 + Math.abs(amp[i]));
    if (a !== undefined && b !== undefined) {
      if (impulse ? a !== b : !close(a, b, slack)) return `trig value of ${i}: shipped ${a}, variant ${b}`;
      continue;
    }
    const v = a ?? b;
    if (!impulse && swayF32Free(mode[i], amp[i], bc[i], bs[i])) {
      stepped.add(i);
      continue;
    }
    if (impulse || !(Math.abs(Math.abs(v) - 0.08) <= slack)) {
      return `decoration ${i} is in ${a === undefined ? 'the variant' : 'the shipped'} trig list only (${v})`;
    }
    stepped.add(i);
    stats.stepFlips++;
  }
  for (const [name, view] of views) {
    const a = new view.constructor(ref.buffer, view.byteOffset, view.length);
    const b = new view.constructor(got.buffer, view.byteOffset, view.length);
    const rot = name === 'rotC' || name === 'rotS';
    for (let i = 0; i < a.length; i++) {
      if (rot) {
        if (swayF32Free(mode[i], amp[i], bc[i], bs[i])) {
          if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) stats.free = (stats.free ?? 0) + 1;
          continue;
        }
        let slack = swayF32Slack(amp[i], bc[i], bs[i]);
        if (stepped.has(i)) slack += SWAY_STEP_COS * (Math.abs(bc[i]) + Math.abs(bs[i]));
        if (!close(a[i], b[i], slack)) {
          return `${name}[${i}]: shipped ${a[i]}, variant ${b[i]} (slack ${slack}; mode ${at(ref, 'sway')[i]}, amplitude ${amp[i]}, base ${bc[i]}, ${bs[i]})`;
        }
        const err = Math.abs(a[i] - b[i]);
        if (err > 0 && err / slack > stats.worst) stats.worst = err / slack;
        if (Math.abs(amp[i]) <= 1 && err > (stats.worstAbs ?? 0)) stats.worstAbs = err;
      } else if (a instanceof Float32Array ? !(Object.is(a[i], b[i]) || (Number.isNaN(a[i]) && Number.isNaN(b[i]))) : a[i] !== b[i]) {
        return `${name}[${i}]: shipped ${a[i]}, variant ${b[i]}`;
      }
    }
  }
  return null;
}


export { SWAY_SLOTS, TRIG_IMPULSE };
const SLOT = Object.fromEntries(SWAY_SLOTS.map((name, k) => [name, k]));
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

/** Load the kernel onto `memory` through the client, on a layout of the bench's regions, and write its table. */
export async function bindSwayKernel(memory, regions, worker, listCap = SWAY_LIST_CAP) {
  if (!(listCap >= 1 && listCap * 2 <= regions.list.bytes)) throw new Error(`sway: a list of ${listCap} does not fit its region`);
  const b = await bindDecorationSway(memory, {
    decorations: regions.trig.bytes / 4,
    buckets: regions.bucketSin.bytes / 4,
    listCap,
    listByte: regions.list.byte,
    trigByte: regions.trig.byte,
    trigValueByte: regions.trigValue.byte,
    tableByte: regions.table.byte,
  });
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

/** Every array the sway reads or writes, by name: the DecorationComponent columns and the worker's. */
export function swayStateViews(worker) {
  const D = DecorationComponent;
  const out = Object.keys(D.ARRAY_SCHEMA).map((name) => [name, D[name]]);
  out.push(
    ['snapshot', worker._activeDecorationSnapshot],
    ['phaseSin', worker._phaseSin],
    ['phaseCos', worker._phaseCos],
    ['bucketSin', worker._bucketSin],
    ['bucketCos', worker._bucketCos],
    ['bucketOf', worker._swayBucketOf],
    ['bucketFreq', worker._swayBucketFreq],
  );
  return out;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  if (!['js', 'wasm', ...Object.keys(SWAY_F32_EXPORTS)].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const f32 = variant in SWAY_F32_EXPORTS;
  const s = await setupSwayKernel({ n: Number(args.n ?? GRASS), onScreen: Number(args['on-screen'] ?? ON_SCREEN) });
  const { worker, b } = s;
  let listed = 0;
  let lastListed = 0;
  // The shipped path either way: with the kernel bound, updateDecorationSway runs _swayFrameWasm. Over the
  // checksum frames the kernel's call counts what it lists; the timed frames call it bare.
  worker._swayWasm = variant === 'js' ? null : b;
  const shipped = b.sway;
  const kernel = f32 ? swayF32Kernels(s.memory)[variant] : shipped;
  const counted = (fn, count) => (...callArgs) => {
    const n = fn(...callArgs);
    lastListed = n;
    if (count && n > 0) listed += n;
    return n;
  };
  const countedKernel = counted(kernel, true);
  const countedShipped = counted(shipped, false);
  b.sway = countedKernel;
  const sway = () => worker.updateDecorationSway(DT);
  const frame = () => {
    worker.accumulatedTime += DT;
    sway();
  };
  const bytes = new Uint8Array(s.buffer, 0, s.layout.bytes);
  const views = swayStateViews(worker);
  const trigList = () => ({ trig: b.trig.slice(0, lastListed), value: b.trigValue.slice(0, lastListed) });
  const flips = { stepFlips: 0, worst: 0 };
  let violation = null;

  // The first frames from the spawn: every bucket misses, then every one hits.
  let checksum = 2166136261;
  for (let f = 0; f < CHECK_FRAMES; f++) {
    if (!f32) {
      frame();
      checksum = hashSwayState(checksum, worker);
      continue;
    }
    // The shipped kernel from the shipped state, then the variant from the same bytes; on from the former.
    worker.accumulatedTime += DT;
    const before = bytes.slice();
    const cacheK = worker._swayBucketCacheK;
    b.sway = countedShipped;
    sway();
    const refTrig = trigList();
    checksum = hashSwayState(checksum, worker);
    const ref = bytes.slice();
    const refCacheK = worker._swayBucketCacheK;
    bytes.set(before);
    worker._swayBucketCacheK = cacheK;
    b.sway = countedKernel;
    sway();
    const bad = compareSwayStates(views, ref, bytes.slice(), refTrig, trigList(), flips);
    if (bad && !violation) violation = `tolerance: frame ${f}: ${bad}`;
    bytes.set(ref);
    worker._swayBucketCacheK = refCacheK;
  }
  const checkedListed = listed;
  b.sway = kernel;
  if (violation) checksum = violation;
  const line = `checksum ${checksum} (${CHECK_FRAMES} frames, ${s.n} decorations, ${s.onScreen} on screen${variant !== 'js' ? `, ${checkedListed} listed for Math.sin / Math.cos` : ''})`;
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
  if (variant !== 'js') tier = await warmWasm(b.sway, short);
  else warmNormalCompile(short);
  worker._activeDecorationSnapshotCount = count;
  const cases = {
    sway: timeIt(`decoration sway ${variant} (${s.n} decorations, ${s.onScreen} on screen)`, frame, { iterations: 50, warmup: 20 }),
  };
  const report = {
    feature: 'decoration-sway-wasm',
    variant,
    functions: ['ParticleWorker._updateDecorationSwayBuckets', f32 ? `${SWAY_F32_MODULE}.${SWAY_F32_EXPORTS[variant]}` : 'decorationSway.sway_decorations'],
    n: s.n,
    onScreen: s.onScreen,
    buckets: s.k,
    listCap: b.listCap,
    checksum,
    // Decorations the kernel listed for Math.sin / Math.cos over the checksum frames (wasm and its variants).
    listed: variant !== 'js' ? checkedListed : null,
    // Float32 variants: decorations on the other side of the 0.08 rad step, and the largest rotation error
    // as a share of its slack, over the checksum frames.
    flips: f32 ? flips : null,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (violation) console.error(violation);
  if (args.output) writeReport(String(args.output), report);
  else console.log(`${line}${tier ? ` tier ${tier}` : ''} sway ${cases.sway.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
