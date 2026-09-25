import test from 'node:test';
import assert from 'node:assert/strict';
import { bitonicSortIndices, nextPow2, permuteInstances } from '../../src/util/bitonicSort.js';
import {
  createPainterState,
  orderPainterSlots,
  radixSortIndicesBySortKey,
} from '../../src/util/sortIndexByKey.js';

function checksum(idx, n) {
  let h = 2166136261;
  for (let i = 0; i < n; i++) {
    h ^= idx[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

test('nextPow2', () => {
  assert.equal(nextPow2(0), 1);
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(2), 2);
  assert.equal(nextPow2(3), 4);
  assert.equal(nextPow2(300000), 524288);
});

test('bitonic matches radix and painter on mixed keys', () => {
  const n = 97;
  const keys = new Float32Array(n);
  for (let i = 0; i < n; i++) keys[i] = ((i * 17) % 53) - 10 + i * 0.01;
  const keysU32 = new Uint32Array(keys.buffer);
  const idxB = new Uint32Array(nextPow2(n));
  const idxR = new Uint32Array(n);
  const idxP = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    idxB[i] = i;
    idxR[i] = i;
    idxP[i] = i;
  }
  bitonicSortIndices(idxB, n, keysU32);
  const scratch = new Uint32Array(n);
  const hist = new Uint32Array(256);
  radixSortIndicesBySortKey(idxR, n, keysU32, scratch, hist);
  const painter = createPainterState(n);
  const ordered = orderPainterSlots(painter, idxP, n, keysU32);
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const id = idxB[i];
    assert.ok(id < n, `bitonic pad leaked at ${i}`);
    seen[id] = 1;
  }
  assert.equal(seen.reduce((a, b) => a + b, 0), n);
  for (let i = 1; i < n; i++) {
    const ka = keys[idxB[i - 1]];
    const kb = keys[idxB[i]];
    assert.ok(ka <= kb || Object.is(ka, kb), `bitonic not ascending at ${i}`);
  }
  assert.equal(checksum(idxB, n), checksum(idxR, n));
  assert.equal(checksum(idxB, n), checksum(ordered, n));
});

test('bitonic alreadyOrd matches floatBitsToOrd keys', () => {
  const n = 31;
  const keys = new Float32Array(n);
  for (let i = 0; i < n; i++) keys[i] = ((i * 13) % 19) - 7 + i * 0.02;
  const bits = new Uint32Array(keys.buffer);
  const ord = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const u = bits[i] >>> 0;
    ord[i] = ((u & 0x80000000) ? ~u : (u | 0x80000000)) >>> 0;
  }
  const idxA = new Uint32Array(nextPow2(n));
  const idxB = new Uint32Array(nextPow2(n));
  for (let i = 0; i < n; i++) {
    idxA[i] = i;
    idxB[i] = i;
  }
  bitonicSortIndices(idxA, n, bits);
  bitonicSortIndices(idxB, n, ord, true);
  assert.equal(checksum(idxA, n), checksum(idxB, n));
});

test('permuteInstances follows order', () => {
  const src = new Float32Array([0, 1, 10, 11, 20, 21]);
  const dst = new Float32Array(6);
  const order = new Uint32Array([2, 0, 1]);
  permuteInstances(src, dst, order, 3, 2);
  assert.deepEqual([...dst], [20, 21, 0, 1, 10, 11]);
});
