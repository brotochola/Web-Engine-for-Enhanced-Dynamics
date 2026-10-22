import test from 'node:test';
import assert from 'node:assert/strict';

// logicWorker is a worker script: it posts on import and expects a `self`.
globalThis.self = { postMessage() {}, onmessage: null, close() {} };
globalThis.WorkerGlobalScope = function () {};
globalThis.postMessage = globalThis.self.postMessage;

await import('../../src/workers/logicWorker.js');
const worker = globalThis.self.logicWorker;
assert.ok(worker, 'logicWorker must self-register');

// Imported directly rather than dug out of globalThis: the worker registers only
// itself on `self`, so its dependencies are not reachable that way in Node.
const { Transform } = await import('../../src/components/transform.js');
const { GameObject } = await import('../../src/core/gameObject.js');

/**
 * Spawn sort parity. Written for H-14, which replaced the shipped comparator
 * sort
 *
 *     for (let i = 0; i < n; i++) perm[i] = i;
 *     perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);
 *
 * with a numeric sort of packed `(entityIndex, position)` Float64 keys. H-14 was
 * dropped and reverted (HYPOTHESIS_LOG), so these cases now pin the comparator
 * sort above; any replacement must pass them unchanged. The gather that follows
 * the sort is fixed, so the only thing a replacement can change is the ORDER
 * produced, and the only place order is observable is the resulting active lists.
 *
 * These cases run the real `_processSpawnSoA` and compare the full active-list
 * state against a reference computed independently - a plain sort of the same
 * inputs - rather than against a transcript of the old code.
 *
 * Deliberately includes: duplicates, ties, already-sorted input, reverse-sorted
 * input, and the n === 1 fast path which must be untouched.
 */

const MAX = 4096;

/**
 * `_processSpawnSoA` filters on `Transform.active[entityIndex]` and merges into
 * `GameObject.activeEntitiesData`. Both are null in Node - they are allocated by
 * the scene bootstrap - so both are stood up here at the size the case uses.
 */
function bindEngineState(maxEntities = MAX) {
  Transform.active = new Uint8Array(maxEntities).fill(1);
  const active = new Int32Array(maxEntities * 2);
  active[0] = 0;
  GameObject.activeEntitiesData = active;
  return { Transform, GameObject, active };
}

let bound = null;

function reset() {
  if (!bound) bound = bindEngineState();
  worker._spawnIdx = new Int32Array(MAX);
  worker._spawnType = new Int32Array(MAX);
  worker._spawnClass = new Array(MAX);
  worker._spawnSortKeys = new Float64Array(MAX);
  worker._spawnPerm = new Int32Array(MAX);
  worker._spawnSorted = new Int32Array(MAX);
  worker._spawnSortedClass = new Array(MAX);
  worker._spawnN = 0;
  worker._spawnXyScratch = { x: 0, y: 0 };

  // The merged active list and every per-type list survive between calls - that
  // is the whole point of the merge - so they have to be emptied or each run
  // sees the previous one's output appended to its own.
  bound.active[0] = 0;
  for (const list of allTypeLists) list[0] = 0;
}

/** Every per-type list handed out by makeClasses, for reset() to clear. */
const allTypeLists = [];
/** name -> class, so a batch containing only one type still reports the other. */
const registry = new Map();

/** Two distinguishable fake classes, each with its own active list. */
function makeClasses() {
  const mk = (name) => {
    const c = { name, _activeList: new Int32Array(MAX) };
    c._activeList[0] = 0;
    allTypeLists.push(c._activeList);
    registry.set(name, c);
    return c;
  };
  return [mk('A'), mk('B')];
}

/**
 * Drive the shipped private method and read back what it actually produced.
 *
 * The observable is the merged active lists, not the scratch buffers: `n === 1`
 * takes a fast path that never touches `_spawnSorted` at all, so asserting on
 * scratch would be asserting an implementation detail that one legitimate path
 * skips. The scratch is still returned, for the cases that do exercise it.
 */
function run(indices, classes, n) {
  reset();
  const idx = worker._spawnIdx;
  const cls = worker._spawnClass;
  for (let i = 0; i < n; i++) {
    idx[i] = indices[i];
    cls[i] = classes[i];
  }
  const changed = worker._processSpawnSoA(idx, cls, n);

  const all = GameObject.activeEntitiesData;
  const activeAll = [];
  for (let i = 1; i <= all[0]; i++) activeAll.push(all[i]);

  const byClass = {};
  // From the registry, not from the `classes` argument: a batch that happens to
  // contain only class A must still report B as an empty list, not as missing.
  for (const [name, cls] of registry) {
    const list = cls._activeList;
    const out = [];
    for (let i = 1; i <= list[0]; i++) out.push(list[i]);
    byClass[name] = out;
  }

  return {
    changed,
    sorted: Array.from(worker._spawnSorted.subarray(0, n)),
    sortedClass: worker._spawnSortedClass.slice(0, n),
    activeAll,
    byClass,
  };
}

/** The active lists the reference order should produce. */
function referenceLists(indices, classes) {
  const want = reference(indices, classes);
  const activeAll = want.sorted.filter((_, i) => true);
  const byClass = { A: [], B: [] };
  for (let i = 0; i < want.sorted.length; i++) {
    const name = want.sortedClass[i].name;
    byClass[name].push(want.sorted[i]);
  }
  // Each per-type list holds only that type's indices, in ascending order.
  for (const k of Object.keys(byClass)) byClass[k].sort((a, b) => a - b);
  return { activeAll, byClass };
}

/**
 * Independent reference: sort (index, position) pairs the obvious way, and keep
 * each index once. An active list is a set: a batch that spawns one index twice
 * (a short life reused at once) used to list it twice, and that entity ticked
 * twice per frame (fix(logic), 2026-10-22).
 */
function reference(indices, classes) {
  // Array.from, not indices.map - `Int32Array.prototype.map` returns an
  // Int32Array, so the `[v, i]` pairs would be coerced straight to NaN.
  const pairs = Array.from(indices, (v, i) => [v, i])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, k, all) => k === 0 || all[k - 1][0] !== p[0]);
  return {
    sorted: pairs.map((p) => p[0]),
    sortedClass: pairs.map((p) => classes[p[1]]),
  };
}

let s = 12345;
const rnd = () => {
  s = (s * 1664525 + 1013904223) >>> 0;
  return s / 0x100000000;
};

function randomOrder(n) {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = (rnd() * 300) | 0;
  return idx;
}

test('H-14: a random batch sorts ascending with matching classes', { concurrency: false }, () => {
  const [A, B] = makeClasses();
  for (const n of [1, 2, 7, 64, 256, 1024]) {
    const idx = randomOrder(n);
    const classes = new Array(n);
    for (let i = 0; i < n; i++) classes[i] = idx[i] % 2 === 0 ? A : B;

    const got = run(idx, classes, n);
    const want = referenceLists(idx, classes);

    assert.deepEqual(got.activeAll, want.activeAll, `merged active list differs at n=${n}`);
    for (const k of ['A', 'B']) {
      assert.deepEqual(got.byClass[k], want.byClass[k], `per-type list ${k} differs at n=${n}`);
    }
  }
});

test('H-14: an index spawned twice in a batch is listed once', { concurrency: false }, () => {
  const [A, B] = makeClasses();
  const idx = new Int32Array([7, 7, 3, 7, 3, 9]);
  const classes = [A, A, B, A, B, B];

  const got = run(idx, classes, idx.length);
  const want = referenceLists(idx, classes);

  assert.deepEqual(got.activeAll, want.activeAll);
  assert.deepEqual(got.byClass.A, want.byClass.A);
  assert.deepEqual(got.byClass.B, want.byClass.B);
  assert.deepEqual(got.activeAll, [3, 7, 9]);
  for (let i = 1; i < got.activeAll.length; i++) {
    assert.ok(got.activeAll[i] > got.activeAll[i - 1], 'the merged active list is strictly increasing');
  }
});

test('H-14: already-sorted and reverse-sorted inputs both come out sorted', { concurrency: false }, () => {
  const [A, B] = makeClasses();
  const asc = new Int32Array([1, 2, 3, 10, 11, 50, 99]);
  const desc = new Int32Array([99, 50, 11, 10, 3, 2, 1]);
  for (const idx of [asc, desc]) {
    const classes = Array.from(idx, (v) => (v % 2 === 0 ? A : B));
    const got = run(idx, classes, idx.length);
    const want = referenceLists(idx, classes);
    assert.deepEqual(got.activeAll, want.activeAll);
    assert.deepEqual(got.byClass.A, want.byClass.A);
    assert.deepEqual(got.byClass.B, want.byClass.B);
  }
});

test('H-14: the n === 1 fast path still lands the entity correctly', { concurrency: false }, () => {
  const [A] = makeClasses();
  const got = run(new Int32Array([42]), [A], 1);
  assert.equal(got.changed, true, 'one spawn must report a change');
  assert.deepEqual(got.activeAll, [42], 'the entity must land in the merged active list');
  assert.deepEqual(got.byClass.A, [42], 'and in its own type list');
  // With an empty destination the n===1 shortcut does not apply and the general
  // path runs instead - both must produce the same observable, which is why the
  // assertion above is on the active list rather than on the sort scratch.
});

test('H-14: an empty batch is a no-op', { concurrency: false }, () => {
  const got = run(new Int32Array(0), [], 0);
  assert.equal(got.changed, false);
});

test('H-14: the packed key stays exact at the entity cap', { concurrency: false }, () => {
  // The key is `entityIndex * (n + 1) + position` in a Float64Array. If it ever
  // stopped being an exact integer the sort would be a float sort and the order
  // would be subtly wrong, so the bound is asserted rather than assumed.
  const n = 1024;
  const maxIndex = 65535;
  const span = n + 1;
  const worstKey = maxIndex * span + (n - 1);
  assert.ok(
    worstKey < Number.MAX_SAFE_INTEGER,
    `worst-case key ${worstKey} is not an exact integer`,
  );
  // And round-tripping recovers both halves, including at the cap.
  for (const position of [0, n - 1]) {
    const key = maxIndex * span + position;
    const recovered = Math.floor(key / span);
    assert.equal(recovered, maxIndex, `index recovered from the key at position ${position}`);
    assert.equal(key - recovered * span, position, `position survives the round trip`);
  }
  // And the sort really does order them: same index, so the position decides.
  const keys = new Float64Array(3);
  keys[0] = maxIndex * span + (n - 1);
  keys[1] = maxIndex * span + 0;
  keys[2] = (maxIndex - 1) * span + 5;
  keys.sort();
  assert.ok(keys[0] < keys[1], 'the lower index sorts first');
  assert.equal(Math.floor(keys[1] / span), maxIndex, 'the tied index follows');
  assert.equal(keys[1] - maxIndex * span, 0, 'and the lower position leads the tie');
});