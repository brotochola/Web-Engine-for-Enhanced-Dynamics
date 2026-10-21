import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { computeBufferSize, createViews } from '../../src/render/renderQueueLayout.js';

// G3. The CPU painter sorts the sort keys' bit patterns. Pre-render made that
// Uint32Array at pack time and cached one, so the double-buffered queue and
// each GPU layer swapped it for a new one every frame. Each queue now carries
// its alias from createViews. A queue without it is not an error: the painter
// quietly skips the sort, so this checks every way pre-render binds a queue.

const N = 8;
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function queue() {
  return createViews(new SharedArrayBuffer(computeBufferSize(N)), N);
}

function assertAlias(q, views, label) {
  assert.equal(q.sortKey, views.sortKey, `${label}: sortKey`);
  assert.equal(q.sortKeyU32, views.sortKeyU32, `${label}: the queue's own alias`);
  views.sortKey[5] = -2.75;
  f32[0] = -2.75;
  assert.equal(q.sortKeyU32[5], u32[0], `${label}: alias reads the keys' bits`);
}

test('createViews gives each queue one u32 alias of its sort keys', () => {
  const v = queue();
  assert.ok(v.sortKeyU32 instanceof Uint32Array);
  assert.equal(v.sortKeyU32.buffer, v.sortKey.buffer);
  assert.equal(v.sortKeyU32.byteOffset, v.sortKey.byteOffset);
  assert.equal(v.sortKeyU32.length, N);
});

test('pre-render packs every queue with that queue\'s own sort-key alias', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const a = queue();
  const b = queue();
  const layer = queue();
  pre.renderQueueBuffers = [a, b];

  pre._setWriteBuffer(0);
  assertAlias(pre._gpuSoAFromBound(), a, 'buffer 0');
  pre._setWriteBuffer(1);
  assertAlias(pre._gpuSoAFromBound(), b, 'buffer 1');

  // A GPU layer borrows the main columns, then they are restored.
  const saved = pre._mainColumnSnapshot();
  pre._applyMainColumns(layer);
  assertAlias(pre._gpuSoAFromBound(), layer, 'layer columns');
  assertAlias(pre._gpuSoAFromViews(layer), layer, 'layer views');
  pre._applyMainColumns(saved);
  assertAlias(pre._gpuSoAFromBound(), b, 'restored');
});
