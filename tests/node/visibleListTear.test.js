// N-112: pre-render reads a visible list while the particle worker writes the next one, each on its own loop. With
// one list, a read that overlapped a write mixed the two (an index twice, another missing), and the missing ones
// were not drawn that frame: in Conurbano-weed decorations blinked while the camera moved. A real particle worker in
// a thread of its own writes the decoration list (or the bullet list) with the camera alternating between two views,
// as fast as it goes; a real pre-render on the main thread, bound by its own init path, collects it as fast as it
// goes, and every collect must be one view's list whole: the same indices, each once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { BulletPool } from '../../src/core/bulletPool.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { Layer } from '../../src/core/layer.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

// The race runs until the reader has seen the list change this many times (a few hundredths of a second when the
// machine is free), or for RACE_MS at most: both threads spin meanwhile, and other test files' timings share the CPU.
const CHANGES = 300;
const RACE_MS = 1000;
const N = 4000;
// A row of N things 2 px apart (x 5 to 8003); the views see x 0 to 4000 and 2001 to 6001, about 2000 each.
const VIEWS = [
  [0, 0, 4000, 1000],
  [2001, 0, 4000, 1000],
];

/** What the collect wrote, as the view it is (0 or 1), or -1 when it is neither list whole. */
function classify(pre, marks, sizes, seen, gen) {
  const rows = pre._renderableCount;
  const index = pre._renderableIndex;
  let in0 = rows === sizes[0];
  let in1 = rows === sizes[1];
  for (let k = 0; k < rows; k++) {
    const i = index[k];
    if (seen[i] === gen) return -1;
    seen[i] = gen;
    if (!marks[0][i]) in0 = false;
    if (!marks[1][i]) in1 = false;
  }
  return in0 ? 0 : in1 ? 1 : -1;
}

/** A pre-render worker bound to the scene's `kind` buffers by its own init path, with an empty collector of `n` rows. */
async function bootReader(scene, kind, n) {
  const b = scene.buffers;
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: { ySorting: false }, lighting: {} }, true);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const Component = kind === 'decorations' ? 'DecorationComponent' : 'BulletComponent';
  await quietly(() =>
    pre.initializeCommonBuffers({
      config: scene.config,
      globalEntityCount: scene.totalEntityCount,
      ...(kind === 'decorations'
        ? { maxDecorations: n, visibleDecorationsData: b.visibleDecorationsData }
        : { maxBullets: n, visibleBulletsData: b.visibleBulletsData }),
      buffers: {
        componentData: { [Component]: b.componentData[Component] },
        componentDataByte: { [Component]: b.componentDataByte?.[Component] | 0 },
      },
    }),
  );
  pre.renderQueueEnabled = true;
  pre._decorationZoomAlpha = 1;
  pre._customLayerCollectors = null;
  pre._spriteSortArrays = null;
  pre.renderQueueMaxItems = n;
  pre._renderableY = new Float32Array(n);
  pre._renderableType = new Uint8Array(n);
  pre._renderableIndex = new Int32Array(n);
  pre._collectPx = new Float32Array(n);
  pre._collectPy = new Float32Array(n);
  pre._collectRotC = new Float32Array(n);
  pre._collectRotS = new Float32Array(n);
  return pre;
}

/** The race for one pool: the writer thread, then the reader here until CHANGES or RACE_MS; what it saw. */
async function race(t, kind, scene) {
  const b = scene.buffers;
  const decorations = kind === 'decorations';
  const Component = decorations ? 'DecorationComponent' : 'BulletComponent';
  const stop = new SharedArrayBuffer(4);
  const writer = new Worker(new URL('../helpers/visibleListWriter.mjs', import.meta.url), {
    workerData: {
      kind,
      config: scene.config,
      n: N,
      views: VIEWS,
      stop,
      buffers: {
        component: b.componentData[Component],
        componentByte: b.componentDataByte?.[Component] | 0,
        freeList: decorations ? b.decorationFreeList : b.bulletFreeList,
        freeListTop: decorations ? b.decorationFreeListTop : b.bulletFreeListTop,
        active: decorations ? b.activeDecorationsData : b.activeBulletsData,
        activeLock: decorations ? b.activeDecorationsLock : null,
        visible: decorations ? b.visibleDecorationsData : b.visibleBulletsData,
        impact: decorations ? null : b.impactBuffer,
      },
    },
  });
  const next = () =>
    new Promise((resolve, reject) => {
      writer.once('message', resolve);
      writer.once('error', reject);
    });
  try {
    const { expected } = await next();
    const sizes = expected.map((list) => list.length);
    assert.ok(sizes[0] > 1500 && sizes[1] > 1500, `each view sees about half the row (${sizes})`);
    assert.notDeepEqual(new Set(expected[0]), new Set(expected[1]), 'the views see different ones');
    const marks = expected.map((list) => {
      const m = new Uint8Array(N);
      for (const i of list) m[i] = 1;
      return m;
    });

    const pre = await bootReader(scene, kind, N);
    const collect = decorations
      ? () => {
          pre.visibleDecorationsCount = 0;
          pre.collectVisibleDecorations();
        }
      : () => pre.collectVisibleBullets();
    const seen = new Uint32Array(N);
    const done = next();
    writer.postMessage('go');
    let reads = 0;
    let torn = 0;
    let switches = 0;
    let last = -1;
    const t0 = performance.now();
    while (switches < CHANGES && performance.now() - t0 < RACE_MS) {
      pre._renderableCount = 0;
      collect();
      reads++;
      const view = classify(pre, marks, sizes, seen, reads);
      if (view < 0) torn++;
      else {
        if (last >= 0 && view !== last) switches++;
        last = view;
      }
    }
    Atomics.store(new Int32Array(stop), 0, 1);
    const { frames } = await done;
    t.diagnostic(`${kind}: ${reads} collects, ${frames} lists written, ${switches} changes of view seen, ${torn} torn`);
    return { reads, torn, switches, frames };
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1);
    await writer.terminate();
    Layer.reset();
  }
}

test('pre-render collects one whole decoration list while the particle worker writes the next', async (t) => {
  const scene = buildPoolScene({ decorations: N, world: [9000, 2000] });
  for (let k = 0; k < N; k++) assert.ok(DecorationPool.spawn({ x: 5 + k * 2, y: 100, sway: false }) >= 0);
  const { reads, torn, switches, frames } = await race(t, 'decorations', scene);
  assert.equal(torn, 0, `${torn} of ${reads} collects were no view's list whole (${frames} writes)`);
  assert.ok(switches >= 30, `the reader saw the list change under it (${switches} times in ${reads} reads, ${frames} writes)`);
});

test('pre-render collects one whole bullet list while the particle worker ticks the next', async (t) => {
  const scene = buildPoolScene({ bullets: N, world: [9000, 2000] });
  // Bullets that stand still: the tick moves none and casts no ray, and lists them against the camera.
  for (let k = 0; k < N; k++) {
    assert.ok(BulletPool.spawn({ x: 5 + k * 2, y: 100, vx: 0, vy: 0, damage: 1, ownerId: 0 }) >= 0);
  }
  const { reads, torn, switches, frames } = await race(t, 'bullets', scene);
  assert.equal(torn, 0, `${torn} of ${reads} collects were no view's list whole (${frames} writes)`);
  assert.ok(switches >= 30, `the reader saw the list change under it (${switches} times in ${reads} reads, ${frames} writes)`);
});
