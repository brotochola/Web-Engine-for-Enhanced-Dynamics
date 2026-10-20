import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

// M2. FLOWFIELDS_SERVICED was meant to count every request, hits included, so
// COMPUTED / SERVICED is the LRU miss rate (E-37). It was counted at dequeue,
// but a cached target is answered in the message handler and never enqueued,
// and a pending one is coalesced, so it only ever saw misses and the ratio read
// 1. Requests are now counted where they arrive.

test('serviced counts hits, coalesced repeats and misses; computed only misses', async () => {
  const w = await loadWorker('particleWorker.js', 'particleWorker');
  const cached = new Set([5]);
  const computed = [];
  w.totalCells = 64;
  w.flowfieldRequests = new FakeQueue(64);
  w._findExistingFlowfieldSlot = (cell) => (cached.has(cell) ? 0 : -1);
  w._updateFlowfieldLRU = () => {};
  w.computeFlowfield = (cell) => {
    computed.push(cell);
    cached.add(cell);
  };
  w.flowfieldsServicedThisFrame = 0;
  w.flowfieldsComputedThisFrame = 0;

  const ask = (targetCell) => w.handleWorkerMessage('logic0', { type: 'REQUEST_FLOWFIELD', targetCell });
  ask(5); // hit
  ask(5); // hit
  ask(7); // miss, enqueued
  ask(7); // coalesced while pending
  ask(99); // out of range: not a request
  while (w._processNextFlowfieldRequest()) { /* drain */ }

  assert.deepEqual(computed, [7]);
  assert.equal(w.flowfieldsComputedThisFrame, 1);
  assert.equal(w.flowfieldsServicedThisFrame, 4);
});

// Same contract as the worker's FlowfieldRequestQueue: dedupes pending targets.
class FakeQueue {
  constructor(totalCells) {
    this.items = [];
    this.pending = new Uint8Array(totalCells);
  }
  enqueue(cell) {
    if (this.pending[cell]) return true;
    this.pending[cell] = 1;
    this.items.push(cell);
    return true;
  }
  dequeue() {
    if (!this.items.length) return -1;
    const cell = this.items.shift();
    this.pending[cell] = 0;
    return cell;
  }
}
