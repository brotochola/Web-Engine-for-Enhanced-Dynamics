import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { getFreeListCount, popFl4, popIndicesFl4, pushFl4, resetFl4 } from '../../src/util/atomicFreeList.js';

// E-263: FL4 (the wide pools' and the 32-bit entity ids' free list) packs a 20-bit (index + 1) and an 11-bit tag
// (bits 20..30) with bit 31 a copy of bit 30, so its head is always in Chrome's 31-bit Smi range: with a 12-bit tag over
// bit 31, half the heads were past 2^30 and every Atomics.load and compareExchange of one returned a heap number (E-87).
// DX-ENT1M: the list holds 1 048 575 slots, every one handed out once.

const N = (1 << 20) - 1;

function makeList(n) {
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint32Array(new SharedArrayBuffer(n * 4));
  return { top, links };
}

test('FL4 at 1 048 575 slots: the head stays a Smi through full tag wraps, every 11-bit tag used', () => {
  const { top, links } = makeList(N);
  resetFl4(top, links, N, 8);
  const tags = new Set();
  const check = () => {
    const head = top[0];
    assert.ok(head >= -(2 ** 30) && head < 2 ** 30, `head ${head} is not a Smi`);
    assert.equal((head >> 30) & 1, (head >>> 31) & 1, 'bit 31 copies bit 30');
    tags.add((head >>> 20) & 0x7ff);
  };
  check();
  const first = popFl4(top, links, 0);
  pushFl4(top, links, first, 0);
  // 9 000 pops and pushes wrap the tag (2 048 values) more than eight times; the slot on top is always the same one.
  for (let k = 0; k < 4500; k++) {
    const i = popFl4(top, links, 0);
    assert.equal(i, first);
    check();
    pushFl4(top, links, i, 0);
    check();
  }
  // The batch pop steps the tag as one operation, through the same arithmetic.
  const out = new Uint32Array(64);
  for (let k = 0; k < 2100; k++) {
    assert.equal(popIndicesFl4(top, links, 64, out, 0, 0), 64);
    check();
    for (let j = 63; j >= 0; j--) pushFl4(top, links, out[j], 0);
  }
  assert.equal(tags.size, 2048, 'every 11-bit tag is used');
  assert.equal(getFreeListCount(top), N);
});

test('FL4 hands out each of 1 048 575 slots once, then none; pushed slots come back last in, first out', () => {
  const { top, links } = makeList(N);
  resetFl4(top, links, N, 8);
  const seen = new Uint8Array(N);
  const start = 3;
  for (let k = 0; k < N; k++) {
    const i = popFl4(top, links, start);
    assert.ok(i >= start && i < start + N, `pop ${k}: ${i}`);
    if (seen[i - start]) assert.fail(`slot ${i} handed out twice`);
    seen[i - start] = 1;
    const head = top[0];
    if (!(head >= -(2 ** 30) && head < 2 ** 30)) assert.fail(`head ${head} after pop ${k} is not a Smi`);
  }
  assert.equal(popFl4(top, links, start), -1);
  assert.equal(getFreeListCount(top), 0);
  // The last slots: 1 048 574 (local), the interleave's last chain, and 0.
  for (const local of [N - 1, 524287, 524288, 0]) pushFl4(top, links, start + local, start);
  assert.equal(getFreeListCount(top), 4);
  assert.deepEqual([0, 1, 2, 3].map(() => popFl4(top, links, start)), [start, start + 524288, start + 524287, start + N - 1]);
  assert.equal(popFl4(top, links, start), -1);
});

// Several threads pop and push one wide list (Uint32 links, a 16-byte head): no slot is handed to two threads at once
// and none is lost, with the tag stepping through its wraps many times (200 000 operations).
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { moduleUrl, topBuf, linksBuf, ownedBuf, iterations } = workerData;
  const { popFl4, pushFl4, popIndicesFl4 } = await import(moduleUrl);
  const top = new Int32Array(topBuf);
  const links = new Uint32Array(linksBuf);
  const owned = new Uint8Array(ownedBuf);
  const batch = new Uint32Array(3);
  let doubleHandouts = 0;
  let notSmi = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const head = Atomics.load(top, 0);
    if (head >= 1073741824 || head < -1073741824) notSmi++;
    if ((iter & 15) === 0) {
      const got = popIndicesFl4(top, links, 3, batch, 0, 0);
      for (let k = 0; k < got; k++) {
        if (Atomics.compareExchange(owned, batch[k], 0, 1) !== 0) doubleHandouts++;
      }
      for (let k = got - 1; k >= 0; k--) {
        Atomics.store(owned, batch[k], 0);
        pushFl4(top, links, batch[k], 0);
      }
      continue;
    }
    const idx = popFl4(top, links, 0);
    if (idx < 0) continue;
    if (Atomics.compareExchange(owned, idx, 0, 1) !== 0) {
      doubleHandouts++;
      continue;
    }
    if ((iter & 7) === 0) for (let spin = 0; spin < (iter & 63); spin++);
    Atomics.store(owned, idx, 0);
    pushFl4(top, links, idx, 0);
  }
  parentPort.postMessage({ doubleHandouts, notSmi });
})().catch((err) => parentPort.postMessage({ error: String(err && err.stack ? err.stack : err) }));
`;

test('FL4 under four threads: no double handouts, no lost slots, every head a Smi', async () => {
  const capacity = 48;
  const topBuf = new SharedArrayBuffer(16);
  const linksBuf = new SharedArrayBuffer(capacity * 4);
  const ownedBuf = new SharedArrayBuffer(capacity);
  resetFl4(new Int32Array(topBuf), new Uint32Array(linksBuf), capacity, 1);
  const moduleUrl = new URL('../../src/util/atomicFreeList.js', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { moduleUrl, topBuf, linksBuf, ownedBuf, iterations: 50000 } });
    worker.once('message', (msg) => {
      worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    worker.once('error', reject);
  })));
  for (const r of results) {
    assert.equal(r.doubleHandouts, 0, 'a slot handed to two threads at once');
    assert.equal(r.notSmi, 0, 'a head outside the Smi range');
  }
  const top = new Int32Array(topBuf);
  const links = new Uint32Array(linksBuf);
  const seen = new Set();
  let cursor = top[0] & ((1 << 20) - 1);
  while (cursor !== 0) {
    assert.ok(!seen.has(cursor - 1), `slot ${cursor - 1} twice in the chain`);
    seen.add(cursor - 1);
    cursor = links[cursor - 1];
  }
  assert.equal(seen.size, capacity);
  assert.equal(getFreeListCount(top), capacity);
});
