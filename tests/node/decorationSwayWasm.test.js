// E-76 W22: the double sway kernel (sway_decorations in src/workers/decorationSway.wasm, from wasm/decorationSway.c) against
// the shipped ParticleWorker.updateDecorationSway (its bucket path, _updateDecorationSwayBuckets) on a real
// particle worker, every array the sway reads in one shared memory as decorationSwayWasmMicrobench lays it
// out, the kernel run through that bench's wrapper (swayDecorationsWasm: the per-bucket Math.sin / Math.cos
// in JS, the kernel, then Math.sin / Math.cos for the decorations it lists). Both sides start each frame from
// the same bytes. The frames start from Predator's grass, then turn random to reach every branch of the JS
// loop: inactive, parented, off-screen and non-swaying decorations; loop, skew, impulse and unknown modes;
// bucket-cache hits and misses, NaN frequencies, frequencies past both ends of the grid, on a rounding tie
// (Math.round takes a tie up) and on the cache's -1 sentinel after the grid shrank (a bucket past the new
// grid: NaN in the JS); grids of 2, 3, 5, 7 and 100 buckets and one past 65 535 (the Uint16Array cache
// wraps); impulses that end (past π, or at a phase of -1), that take Math.sin, and whose phase is ±0, NaN
// or -Infinity; sway angles of ±0, under 0.08 rad, past it (Math.cos / Math.sin), NaN and infinite; NaN,
// infinite and -0 base rotations; a zero, negative, NaN and huge deltaTime; empty, partial and full
// snapshots in any order; chunks of 1, 37 and 1024 decorations; the 32-bit parent column. After every frame
// each DecorationComponent column, the snapshot, the phase and bucket tables and the cache must hold what
// the JS wrote, bit for bit, except that a NaN only has to be a NaN (V8 and WebAssembly may give it
// different payloads).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { computeBufferSize } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { bucketFromSwayFrequency, SWAY_IMPULSE, SWAY_LOOP, SWAY_LOOP_SKEW, SWAY_OFF } from '../../src/util/decorationSway.js';
import { compareSwayStates, setupSwayKernel, SWAY_SLOTS, swayDecorationsWasm, TRIG_IMPULSE } from '../bench/decorationSwayWasmMicrobench.mjs';
import { bindDecorationSway } from '../../src/workers/decorationSwayClient.js';
import {
  DT,
  frameDelta,
  K_MAX,
  LIST_CAPS,
  N,
  PHASES,
  pickSnapshot,
  rng,
  scramble,
  setGrid,
  stateViews,
  useWideParents,
} from '../helpers/decorationSwayScenarios.mjs';

const LIST_CAP_SLOT = SWAY_SLOTS.indexOf('listCap');

/** Which branch of the JS each snapshot entry takes this frame, from the state before it (coverage only). */
function classify(s, deltaTime, k, cov) {
  const D = DecorationComponent;
  const w = s.worker;
  const snap = w._activeDecorationSnapshot;
  const count = w._activeDecorationSnapshotCount;
  const reset = w._swayBucketCacheK !== k;
  const step = 2 / (k - 1);
  if (count === 0) cov.emptySnapshot++;
  if (count === N) cov.fullSnapshot++;
  for (let idx = 0; idx < count; idx++) {
    const i = snap[idx];
    if (!D.active[i]) cov.inactive++;
    else if (D.parentEntityIndex[i] !== w._noParent) cov.parented++;
    else if (!D.isItOnScreen[i]) cov.offScreen++;
    else if (D.sway[i] === SWAY_OFF) cov.swayOff++;
    else if (D.sway[i] === SWAY_LOOP || D.sway[i] === SWAY_LOOP_SKEW) {
      cov[D.sway[i] === SWAY_LOOP ? 'loop' : 'skew']++;
      const f = D.swayFrequency[i];
      if ((reset ? -1 : w._swayBucketFreq[i]) !== f) {
        cov.bucketMiss++;
        const x = (f - 1) / step;
        if (Number.isNaN(f)) cov.nanFrequency++;
        else if (x - Math.floor(x) === 0.5) cov.roundingTie++;
        if (bucketFromSwayFrequency(f, k) > 0xffff) cov.wrappedBucket++;
      } else {
        cov.bucketHit++;
        if (w._swayBucketOf[i] >= k) cov.staleBucket++;
      }
      if (D.sway[i] === SWAY_LOOP) {
        const amp = Math.abs(D.swayAmplitude[i]);
        if (amp === 0) cov.zeroAngle++;
        else if (amp < 0.075) cov.smallAngle++;
        else if (!Number.isFinite(amp)) cov.nonFiniteAngle++;
      }
    } else if (D.sway[i] === SWAY_IMPULSE) {
      const next = D.swayPhase[i] + deltaTime * 0.002 * D.swayFrequency[i];
      if (next >= Math.PI) cov.impulseEnds++;
      else if (next === -1) cov.impulseAtMinusOne++;
      else if (next === 0) cov.impulseZeroPhase++;
      else if (Number.isFinite(next)) cov.impulseSin++;
      else cov.impulseNaN++;
    } else cov.otherMode++;
  }
}

/** The first element that differs: a float as Object.is sees it (NaN is NaN, +0 is not -0), the rest exactly. */
function firstDiff(a, b) {
  const float = a instanceof Float32Array;
  for (let i = 0; i < a.length; i++) {
    if (float ? !Object.is(a[i], b[i]) : a[i] !== b[i]) return i;
  }
  return -1;
}

/**
 * The sines and cosines the kernel takes itself (sway_free, sway_trig) are fdlibm's, which V8's match to an ulp
 * (E-76 Q2): a rotation it writes may differ from the JS's by that much after the composition and the float32
 * store, so rotC and rotS are held to SWAY_TRIG_TOL of the base rotation's size. An angle past fdlibm's medium
 * reduction (|x| >= 2^20 pi/2, about 1.6e6 rad: an amplitude, a frequency or an impulse phase no decoration has)
 * is reduced modulo 2 pi in double, which keeps nothing of the angle: such a decoration is left out of the
 * comparison (its rotation is noise on both paths).
 */
const SWAY_TRIG_TOL = 1e-6;
const SWAY_TRIG_DOMAIN = 2 ** 20 * (Math.PI / 2);
/** How many rotations firstRotationDiff held to the tolerance (not equal bit for bit, inside the domain). */
const rotationsCompared = { n: 0 };

/** The first rotation outside the tolerance (D's columns as they were before the frame), or -1. */
function firstRotationDiff(a, b, D, before, baseAngle, deltaTime) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y))) continue;
    const scale = Math.max(1, Math.abs(before.baseRotC[i]) + Math.abs(before.baseRotS[i]));
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= SWAY_TRIG_TOL * scale) {
      rotationsCompared.n++;
      continue;
    }
    // The largest argument either path takes for it: the amplitude bounds a sway angle, the frequency times the
    // base angle or the frame's phase step bounds a sine's argument (an impulse adds its phase, under pi).
    const amp = Math.abs(before.swayAmplitude[i]);
    const reach = Math.abs(before.swayFrequency[i]) * Math.max(1, Math.abs(baseAngle), Math.abs(deltaTime * 0.002)) + 4 + i * 0.1;
    if (!(amp < SWAY_TRIG_DOMAIN) || !(reach < SWAY_TRIG_DOMAIN)) continue;
    return i;
  }
  return -1;
}

/** One frame on each side from the same bytes; the kernel's state is the next frame's. */
function runFrame(s, deltaTime) {
  const w = s.worker;
  const mem = new Uint8Array(s.buffer, 0, s.layout.bytes);
  const before = mem.slice();
  const cacheK = w._swayBucketCacheK;
  w.updateDecorationSway(deltaTime);
  const js = stateViews(s).map(([name, v]) => [name, v.slice()]);
  const jsCacheK = w._swayBucketCacheK;
  mem.set(before);
  w._swayBucketCacheK = cacheK;
  const listed = swayDecorationsWasm(s.b, w, deltaTime);
  const views = stateViews(s);
  for (let c = 0; c < views.length; c++) {
    const [name, v] = views[c];
    const at = firstDiff(v, js[c][1]);
    if (at >= 0) return { listed, diff: `${name}[${at}]: JS ${js[c][1][at]}, kernel ${v[at]}` };
  }
  if (w._swayBucketCacheK !== jsCacheK) return { listed, diff: `_swayBucketCacheK: JS ${jsCacheK}, kernel ${w._swayBucketCacheK}` };
  return { listed, diff: null };
}

test('the sway kernel writes what _updateDecorationSwayBuckets writes, frame after frame', async (t) => {
  const s = await setupSwayKernel({ n: N, k: 100, kMax: K_MAX, listCap: 1024, seed: 0x5ee0 });
  const w = s.worker;
  const r = rng(0xdec0);
  const cov = {
    inactive: 0, parented: 0, offScreen: 0, swayOff: 0, loop: 0, skew: 0, otherMode: 0,
    bucketMiss: 0, bucketHit: 0, nanFrequency: 0, roundingTie: 0, wrappedBucket: 0, staleBucket: 0,
    zeroAngle: 0, smallAngle: 0, nonFiniteAngle: 0, listedAngle: 0,
    impulseEnds: 0, impulseAtMinusOne: 0, impulseZeroPhase: 0, impulseNaN: 0, impulseSin: 0, listedImpulse: 0,
    emptySnapshot: 0, fullSnapshot: 0, wideFrames: 0,
  };
  let frame = 0;
  for (const p of PHASES) {
    if (p.wide) useWideParents(s);
    if (w._swayBuckets !== p.k) setGrid(s, p.k);
    for (let f = 0; f < p.frames; f++, frame++) {
      s.b.table[LIST_CAP_SLOT] = LIST_CAPS[frame % LIST_CAPS.length];
      let deltaTime = DT;
      if (!p.predator) {
        scramble(r, s, p.k, f === 0 ? 1 : 0.25, p.wide);
        pickSnapshot(r, s);
        deltaTime = frameDelta(r);
      }
      w.accumulatedTime += DT;
      classify(s, deltaTime, p.k, cov);
      if (p.wide) cov.wideFrames++;
      const { listed, diff } = runFrame(s, deltaTime);
      assert.equal(diff, null, `${p.name} frame ${f} (${w._activeDecorationSnapshotCount} in the snapshot, deltaTime ${deltaTime})`);
      if (w._activeDecorationSnapshotCount > 0) assert.ok(listed >= 0, `${p.name} frame ${f}: the kernel ran`);
      if (p.predator) assert.equal(listed, 0, `${p.name} frame ${f}: Predator's grass needs no Math.sin / Math.cos`);
      for (let e = 0; e < listed; e++) cov[(s.b.trig[e] & TRIG_IMPULSE) !== 0 ? 'listedImpulse' : 'listedAngle']++;
    }
  }
  for (const [branch, hits] of Object.entries(cov)) assert.ok(hits > 0, `no frame reached ${branch}`);
  t.diagnostic(`${frame} frames: ${JSON.stringify(cov)}`);
});


/**
 * A particle worker booted on a render-queue memory with the sway regions (as the scene makes it: the
 * decorations block, then the sway arrays), with `wasm` as its config's wasm block.
 */
async function bootWired(k, wasm) {
  const caps = gpuQueueCaps(64, { enabled: false });
  const m = createRenderQueueMemory(64, computeBufferSize(64), computeGpuQueueBufferSize(caps),
    { entities: 16, spriteBytes: 0, casterBytes: 0, decorationBytes: DecorationComponent.getBufferSize(N) }, null,
    { decorations: N, buckets: k });
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await initWorker(worker, {
    config: { particle: { swayFrequencyBuckets: k }, decoration: { maxDecorations: N }, ...(wasm ? { wasm } : {}) },
    globalEntityCount: 16,
    buffers: {
      componentData: { DecorationComponent: m.buffer },
      componentDataByte: { DecorationComponent: m.layout.emit.decorationByte },
    },
    extra: {
      maxDecorations: N,
      decorationFreeList: new SharedArrayBuffer(N * 2),
      decorationFreeListTop: new SharedArrayBuffer(8),
      activeDecorationsData: new SharedArrayBuffer((1 + N) * 2),
      activeDecorationsLock: new SharedArrayBuffer(4),
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
    },
  });
  return { m, worker };
}

// W22 wired: the worker binds the kernel itself and keeps its sway arrays in the memory.
// updateDecorationSway with the kernel and without it must leave the same bytes, frame after frame, on the
// random frames above: the worker's own path (writeSwayColumns, sway_decorations, sway_trig), with
// wasm.decorationSwayF32 off (the double sway). The rotations of the decorations sway_trig finishes are held to
// SWAY_TRIG_TOL; every other byte is exact.
test('updateDecorationSway through the kernel the worker binds writes what the JS writes', async (t) => {
  const k = 100;
  const { m, worker } = await bootWired(k, { decorationSwayF32: false });
  const bound = worker._swayWasm;
  assert.ok(bound, 'the worker bound the kernel at init');
  assert.equal(bound.f32, false, 'wasm.decorationSwayF32 false binds sway_decorations');
  for (const name of ['_activeDecorationSnapshot', '_phaseSin', '_phaseCos', '_bucketSin', '_bucketCos', '_swayBucketOf', '_swayBucketFreq']) {
    assert.equal(worker[name].buffer, m.buffer, `${name} is in the memory`);
  }
  let calls = 0;
  let listed = 0;
  const kernel = bound.sway;
  bound.sway = (...args) => {
    calls++;
    const n = kernel(...args);
    listed += n;
    return n;
  };
  const st = { worker };
  const r = rng(0x5ee1);
  const mem = new Uint8Array(m.buffer);
  for (let f = 0; f < 60; f++) {
    scramble(r, st, k, f === 0 ? 1 : 0.25, false);
    pickSnapshot(r, st);
    const deltaTime = frameDelta(r);
    worker.accumulatedTime += DT;
    const before = mem.slice();
    const cacheK = worker._swayBucketCacheK;
    worker._swayWasm = null;
    worker.updateDecorationSway(deltaTime);
    const js = stateViews(st).map(([name, v]) => [name, v.slice()]);
    mem.set(before);
    worker._swayBucketCacheK = cacheK;
    const pre = beforeColumns();
    worker._swayWasm = bound;
    worker.updateDecorationSway(deltaTime);
    stateViews(st).forEach(([name, v], c) => {
      const rot = name === 'rotC' || name === 'rotS';
      const at = rot ? firstRotationDiff(v, js[c][1], DecorationComponent, pre, worker.accumulatedTime * 0.002, deltaTime) : firstDiff(v, js[c][1]);
      assert.equal(at, -1, `frame ${f}: ${name}[${at}]: JS ${js[c][1][at]}, kernel ${v[at]}`);
    });
  }
  assert.ok(calls >= 50 && listed > 0, `the kernel ran (${calls} calls) and listed decorations for sway_trig (${listed})`);
  t.diagnostic(`${calls} kernel calls, ${listed} decorations finished by sway_trig`);
});

/** The columns the tolerance reads, as they are before a frame. */
function beforeColumns() {
  const D = DecorationComponent;
  return {
    baseRotC: D.baseRotC.slice(),
    baseRotS: D.baseRotS.slice(),
    swayAmplitude: D.swayAmplitude.slice(),
    swayFrequency: D.swayFrequency.slice(),
  };
}

// Close-out group B: without a frequency grid (particle.swayFrequencyBuckets 0, the default) the worker binds
// sway_free and the whole loop runs in the kernel, every sine in it. updateDecorationSway with the kernel and
// without it, on the random frames above: every byte exact but the rotations, which are held to SWAY_TRIG_TOL.
test('updateDecorationSway without a frequency grid runs sway_free, within its tolerance of the JS', async (t) => {
  const { m, worker } = await bootWired(0, { decorationSwayF32: false });
  const bound = worker._swayWasm;
  assert.ok(bound, 'the worker bound the kernel without a grid');
  assert.equal(worker._swayBuckets, 0);
  let calls = 0;
  const free = bound.free;
  bound.free = (...args) => {
    calls++;
    return free(...args);
  };
  const st = { worker };
  const r = rng(0x5ee3);
  const mem = new Uint8Array(m.buffer);
  for (let f = 0; f < 60; f++) {
    scramble(r, st, 2, f === 0 ? 1 : 0.25, false);
    pickSnapshot(r, st);
    const deltaTime = frameDelta(r);
    worker.accumulatedTime += DT;
    const before = mem.slice();
    worker._swayWasm = null;
    worker.updateDecorationSway(deltaTime);
    const js = stateViews(st).map(([name, v]) => [name, v.slice()]);
    mem.set(before);
    const pre = beforeColumns();
    worker._swayWasm = bound;
    worker.updateDecorationSway(deltaTime);
    const baseAngle = worker.accumulatedTime * 0.002;
    stateViews(st).forEach(([name, v], c) => {
      const rot = name === 'rotC' || name === 'rotS';
      const at = rot ? firstRotationDiff(v, js[c][1], DecorationComponent, pre, baseAngle, deltaTime) : firstDiff(v, js[c][1]);
      assert.equal(at, -1, `frame ${f}: ${name}[${at}]: JS ${js[c][1][at]}, kernel ${v[at]}`);
    });
  }
  assert.ok(calls >= 50, `sway_free ran (${calls} calls)`);
  t.diagnostic(`${calls} sway_free calls, ${rotationsCompared.n} rotations within the tolerance and not bit for bit`);
});

// The default, wasm.decorationSwayF32 on: the worker binds sway_decorations_f32x4, and its frames on the
// worker's own path stay within compareSwayStates' tolerance (decorationSwayF32.test.js) of the same path
// with the double sway, which the test above ties to the JS.
test('wasm.decorationSwayF32 (default on) binds the float32 sway, within its tolerance on the worker path', async (t) => {
  const k = 100;
  const { m, worker } = await bootWired(k, null);
  const bound = worker._swayWasm;
  assert.ok(bound, 'the worker bound the kernel at init');
  assert.equal(bound.f32, true, 'the default binds sway_decorations_f32x4');
  const f32 = bound.sway;
  const f64 = (await bindDecorationSway(m.memory, m.layout.sway, { f32: false })).sway;
  let trig = null;
  const run = (fn) => (...args) => {
    const n = fn(...args);
    trig = { trig: bound.trig.slice(0, n), value: bound.trigValue.slice(0, n) };
    return n;
  };
  const st = { worker };
  const r = rng(0x5ee2);
  const mem = new Uint8Array(m.buffer);
  const stats = { stepFlips: 0, worst: 0 };
  let frames = 0;
  for (let f = 0; f < 60; f++) {
    scramble(r, st, k, f === 0 ? 1 : 0.25, false);
    pickSnapshot(r, st);
    const deltaTime = frameDelta(r);
    worker.accumulatedTime += DT;
    const before = mem.slice();
    const cacheK = worker._swayBucketCacheK;
    trig = null;
    bound.sway = run(f64);
    worker.updateDecorationSway(deltaTime);
    const ref = mem.slice();
    const refTrig = trig;
    const refCacheK = worker._swayBucketCacheK;
    mem.set(before);
    worker._swayBucketCacheK = cacheK;
    trig = null;
    bound.sway = run(f32);
    worker.updateDecorationSway(deltaTime);
    if (!refTrig) continue;
    frames++;
    assert.equal(worker._swayBucketCacheK, refCacheK, `frame ${f}: the cache grid`);
    // The trig lists are compared as the kernels returned them; the bytes after the JS finished them.
    const bad = compareSwayStates(stateViews(st), ref, mem.slice(), refTrig, trig, stats);
    assert.equal(bad, null, `frame ${f}`);
  }
  bound.sway = f32;
  assert.ok(frames >= 50, `${frames} frames swayed`);
  t.diagnostic(`${frames} frames: rotation error at most ${(stats.worst * 100).toFixed(0)} % of its slack, ${stats.stepFlips} across the 0.08 rad step`);
});
