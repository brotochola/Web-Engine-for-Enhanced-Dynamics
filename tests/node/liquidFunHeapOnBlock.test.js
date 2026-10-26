// A worker whose engine block is in Box2D's memory binds LiquidFun's heap views on its own handle of that memory
// (AbstractWorker._liquidFunHeapPayload), as bindBox2dHotFields binds the bodies. The physics worker posts the heap's
// SharedArrayBuffer, which arrives as another object for the same memory; pre-render's emit kernel reads a column
// only when its view is of the block's buffer, so with the posted object every LiquidFun row went back to the JS
// (liquidFunStressScene: 237 of 240 frames). structuredClone gives that second object here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LiquidFun } from '../../src/core/liquidFun.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 16;
function heapPayload(sab) {
  return { sab, maxCount: N, countByteOffset: 64, xByteOffset: 128, yByteOffset: 256, alphaByteOffset: 384 };
}

test('in the engine block, LiquidFun views the heap through the worker\'s handle of the block', async () => {
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const posted = structuredClone(memory.buffer);
  assert.notEqual(posted, memory.buffer, 'the posted buffer is another object');
  new Float32Array(posted, 128, N)[3] = 42.5;

  // The liquidFunHeap message (box2dReady's liquidFunHeap goes through the same _liquidFunHeapPayload).
  worker._box2dHeap = memory.buffer;
  worker.handleCustomMessage({ msg: 'liquidFunHeap', liquidFunHeap: heapPayload(posted) });
  const v = LiquidFun.getViews();
  assert.equal(v.x.buffer, memory.buffer, "x on the block's buffer");
  assert.equal(v.alpha.buffer, memory.buffer, 'alpha too');
  assert.equal(v.x[3], 42.5, 'the same memory');

  // Outside the block the posted buffer is the only handle.
  worker._box2dHeap = null;
  worker.handleCustomMessage({ msg: 'liquidFunHeap', liquidFunHeap: heapPayload(posted) });
  assert.equal(LiquidFun.getViews().x.buffer, posted);
  LiquidFun.unbindSabs();
});
