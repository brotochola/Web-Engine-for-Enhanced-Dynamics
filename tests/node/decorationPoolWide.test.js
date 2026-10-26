// E-129: the decoration pool sizes its slot ids from decoration.maxDecorations. On a scene's shared buffers
// (createSceneSharedBuffers, tests/helpers/poolScene.mjs) and a real particle worker booted on them:
// - at 65 535 decorations: the 16-bit buffers it always had (free list, active and visible lists, the spatial
//   hash, the attachment table, the sway snapshot and chunk list), views of Uint16Array, the spatial hash's 0xffff,
//   and the worker binds the 16-bit sway with the trig list's impulse at bit 16;
// - at 200 000 decorations: FL4, u32 lists, links and table, 0xffffffff; every slot spawns once, the spatial hash
//   finds, moves and drops decorations past 65 535, attachments name them, despawns keep the active list right;
//   the worker views the lists at 32 bits, culls into a visible list past 65 535, binds the _u32 sway (float32 by
//   default), and with the double one its own sway path (writeSwayColumns, the kernel, _finishSwayTrig) writes
//   what its JS sway writes, frame after frame, impulses and Math.cos / Math.sin past 65 535 included;
// - past MAX_POOL_SLOTS the scene refuses the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { DecorationSpatial } from '../../src/core/decorationSpatial.js';
import { Camera } from '../../src/core/camera.js';
import { popFl4, popU16 } from '../../src/util/atomicFreeList.js';
import { SWAY_IMPULSE, SWAY_LOOP } from '../../src/util/decorationSway.js';
import { MAX_POOL_SLOTS } from '../../src/util/poolSlotWidth.js';
import { alignToLine, SWAY_LIST_CAP } from '../../src/util/wasmMemoryMap.js';
import { TRIG_IMPULSE, TRIG_IMPULSE_U32 } from '../../src/workers/decorationSwayClient.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { updateDecorationSwayJs } from '../reference/decorationSwayJs.mjs';

const D = DecorationComponent;
const K = 100;

/** A particle worker on the scene's decoration buffers, as sceneWorkerBootstrap hands them over. */
async function bootWorker(scene, wasm = {}) {
  const b = scene.buffers;
  const n = scene.config.decoration.maxDecorations;
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await initWorker(worker, {
    config: { ...scene.config, wasm: { ...scene.config.wasm, ...wasm } },
    globalEntityCount: scene.totalEntityCount,
    buffers: {
      componentData: { DecorationComponent: b.componentData.DecorationComponent },
      componentDataByte: { DecorationComponent: b.componentDataByte.DecorationComponent },
    },
    extra: {
      maxDecorations: n,
      maxAttachedDecorationsPerEntity: scene.config.decoration.maxAttachedDecorationsPerEntity,
      decorationFreeList: b.decorationFreeList,
      decorationFreeListTop: b.decorationFreeListTop,
      activeDecorationsData: b.activeDecorationsData,
      activeDecorationsLock: b.activeDecorationsLock,
      visibleDecorationsData: b.visibleDecorationsData,
      attachedDecorationCount: b.attachedDecorationCount,
      attachedDecorationIndices: b.attachedDecorationIndices,
      renderQueueMemory: scene.renderQueueMemory.memory,
      renderQueueLayout: scene.renderQueueMemory.layout,
    },
  });
  return worker;
}

/** The sway regions' sizes, from their offsets (each on a cache line). */
function swayRegionBytes(layout) {
  const s = layout.sway;
  return { snapshot: s.phaseSinByte - s.snapshotByte, list: s.trigByte - s.listByte };
}

test('at 65 535 decorations the pool keeps the 16-bit buffers, links and sway', async () => {
  const n = 65535;
  const scene = buildPoolScene({ decorations: n, maxAttached: 4, swayBuckets: K, world: [4096, 4096] });
  const b = scene.buffers;
  const cells = 32 * 32;
  assert.equal(b.decorationFreeList.byteLength, n * 2);
  assert.equal(b.decorationFreeListTop.byteLength, 8);
  assert.equal(b.activeDecorationsData.byteLength, (1 + n) * 2);
  assert.equal(b.visibleDecorationsData.byteLength, (1 + n) * 2);
  assert.equal(b.decorationSpatialHead.byteLength, cells * 2);
  assert.equal(b.decorationSpatialNext.byteLength, n * 2);
  assert.equal(b.decorationSpatialPrev.byteLength, n * 2);
  assert.equal(b.attachedDecorationIndices.byteLength, 16 * 4 * 2);
  assert.ok(DecorationPool.freeList instanceof Uint16Array && DecorationPool._popSlot === popU16);
  assert.ok(DecorationPool.activeDecorationsData instanceof Uint16Array);
  assert.ok(DecorationPool._attachedDecorationIndices instanceof Uint16Array);
  assert.ok(DecorationSpatial.head instanceof Uint16Array && DecorationSpatial.next instanceof Uint16Array);
  assert.equal(DecorationSpatial.empty, 0xffff);
  assert.ok(DecorationSpatial.head.every((v) => v === 0xffff), 'the hash starts empty');
  assert.deepEqual(swayRegionBytes(scene.renderQueueMemory.layout), { snapshot: alignToLine(n * 2), list: alignToLine(SWAY_LIST_CAP * 2) });
  const worker = await bootWorker(scene);
  assert.ok(worker._activeDecorationSnapshot instanceof Uint16Array);
  assert.ok(worker.visibleDecorationsData instanceof Uint16Array && worker.activeDecorationsData instanceof Uint16Array);
  const s = worker._swayWasm;
  assert.ok(s, 'the worker bound the sway');
  assert.deepEqual([s.slotBytes, s.f32, s.trigIndexMask, s.trigImpulse], [2, true, 0xffff, TRIG_IMPULSE]);
});

test('200 000 decorations: 32-bit slots through the pool, the hash, attachments, culling and the sway', async (t) => {
  const n = 200000;
  const scene = buildPoolScene({ decorations: n, maxAttached: 4, swayBuckets: K, world: [8192, 8192] });
  const b = scene.buffers;
  assert.equal(b.decorationFreeList.byteLength, n * 4);
  assert.equal(b.decorationFreeListTop.byteLength, 16);
  assert.equal(b.activeDecorationsData.byteLength, (1 + n) * 4);
  assert.equal(b.decorationSpatialNext.byteLength, n * 4);
  assert.equal(b.attachedDecorationIndices.byteLength, 16 * 4 * 4);
  assert.ok(DecorationPool.freeList instanceof Uint32Array && DecorationPool._popSlot === popFl4);
  assert.ok(DecorationPool.activeDecorationsData instanceof Uint32Array);
  assert.equal(DecorationSpatial.empty, 0xffffffff);
  assert.ok(DecorationSpatial.head instanceof Uint32Array && DecorationSpatial.head.every((v) => v === 0xffffffff));
  assert.deepEqual(swayRegionBytes(scene.renderQueueMemory.layout), { snapshot: alignToLine(n * 4), list: alignToLine(SWAY_LIST_CAP * 4) });

  // Every slot once.
  const r = mulberry32(0x129d0);
  const seen = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const i = DecorationPool.spawn({ x: r() * 8000, y: r() * 8000, sway: true, swaySkew: k % 3 === 0, swayAmplitude: 0.02 + r() * 0.05, swayFrequency: 1 + r() * 2 });
    assert.ok(i >= 0 && !seen[i], `spawn ${k}: slot ${i}`);
    seen[i] = 1;
  }
  assert.equal(DecorationPool.getActiveCount(), n);
  assert.equal(DecorationPool.spawn({ x: 1, y: 1 }) < 0, true, 'the pool is full');
  // The hash: a decoration past 65 535 is found where it stands, moved, and gone once despawned.
  const far = 199999;
  const out = new Uint32Array(256);
  const near = (x, y) => Array.from(out.subarray(0, DecorationSpatial.queryCircle(x, y, 1, out)));
  const [fx, fy] = [D.x[far], D.y[far]];
  assert.ok(near(fx, fy).includes(far), 'queryCircle finds slot 199 999');
  DecorationSpatial.move(far, 10, 10);
  assert.ok(near(10, 10).includes(far) && !near(fx, fy).includes(far), 'moved');
  // Attachments name slots past 65 535.
  assert.ok(DecorationPool.pushAttached(3, 150000) && DecorationPool.pushAttached(3, 70000));
  assert.equal(DecorationPool.getAttachedDecorationIndex(3, 0), 150000);
  DecorationPool.removeAttached(3, 150000);
  assert.equal(DecorationPool.getAttachedDecorationIndex(3, 0), 70000);
  // Despawn every third slot, and slot 199 999: the hash drops it, the active list keeps the rest, each once.
  for (let i = 0; i < n; i += 3) assert.ok(DecorationPool.despawn(i), `despawn ${i}`);
  assert.ok(DecorationPool.despawn(far));
  assert.ok(!near(10, 10).includes(far), 'a despawned decoration leaves the hash');
  const live = n - Math.ceil(n / 3) - 1;
  assert.equal(DecorationPool.getActiveCount(), live);
  const list = DecorationPool.activeDecorationsData;
  const inList = new Uint8Array(n);
  for (let k = 1; k <= list[0]; k++) inList[list[k]]++;
  for (let i = 0; i < n; i++) assert.equal(inList[i], i % 3 === 0 || i === far ? 0 : 1, `slot ${i} in the active list`);

  // The particle worker on these buffers: 32-bit views, a visible list past 65 535, the _u32 sway.
  const worker = await bootWorker(scene, { decorationSwayF32: false });
  assert.ok(worker._activeDecorationSnapshot instanceof Uint32Array);
  assert.ok(worker.visibleDecorationsData instanceof Uint32Array && worker.activeDecorationsData instanceof Uint32Array);
  const bound = worker._swayWasm;
  assert.deepEqual([bound.slotBytes, bound.f32, bound.trigIndexMask, bound.trigImpulse], [4, false, 0x7fffffff, TRIG_IMPULSE_U32]);
  const cam = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(cam, 1920, 1080);
  cam[0] = 0.25;
  cam[5] = 0.25;
  worker.canvasWidth = 1920;
  worker.canvasHeight = 1080;
  worker.cameraData = cam;
  worker._frameCamValid = false;
  worker.refreshActiveDecorationSnapshot();
  assert.equal(worker._activeDecorationSnapshotCount, live);
  worker.updateDecorationScreenVisibility();
  const visible = worker.visibleDecorationsData;
  let maxVisible = -1;
  for (let k = 1; k <= visible[0]; k++) if (visible[k] > maxVisible) maxVisible = visible[k];
  assert.ok(visible[0] > 1000 && maxVisible > 65535, `${visible[0]} in view, up to slot ${maxVisible}`);

  // Sway through the worker's own path against its JS sway: impulses and large angles past 65 535 too.
  for (let i = 1; i < n; i += 3) D.isItOnScreen[i] = 1;
  for (let i = 65537; i < n; i += 997) {
    if (!D.active[i]) continue;
    D.sway[i] = i % 2 ? SWAY_IMPULSE : SWAY_LOOP;
    D.swayAmplitude[i] = i % 2 ? 0.3 : 0.5; // past 0.08 rad: Math.cos / Math.sin in JS
    D.swayPhase[i] = 0.4;
  }
  const mem = new Uint8Array(scene.renderQueueMemory.buffer);
  const views = () => [D.rotC, D.rotS, D.sway, D.swayPhase, worker._swayBucketOf, worker._swayBucketFreq];
  let listed = 0;
  let listedImpulse = 0;
  const kernel = bound.sway;
  bound.sway = (...args) => {
    const m = kernel(...args);
    listed += m;
    for (let e = 0; e < m; e++) if (bound.trig[e] & TRIG_IMPULSE_U32) listedImpulse++;
    return m;
  };
  for (let f = 0; f < 12; f++) {
    worker.accumulatedTime += 1000 / 60;
    const before = mem.slice();
    const cacheK = worker._swayBucketCacheK;
    updateDecorationSwayJs(worker, 1000 / 60);
    const js = views().map((v) => v.slice());
    mem.set(before);
    worker._swayBucketCacheK = cacheK;
    worker._swayWasm = bound;
    worker.updateDecorationSway(1000 / 60);
    views().forEach((v, c) => {
      const at = v.findIndex((x, i) => !Object.is(x, js[c][i]) && !(Number.isNaN(x) && Number.isNaN(js[c][i])));
      assert.equal(at, -1, `frame ${f}: view ${c} at ${at}`);
    });
  }
  assert.ok(listed > 0 && listedImpulse > 0, `${listed} trig entries, ${listedImpulse} impulses`);
  t.diagnostic(`${live} live, ${visible[0]} in view, ${listed} trig entries (${listedImpulse} impulses)`);
  // The default binds the float32 u32 sway.
  const byDefault = await bootWorker(scene);
  assert.deepEqual([byDefault._swayWasm.slotBytes, byDefault._swayWasm.f32], [4, true]);
});

test('the scene refuses a decoration pool past MAX_POOL_SLOTS', () => {
  assert.throws(() => buildPoolScene({ decorations: MAX_POOL_SLOTS + 1 }), /decoration\.maxDecorations must be an integer in \[0, 524287\]/);
});
