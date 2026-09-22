import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ownsEntity,
  listSlice,
  prefixAt,
  sumCounts,
  ownedStampMatches,
  fillOwnedIds,
} from '../../src/util/preRenderOwner.js';

test('N=1 owns every entity and the full list', () => {
  for (let i = 0; i < 64; i++) {
    assert.equal(ownsEntity(i, 0, 1, 256), true);
  }
  assert.deepEqual(listSlice(10, 0, 1), { start: 0, end: 10 });
  assert.equal(prefixAt([10], 0), 0);
  assert.equal(sumCounts([10], 1), 10);
});

test('each entity has one owner and blocks stay together', () => {
  const n = 4;
  const block = 256;
  const seen = new Uint8Array(n);
  for (let id = 0; id < 2000; id++) {
    let owners = 0;
    for (let w = 0; w < n; w++) {
      if (ownsEntity(id, w, n, block)) owners++;
    }
    assert.equal(owners, 1, `entity ${id}`);
    seen[(id / block | 0) % n] = 1;
  }
  for (let w = 0; w < n; w++) assert.equal(seen[w], 1);
  assert.equal(ownsEntity(0, 0, n, block), true);
  assert.equal(ownsEntity(255, 0, n, block), true);
  assert.equal(ownsEntity(256, 1, n, block), true);
});

test('owned ids are rebuilt only when the published frame changes', () => {
  const src = [0, 1, 256, 257, 512];
  const dest = new Uint32Array(src.length);
  const n = fillOwnedIds(src, src.length, dest, 0, 2, 256);
  assert.equal(n, 3);
  assert.deepEqual(Array.from(dest.subarray(0, n)), [0, 1, 512]);

  let stamp = -1;
  const published = 4;
  assert.equal(ownedStampMatches(stamp, published), false);
  stamp = published;
  assert.equal(ownedStampMatches(stamp, published), true);
  assert.equal(fillOwnedIds(src, src.length, dest, 0, 2, 256), n);
  assert.equal(ownedStampMatches(stamp, published + 1), false);
});

test('list slices cover the list once and prefixes have no holes', () => {
  const n = 4;
  const count = 10;
  let covered = 0;
  let prevEnd = 0;
  for (let w = 0; w < n; w++) {
    const { start, end } = listSlice(count, w, n);
    assert.equal(start, prevEnd);
    assert.ok(end >= start);
    covered += end - start;
    prevEnd = end;
  }
  assert.equal(covered, count);
  assert.equal(prevEnd, count);

  const counts = [2, 3, 0, 4];
  assert.equal(prefixAt(counts, 0), 0);
  assert.equal(prefixAt(counts, 1), 2);
  assert.equal(prefixAt(counts, 2), 5);
  assert.equal(prefixAt(counts, 3), 5);
  assert.equal(sumCounts(counts, 4), 9);
  for (let w = 0; w < 3; w++) {
    assert.equal(prefixAt(counts, w + 1), prefixAt(counts, w) + counts[w]);
  }
});
