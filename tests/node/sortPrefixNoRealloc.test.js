// E-08 parity test: `_sortPrefix` must produce a correctly sorted prefix without
// reallocating its scratch buffer on every frame.
//
// What changed: `tmp.length = n` on a plain Array reallocates the backing store
// whenever the value differs. `n` is the live light count, which moves frame to
// frame. The replacement sizes the scratch once and copies the prefix into a view.
//
// The risk this file guards is the classic one for a scratch buffer: a view over a
// longer backing array is NOT the same object as the array, and `Array.prototype.sort`
// on a view sorts only the view's length. If the view length and the copy length ever
// disagree, elements get silently dropped from the sorted prefix - and the consumer
// is a light list that decides which lights cast shadows, so the failure would be
// "some shadows quietly stop appearing", not a crash.
//
// E-08 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/workers/preRenderWorker.js'), 'utf8');

// The shipped implementation, extracted verbatim, so the test measures the real
// function rather than a paraphrase of it.
function extractSortPrefix() {
  const start = src.indexOf('    _sortPrefix(arr, count, compare) {');
  assert.ok(start > 0, 'could not find _sortPrefix');
  const end = src.indexOf('\n    }', start);
  assert.ok(end > start, 'could not find the end of _sortPrefix');
  const body = src.slice(start, end);
  // Bind `this` to the host worker object. The method body reads
  // `this._sortPrefixTmp`, so an unbound copy would touch the global scope and
  // never allocate the scratch - which is exactly how three of these tests first
  // failed with "scratch was never allocated".
  const raw = new Function(
    'return function (arr, count, compare) {' + body.slice(body.indexOf('{') + 1) + '};',
  )();
  return (self, arr, count, compare) => raw.call(self, arr, count, compare);
}

const sortPrefixRaw = extractSortPrefix();
const makeSortPrefix = (self) => (arr, count, compare) => sortPrefixRaw(self, arr, count, compare);

function withWorker(extra = {}) {
  return { _sortPrefixTmp: null, ...extra };
}

// --------------------------------------------------------------- behaviour ---

test('sorts a prefix and leaves the tail of `arr` untouched', () => {
  const self = withWorker();
  const sortPrefix = makeSortPrefix(self);
  const cmp = (a, b) => a.distSq - b.distSq || a.id - b.id;
  // Pooled slot objects reused across frames, exactly like _collectVisibleLights.
  const slots = Array.from({ length: 6 }, (_, i) => ({ id: i, distSq: (i * 37) % 11 }));
  const arr = [slots[4], slots[1], slots[5], slots[0], slots[3], slots[2]];

  sortPrefix(arr, 3, cmp);

  // First 3 sorted by (distSq, id).
  const head = arr.slice(0, 3);
  for (let i = 1; i < head.length; i++) {
    const p = head[i - 1];
    const c = head[i];
    assert.ok(
      p.distSq < c.distSq || (p.distSq === c.distSq && p.id <= c.id),
      `prefix not sorted at ${i}: ${p.distSq}/${p.id} then ${c.distSq}/${c.id}`,
    );
  }
  // The tail is not part of this prefix and must be preserved by identity.
  assert.equal(arr[3], slots[0]);
  assert.equal(arr[4], slots[3]);
  assert.equal(arr[5], slots[2]);
});

test('the sorted set is exactly the prefix set - nothing dropped', () => {
  // The failure mode a view introduces: sorting a window that does not match the
  // number of elements copied. Assert set equality, not order alone.
  const self = withWorker();
  const sortPrefix = makeSortPrefix(self);
  const cmp = (a, b) => a.id - b.id;
  for (let n = 1; n <= 40; n++) {
    const arr = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    const wantIds = arr.slice(0, n).map((s) => s.id).sort((a, b) => a - b);
    sortPrefix(arr, n, cmp);
    const gotIds = arr.slice(0, n).map((s) => s.id);
    assert.deepEqual(gotIds, wantIds, `n=${n}: sorted set is not the prefix set`);
  }
});

test('in-place path when count equals the array length', () => {
  const self = withWorker();
  const sortPrefix = makeSortPrefix(self);
  const cmp = (a, b) => a.id - b.id;
  const arr = [{ id: 3 }, { id: 1 }, { id: 2 }];
  sortPrefix(arr, 3, cmp);
  assert.deepEqual(arr.map((s) => s.id), [1, 2, 3]);
  // The whole-array path must not allocate scratch at all.
  assert.equal(self._sortPrefixTmp, null, 'scratch was allocated on the whole-array path');
});

test('a changing count across frames does not resize the backing store every frame', () => {
  // THE regression. `tmp.length = n` reallocated on every differing n. Geometric
  // growth still grows - that is the point - so this asserts the RATE, not that
  // growth never happens. A first version of this test forbade any growth and
  // failed on the fix that was actually correct.
  const self = withWorker();
  const sortPrefix = makeSortPrefix(self);
  const cmp = (a, b) => a.id - b.id;

  let growths = 0;
  let frames = 0;
  let lastCap = 0;
  // A light list that changes size every frame, which is the real workload.
  for (let frame = 0; frame < 240; frame++) {
    const n = 1 + (frame * 7) % 23;
    const arr = Array.from({ length: 32 }, (_, i) => ({ id: i }));
    sortPrefix(arr, n, cmp);
    const cap = self._sortPrefixTmp ? self._sortPrefixTmp.length : 0;
    if (cap > lastCap) growths++;
    lastCap = cap;
    frames++;
  }
  assert.ok(lastCap > 0, 'scratch was never allocated');
  // 240 frames of a bouncing light count. Under `tmp.length = n` this is ~230
  // reallocations; under geometric growth it is at most a handful.
  assert.ok(growths <= 3, `scratch grew ${growths} times over ${frames} frames`);
});

test('correctness holds after the scratch has grown, for every count up to capacity', () => {
  // Growing on demand must not leave a window/view longer than the copied prefix.
  const self = withWorker();
  const sortPrefix = makeSortPrefix(self);
  const cmp = (a, b) => a.id - b.id;

  // Grow it once. NOTE: n must be < arr.length or the whole-array path runs and no
  // scratch is allocated at all - which is what the first version of this test did,
  // and it failed with "Cannot read properties of null".
  const big = Array.from({ length: 200 }, (_, i) => ({ id: 199 - i }));
  sortPrefix(big, 100, cmp);
  assert.ok(self._sortPrefixTmp, 'scratch was not allocated on the prefix path');
  const capacity = self._sortPrefixTmp.length;
  assert.ok(capacity >= 100, `capacity ${capacity} < 100`);

  for (let n = 2; n <= capacity; n++) {
    const arr = Array.from({ length: capacity + 8 }, (_, i) => ({ id: i }));
    const want = arr.slice(0, n).map((s) => s.id).sort((a, b) => a - b);
    sortPrefix(arr, n, cmp);
    assert.deepEqual(arr.slice(0, n).map((s) => s.id), want, `n=${n} after growth`);
    assert.equal(self._sortPrefixTmp.length, capacity, `n=${n} resized the scratch`);
  }
});

test('a rising light count does not reallocate once it is past the initial capacity', () => {
  // The failure the first fix shipped with: growing to exactly `n` reallocated on
  // every frame where n rose. Geometric growth must allocate O(log n) times.
  const self = withWorker();
  const sortPrefix = makeSortPrefix(self);
  const cmp = (a, b) => a.id - b.id;

  const allocations = [];
  for (let n = 2; n <= 512; n++) {
    const before = self._sortPrefixTmp ? self._sortPrefixTmp.length : 0;
    const arr = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    sortPrefix(arr, n, cmp);
    const after = self._sortPrefixTmp.length;
    if (after !== before) allocations.push({ n, from: before, to: after });
  }
  // Doubling from 16 to cover 512 is at most 6 growths.
  assert.ok(
    allocations.length <= 6,
    `expected geometric growth, saw ${allocations.length}: ${JSON.stringify(allocations)}`,
  );
  // And every growth must be to a strictly larger capacity, never to exactly n.
  for (const a of allocations) {
    assert.ok(a.to > a.from, `non-monotonic growth at n=${a.n}`);
    assert.notEqual(a.to, a.n, `grew to exactly n=${a.n}; that reallocates every frame`);
  }
});

test('a second worker instance does not share scratch with the first', () => {
  // The scratch is an instance field, not a module global, so two pre-render workers
  // in one thread (lockstep, tests) must not alias each other's buffer.
  // n < arr.length on purpose: equal lengths take the whole-array path and allocate
  // nothing, which is what made the first version of this test see null on both.
  const a = withWorker();
  const b = withWorker();
  const cmp = (x, y) => x.id - y.id;
  makeSortPrefix(a)([{ id: 5 }, { id: 6 }, { id: 7 }], 2, cmp);
  assert.ok(a._sortPrefixTmp, 'first instance allocated no scratch');
  assert.equal(b._sortPrefixTmp, null, 'scratch leaked between instances');
  makeSortPrefix(b)([{ id: 9 }, { id: 8 }, { id: 7 }], 2, cmp);
  assert.notEqual(a._sortPrefixTmp, b._sortPrefixTmp);
});

// ------------------------------------------------------------ source shape ---

test('the scratch is never resized with an assignment to .length', () => {
  const body = src.slice(src.indexOf('    _sortPrefix(arr, count, compare) {'));
  const end = body.indexOf('\n    }');
  // Strip comments first. The E-08 comment quotes the old code verbatim
  // ("`tmp.length = n` was NOT a capacity hint"), so a naive scan of the body
  // matches the comment describing the bug. Both false positives in this file were
  // of that kind: a regex reading a comment, and a test hitting the other branch.
  const fn = body
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/tmp\.length\s*=(?![=\-])/.test(fn),
    '_sortPrefix still assigns to tmp.length, which reallocates the backing store',
  );
  assert.match(fn, /tmp\.length\s*</, 'capacity is never checked, so growth cannot happen');
  assert.match(fn, /while \(cap < n\) cap \*= 2/, 'growth is not geometric');
});

test('the scratch is still an Array, not a typed array with a mismatched view', () => {
  // `subarray` only exists on typed arrays; the shipped code pools JS objects, so
  // this must stay an Array + slice. A typed array here would silently coerce the
  // slot objects to numbers.
  const body = src.slice(src.indexOf('    _sortPrefix(arr, count, compare) {'));
  const fn = body.slice(0, body.indexOf('\n    }'));
  assert.match(fn, /new Array\(/, 'scratch growth no longer uses a plain Array');
  assert.ok(!/subarray\(/.test(fn), 'typed-array subarray used on a pooled-object array');
});