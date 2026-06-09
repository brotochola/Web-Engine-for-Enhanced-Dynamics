import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import {
  resetFreeList,
  popFreeIndex,
  pushFreeIndex,
  getFreeListCount,
} from '../../src/core/atomicFreeList.js';

function makeList(count) {
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(new SharedArrayBuffer(count * 2));
  return { top, links };
}

test('sequential reset pops highest index first (historical order)', () => {
  const { top, links } = makeList(4);
  resetFreeList(top, links, 4, 1);

  assert.equal(getFreeListCount(top), 4);
  assert.deepEqual(
    [0, 1, 2, 3].map(() => popFreeIndex(top, links)),
    [3, 2, 1, 0]
  );
  assert.equal(popFreeIndex(top, links), -1); // exhausted
  assert.equal(getFreeListCount(top), 0);
});

test('interleaved reset matches historical pop order', () => {
  const { top, links } = makeList(16);
  resetFreeList(top, links, 16, 4);

  // Old array fill wrote [0,4,8,12, 1,5,9,13, 2,6,10,14, 3,7,11,15];
  // LIFO pops are the reverse of that.
  const pops = [];
  for (let i = 0; i < 16; i++) pops.push(popFreeIndex(top, links));
  assert.deepEqual(pops, [15, 11, 7, 3, 14, 10, 6, 2, 13, 9, 5, 1, 12, 8, 4, 0]);
});

test('push/pop are LIFO and maintain the free count', () => {
  const { top, links } = makeList(8);
  resetFreeList(top, links, 8, 1);

  const a = popFreeIndex(top, links);
  const b = popFreeIndex(top, links);
  assert.equal(getFreeListCount(top), 6);

  pushFreeIndex(top, links, b);
  pushFreeIndex(top, links, a);
  assert.equal(getFreeListCount(top), 8);

  assert.equal(popFreeIndex(top, links), a);
  assert.equal(popFreeIndex(top, links), b);
});

test('startIndex offsets pops and pushes (entity pools)', () => {
  const { top, links } = makeList(4);
  resetFreeList(top, links, 4, 1);

  const startIndex = 100;
  const got = popFreeIndex(top, links, startIndex);
  assert.equal(got, 103);

  pushFreeIndex(top, links, got, startIndex);
  assert.equal(popFreeIndex(top, links, startIndex), 103);
});

// ---------------------------------------------------------------------------
// Multi-threaded stress: N workers hammer pop/push on a tiny pool.
// Regression test for the old counter+array free list, where a pop's payload
// read raced a concurrent push's payload write: indices were handed out twice
// (two live entities on one slot) and others leaked. The `owned` flags array
// detects double-handouts via CAS; chain integrity is verified at the end.
// ---------------------------------------------------------------------------

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  const { moduleUrl, topBuf, linksBuf, ownedBuf, iterations } = workerData;
  const { popFreeIndex, pushFreeIndex } = await import(moduleUrl);

  const top = new Int32Array(topBuf);
  const links = new Uint16Array(linksBuf);
  const owned = new Uint8Array(ownedBuf);

  let doubleHandouts = 0;
  let pops = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const idx = popFreeIndex(top, links);
    if (idx < 0) continue; // exhausted - fine under contention

    pops++;
    // Claim the slot; if someone else already holds it, the free list
    // handed the same index to two threads (the race we fixed).
    if (Atomics.compareExchange(owned, idx, 0, 1) !== 0) {
      doubleHandouts++;
      continue; // do not push back a corrupted slot twice
    }

    // Tiny variable hold time to vary interleavings
    if ((iter & 7) === 0) {
      for (let spin = 0; spin < (iter & 63); spin++);
    }

    Atomics.store(owned, idx, 0);
    pushFreeIndex(top, links, idx);
  }

  parentPort.postMessage({ doubleHandouts, pops });
})().catch((err) => {
  parentPort.postMessage({ error: String(err && err.stack ? err.stack : err) });
});
`;

async function runStress({ capacity, workers, iterations }) {
  const topBuf = new SharedArrayBuffer(8);
  const linksBuf = new SharedArrayBuffer(capacity * 2);
  const ownedBuf = new SharedArrayBuffer(capacity);

  resetFreeList(new Int32Array(topBuf), new Uint16Array(linksBuf), capacity, 1);

  const moduleUrl = new URL('../../src/core/atomicFreeList.js', import.meta.url).href;

  const results = await Promise.all(
    Array.from({ length: workers }, () => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { moduleUrl, topBuf, linksBuf, ownedBuf, iterations },
        });
        worker.once('message', (msg) => {
          worker.terminate();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg);
        });
        worker.once('error', reject);
      });
    })
  );

  const top = new Int32Array(topBuf);
  const links = new Uint16Array(linksBuf);
  const owned = new Uint8Array(ownedBuf);

  // Walk the final chain: must contain every index exactly once, no cycles.
  const seen = new Set();
  let cursor = top[0] & 0xffff;
  while (cursor !== 0) {
    const idx = cursor - 1;
    assert.ok(!seen.has(idx), `free list chain contains index ${idx} twice (corruption)`);
    seen.add(idx);
    cursor = links[idx];
  }

  return { results, top, owned, chainSize: seen.size };
}

test('MPMC stress: no double-handouts, no lost indices (ample capacity)', async () => {
  const capacity = 64;
  const { results, top, owned, chainSize } = await runStress({
    capacity,
    workers: 4,
    iterations: 50000,
  });

  let totalPops = 0;
  for (const r of results) {
    assert.equal(r.doubleHandouts, 0, 'same index handed to two threads concurrently');
    totalPops += r.pops;
  }
  assert.ok(totalPops > 0, 'stress did no work');
  assert.deepEqual(Array.from(owned), new Array(capacity).fill(0));
  assert.equal(chainSize, capacity, `free list lost ${capacity - chainSize} indices`);
  assert.equal(getFreeListCount(top), capacity);
});

test('MPMC stress: exhaustion churn (more threads than slots)', async () => {
  // Tiny pool forces constant empty-pops interleaved with pushes - the old
  // implementation corrupted its counter (negative top) in exactly this case.
  const capacity = 2;
  const { results, top, owned, chainSize } = await runStress({
    capacity,
    workers: 4,
    iterations: 50000,
  });

  for (const r of results) {
    assert.equal(r.doubleHandouts, 0, 'same index handed to two threads concurrently');
  }
  assert.deepEqual(Array.from(owned), [0, 0]);
  assert.equal(chainSize, capacity, `free list lost ${capacity - chainSize} indices`);
  assert.equal(getFreeListCount(top), capacity);
});
