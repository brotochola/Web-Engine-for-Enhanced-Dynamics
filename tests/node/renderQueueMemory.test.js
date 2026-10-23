import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBufferSize, createViews } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { GPU_PACK_COLUMNS } from '../../src/render/gpuPackClient.js';

// E-76 W9: the render queue's and the GPU queue's buffers as regions of one shared memory. Every
// view a worker makes from the payload's (buffer, byte) pairs lies in its own region.

const MAX = 5000;

function setup() {
  const caps = gpuQueueCaps(MAX, { enabled: true });
  const queueBytes = computeBufferSize(MAX);
  const gpuBytes = computeGpuQueueBufferSize(caps);
  const m = createRenderQueueMemory(MAX, queueBytes, gpuBytes);
  assert.ok(m, 'the memory is made');
  return { m, caps, queueBytes, gpuBytes };
}

function viewsRange(views) {
  let lo = Infinity;
  let hi = 0;
  for (const v of Object.values(views)) {
    if (!ArrayBuffer.isView(v) || v.byteLength === 0) continue;
    lo = Math.min(lo, v.byteOffset);
    hi = Math.max(hi, v.byteOffset + v.byteLength);
  }
  return [lo, hi];
}

test('the regions lie inside the memory, apart, and nothing starts at 0', () => {
  const { m, queueBytes, gpuBytes } = setup();
  const L = m.layout;
  const spans = [
    ['queueA', L.queueAByte, queueBytes],
    ['queueB', L.queueBByte, queueBytes],
    ['gpuA', L.gpuAByte, gpuBytes],
    ['gpuB', L.gpuBByte, gpuBytes],
    ['indices', L.indexByte, L.indexCap * 4],
    ['tables', L.tableByte, L.tableSlots * GPU_PACK_COLUMNS.length * 4],
    ['results', L.particlesByte, 16],
  ].sort((a, b) => a[1] - b[1]);
  assert.ok(spans[0][1] > 0, 'address 0 is the guard');
  for (let k = 0; k < spans.length; k++) {
    const [name, at, bytes] = spans[k];
    assert.equal(at % 64, 0, `${name} starts on a line`);
    assert.ok(at + bytes <= m.buffer.byteLength, `${name} fits`);
    if (k > 0) assert.ok(at >= spans[k - 1][1] + spans[k - 1][2], `${name} overlaps ${spans[k - 1][0]}`);
  }
  assert.equal(L.indexCap, MAX);
});

test('each queue views its own region, and writing one leaves the others alone', () => {
  const { m, caps, queueBytes, gpuBytes } = setup();
  const L = m.layout;
  const qa = createViews(m.buffer, MAX, L.queueAByte);
  const qb = createViews(m.buffer, MAX, L.queueBByte);
  const ga = createGpuQueueViews(m.buffer, caps, L.gpuAByte);
  const gb = createGpuQueueViews(m.buffer, caps, L.gpuBByte);
  for (const [v, at, bytes, name] of [[qa, L.queueAByte, queueBytes, 'queueA'], [qb, L.queueBByte, queueBytes, 'queueB'], [ga, L.gpuAByte, gpuBytes, 'gpuA'], [gb, L.gpuBByte, gpuBytes, 'gpuB']]) {
    const [lo, hi] = viewsRange(v);
    assert.ok(lo >= at && hi <= at + bytes, `${name}'s views stay in [${at}, ${at + bytes}): ${lo}..${hi}`);
  }
  assert.equal(ga.byteLength, gpuBytes, 'the GPU queue reports its own length');
  qa.x.fill(1);
  qa.tint.fill(0xffffffff);
  ga.sprites.fill(3);
  assert.equal(qb.x.reduce((s, x) => s + x, 0), 0, 'queue B untouched');
  assert.equal(gb.sprites.reduce((s, x) => s + x, 0), 0, 'GPU queue B untouched');
  assert.equal(new Uint8Array(m.buffer, 0, L.queueAByte).reduce((s, x) => s + x, 0), 0, 'nothing before queue A');
});
