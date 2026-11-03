// N-112: pre-render reads a visible list while the particle worker writes the next one, each on its own loop. With
// one list, a read that overlapped a write mixed the two (an index twice, another missing), and the missing ones
// were not drawn that frame: in Conurbano-weed decorations blinked while the camera moved. A real particle worker in
// a thread of its own writes the decoration list with the camera alternating between two views, as fast as it goes;
// a real pre-render on the main thread collects it as fast as it goes, and every collect must be one view's list
// whole: the same indices, each once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { Layer } from '../../src/core/layer.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

// The race runs until the reader has seen the list change this many times (a few hundredths of a second when the
// machine is free), or for RACE_MS at most: both threads spin meanwhile, and other test files' timings share the CPU.
const CHANGES = 300;
const RACE_MS = 1000;

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

/** A pre-render worker bound to the scene's lists by its own init path, with an empty main collector of `n` rows. */
async function bootReader(scene, n) {
  const b = scene.buffers;
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: { ySorting: false }, lighting: {} }, true);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await quietly(() =>
    pre.initializeCommonBuffers({
      config: scene.config,
      globalEntityCount: scene.totalEntityCount,
      maxDecorations: n,
      visibleDecorationsData: b.visibleDecorationsData,
      buffers: {
        componentData: { DecorationComponent: b.componentData.DecorationComponent },
        componentDataByte: { DecorationComponent: b.componentDataByte.DecorationComponent },
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

test('pre-render collects one whole decoration list while the particle worker writes the next', async (t) => {
  const n = 4000;
  // A row of decorations 2 px apart (x 5 to 8003); the views see x 0 to 4000 and 2001 to 6001, about 2000 each.
  const scene = buildPoolScene({ decorations: n, world: [9000, 2000] });
  for (let k = 0; k < n; k++) assert.ok(DecorationPool.spawn({ x: 5 + k * 2, y: 100, sway: false }) >= 0);
  const views = [
    [0, 0, 4000, 1000],
    [2001, 0, 4000, 1000],
  ];
  const b = scene.buffers;
  const stop = new SharedArrayBuffer(4);
  const writer = new Worker(new URL('../helpers/decorationScreenWriter.mjs', import.meta.url), {
    workerData: {
      config: scene.config,
      n,
      views,
      stop,
      buffers: {
        decorationComponent: b.componentData.DecorationComponent,
        decorationComponentByte: b.componentDataByte.DecorationComponent | 0,
        decorationFreeList: b.decorationFreeList,
        decorationFreeListTop: b.decorationFreeListTop,
        activeDecorationsData: b.activeDecorationsData,
        activeDecorationsLock: b.activeDecorationsLock,
        visibleDecorationsData: b.visibleDecorationsData,
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
    assert.notDeepEqual(new Set(expected[0]), new Set(expected[1]), 'the views see different decorations');
    const marks = expected.map((list) => {
      const m = new Uint8Array(n);
      for (const i of list) m[i] = 1;
      return m;
    });

    const pre = await bootReader(scene, n);
    const seen = new Uint32Array(n);
    const done = next();
    writer.postMessage('go');
    let reads = 0;
    let torn = 0;
    let switches = 0;
    let last = -1;
    const t0 = performance.now();
    while (switches < CHANGES && performance.now() - t0 < RACE_MS) {
      pre._renderableCount = 0;
      pre.visibleDecorationsCount = 0;
      pre.collectVisibleDecorations();
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
    t.diagnostic(`${reads} collects, ${frames} lists written, ${switches} changes of view seen, ${torn} torn`);
    assert.equal(torn, 0, `${torn} of ${reads} collects were no view's list whole (${frames} writes)`);
    assert.ok(switches >= 30, `the reader saw the list change under it (${switches} times in ${reads} reads, ${frames} writes)`);
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1);
    await writer.terminate();
    Layer.reset();
  }
});
