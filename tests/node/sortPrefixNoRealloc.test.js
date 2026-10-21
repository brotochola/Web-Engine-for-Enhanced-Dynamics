// E-08: `_sortPrefix` sorts [0, n) and does not allocate on a steady frame.
//
// `tmp.slice(0, n)` allocated a fresh array on every frame whose light count
// was not exactly the scratch capacity. Short prefixes are insertion-sorted in
// place; long ones (the visible-light list, entity order, random in y) go
// through a stable merge sort whose scratch is grown, never reallocated per
// frame (E-08 reopened, 2026-10-21). Slots at n and past it are pooled and
// must stay put. These run on a real worker instance.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
const sortPrefix = (arr, count, compare) => pre._sortPrefix(arr, count, compare);

test('sorts a prefix and leaves the tail of `arr` untouched', () => {
  const cmp = (a, b) => a.distSq - b.distSq || a.id - b.id;
  const slots = Array.from({ length: 6 }, (_, i) => ({ id: i, distSq: (i * 37) % 11 }));
  const arr = [slots[4], slots[1], slots[5], slots[0], slots[3], slots[2]];

  sortPrefix(arr, 3, cmp);

  const head = arr.slice(0, 3);
  for (let i = 1; i < head.length; i++) {
    const p = head[i - 1];
    const c = head[i];
    assert.ok(
      p.distSq < c.distSq || (p.distSq === c.distSq && p.id <= c.id),
      `prefix not sorted at ${i}: ${p.distSq}/${p.id} then ${c.distSq}/${c.id}`,
    );
  }
  assert.equal(arr[3], slots[0]);
  assert.equal(arr[4], slots[3]);
  assert.equal(arr[5], slots[2]);
});

test('the sorted set is exactly the prefix set - nothing dropped', () => {
  const cmp = (a, b) => a.id - b.id;
  for (let n = 1; n <= 40; n++) {
    const arr = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    const wantIds = arr.slice(0, n).map((s) => s.id).sort((a, b) => a - b);
    sortPrefix(arr, n, cmp);
    const gotIds = arr.slice(0, n).map((s) => s.id);
    assert.deepEqual(gotIds, wantIds, `n=${n}: sorted set is not the prefix set`);
    for (let i = n; i < arr.length; i++) assert.equal(arr[i].id, i, `tail slot ${i} moved`);
  }
});

test('equal keys keep their order', () => {
  const cmp = (a, b) => a.distSq - b.distSq;
  const a = { id: 1, distSq: 0 };
  const b = { id: 2, distSq: 0 };
  const c = { id: 3, distSq: 0 };
  const tail = { id: 9, distSq: -1 };
  const arr = [b, a, c, tail];
  sortPrefix(arr, 3, cmp);
  assert.deepEqual(arr.slice(0, 3).map((s) => s.id), [2, 1, 3]);
  assert.equal(arr[3], tail);
});

test('in-place path when count equals the array length', () => {
  const cmp = (a, b) => a.id - b.id;
  const arr = [{ id: 3 }, { id: 1 }, { id: 2 }];
  sortPrefix(arr, 3, cmp);
  assert.deepEqual(arr.map((s) => s.id), [1, 2, 3]);
});

test('a changing count across frames still sorts only the prefix', () => {
  const cmp = (a, b) => a.id - b.id;
  for (let frame = 0; frame < 240; frame++) {
    const n = 1 + (frame * 7) % 23;
    const arr = Array.from({ length: 32 }, (_, i) => ({ id: (i * 13 + frame) % 97 }));
    const tail = arr.slice(n).map((s) => s.id);
    const want = arr.slice(0, n).map((s) => s.id).sort((a, b) => a - b);
    sortPrefix(arr, n, cmp);
    assert.deepEqual(arr.slice(0, n).map((s) => s.id), want, `frame ${frame}`);
    assert.deepEqual(arr.slice(n).map((s) => s.id), tail, `frame ${frame} tail`);
  }
});

test('a long prefix (merge path) matches the stable native sort, ties included', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (const n of [65, 100, 128, 129, 360, 1000]) {
    for (const kind of ['random', 'ties', 'sorted', 'reversed']) {
      const items = Array.from({ length: n + 5 }, (_, i) => ({
        id: i,
        y: kind === 'ties' ? (rnd() * 6) | 0 : kind === 'sorted' ? i : kind === 'reversed' ? -i : rnd() * 1000,
      }));
      const cmp = (a, b) => a.y - b.y;
      const want = items.slice(0, n).sort(cmp).map((s) => s.id);
      const tail = items.slice(n).map((s) => s.id);
      sortPrefix(items, n, cmp);
      assert.deepEqual(items.slice(0, n).map((s) => s.id), want, `n=${n} ${kind}`);
      assert.deepEqual(items.slice(n).map((s) => s.id), tail, `n=${n} ${kind} tail`);
    }
  }
});

test('steady frames do not allocate: the merge scratch is kept, short prefixes use none', () => {
  // The module is cached, so this is the same worker the tests above used.
  const fresh = pre;
  fresh._sortPrefixTmp = null;
  const cmp = (a, b) => a.y - b.y;
  const make = (n) => Array.from({ length: n + 3 }, (_, i) => ({ id: i, y: (i * 7919) % 101 }));
  fresh._sortPrefix(make(40), 40, cmp);
  assert.equal(fresh._sortPrefixTmp, null, 'insertion path needs no scratch');
  fresh._sortPrefix(make(300), 300, cmp);
  const scratch = fresh._sortPrefixTmp;
  assert.ok(Array.isArray(scratch) && scratch.length >= 300);
  for (const n of [250, 300, 120, 299, 300]) fresh._sortPrefix(make(n), n, cmp);
  assert.equal(fresh._sortPrefixTmp, scratch, 'the scratch is reused, not reallocated');
});
