// E-76 W22: the sway kernel (tests/fixtures/wasm/decorationSway.wasm, from wasm/test/decorationSway.c) against
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
import { setupSwayKernel, SWAY_SLOTS, swayDecorationsWasm, TRIG_IMPULSE } from '../bench/decorationSwayWasmMicrobench.mjs';
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

// W22 wired: a particle worker booted on a render-queue memory with the sway regions (as the scene makes it:
// the decorations block, then the sway arrays) binds the kernel itself and keeps its sway arrays there.
// updateDecorationSway with the kernel and without it must leave the same bytes, frame after frame, on the
// random frames above: the worker's own path (writeSwayColumns, sway_decorations, _finishSwayTrig).
test('updateDecorationSway through the kernel the worker binds writes what the JS writes', async (t) => {
  const k = 100;
  const caps = gpuQueueCaps(64, { enabled: false });
  const m = createRenderQueueMemory(64, computeBufferSize(64), computeGpuQueueBufferSize(caps),
    { entities: 16, spriteBytes: 0, casterBytes: 0, decorationBytes: DecorationComponent.getBufferSize(N) }, null,
    { decorations: N, buckets: k });
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await initWorker(worker, {
    config: { particle: { swayFrequencyBuckets: k }, decoration: { maxDecorations: N } },
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
  const bound = worker._swayWasm;
  assert.ok(bound, 'the worker bound the kernel at init');
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
    worker._swayWasm = bound;
    worker.updateDecorationSway(deltaTime);
    stateViews(st).forEach(([name, v], c) => {
      const at = firstDiff(v, js[c][1]);
      assert.equal(at, -1, `frame ${f}: ${name}[${at}]: JS ${js[c][1][at]}, kernel ${v[at]}`);
    });
  }
  assert.ok(calls >= 50 && listed > 0, `the kernel ran (${calls} calls) and listed decorations for the JS (${listed})`);
  t.diagnostic(`${calls} kernel calls, ${listed} decorations finished in JS`);
});
