// E-08: `_sortPrefix` sorts [0, n) and does not allocate to do it.
//
// `tmp.slice(0, n)` allocated a fresh array on every frame whose light count
// was not exactly the scratch capacity. The prefix is sorted in place.
// Slots at n and past it are pooled and must stay put.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/workers/preRenderWorker.js'), 'utf8');

function extractSortPrefix() {
  const start = src.indexOf('    _sortPrefix(arr, count, compare) {');
  assert.ok(start > 0, 'could not find _sortPrefix');
  const end = src.indexOf('\n    }', start);
  assert.ok(end > start, 'could not find the end of _sortPrefix');
  const body = src.slice(start, end);
  const raw = new Function(
    'return function (arr, count, compare) {' + body.slice(body.indexOf('{') + 1) + '};',
  )();
  return (arr, count, compare) => raw.call({}, arr, count, compare);
}

const sortPrefix = extractSortPrefix();

function fnSource() {
  const body = src.slice(src.indexOf('    _sortPrefix(arr, count, compare) {'));
  const end = body.indexOf('\n    }');
  return body
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

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

test('the prefix path does not allocate', () => {
  const fn = fnSource();
  assert.ok(!/\.slice\(/.test(fn), '_sortPrefix still slices a view');
  assert.ok(!/new Array\(/.test(fn), '_sortPrefix still allocates a scratch array');
  assert.ok(!/_sortPrefixTmp/.test(fn), '_sortPrefix still keeps a scratch');
  assert.match(fn, /compare\(arr\[j\], item\) > 0/, 'ties must not reorder');
});
