import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import {
  removeFromActiveEntities,
  removeFromTypeActiveList,
  removeSortedFromActiveList,
} from '../../src/util/gameObjectActiveState.js';
import { loadWorker } from '../bench/workerHarness.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

// E-344. logic0 took each despawn out of activeEntitiesData and its type's list with a copyWithin of the
// rest; it now sorts the batch and compacts each list once. The lists are sorted by entity index and
// stay so, so the final content and order must be exactly what the per-entity removals left: the same
// entities, ascending (logic's tick order, the type lists the tick buckets are built from, what spatial,
// pre-render and the query publish read). The reference below is the old loop on the shipped
// single-removal functions.

function sortedList(Type, values, extra = 0) {
  const uniq = [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const list = new Type(1 + uniq.length + extra);
  list[0] = uniq.length;
  for (let i = 0; i < uniq.length; i++) list[1 + i] = uniq[i];
  return list;
}

function live(list) {
  return Array.from(list.subarray(1, 1 + list[0]));
}

test('one compaction leaves what one removal per index left', () => {
  const rng = mulberry32(0xe344);
  for (let round = 0; round < 400; round++) {
    const size = (rng() * 300) | 0;
    const values = [];
    for (let i = 0; i < size; i++) values.push((rng() * 1000) | 0);
    const Type = round % 2 ? Uint32Array : Uint16Array;
    const a = sortedList(Type, values, 3);
    const b = a.slice();
    // A batch: listed entries (the first and the last often), absent ones, repeats.
    const batch = [];
    const d = (rng() * 40) | 0;
    for (let k = 0; k < d; k++) {
      const r = rng();
      if (r < 0.1 && a[0] > 0) batch.push(a[1]);
      else if (r < 0.2 && a[0] > 0) batch.push(a[a[0]]);
      else if (r < 0.7 && a[0] > 0) batch.push(a[1 + ((rng() * a[0]) | 0)]);
      else batch.push((rng() * 1000) | 0);
      if (rng() < 0.15) batch.push(batch[batch.length - 1]);
    }
    for (const e of batch) removeFromActiveEntities(a, e);
    const sorted = Int32Array.from(batch).sort();
    removeSortedFromActiveList(b, sorted, sorted.length);
    assert.deepEqual(live(b), live(a), `round ${round}`);
    assert.equal(b[0], a[0]);
  }
});

test('compaction edge cases: empty list, empty batch, everything, nothing listed, null list', () => {
  const empty = new Uint16Array(4);
  removeSortedFromActiveList(empty, Int32Array.of(1, 2), 2);
  assert.equal(empty[0], 0);

  const list = sortedList(Uint16Array, [3, 5, 9]);
  removeSortedFromActiveList(list, new Int32Array(0), 0);
  assert.deepEqual(live(list), [3, 5, 9]);
  removeSortedFromActiveList(list, Int32Array.of(1, 4, 10), 3);
  assert.deepEqual(live(list), [3, 5, 9], 'nothing listed: nothing moves');
  removeSortedFromActiveList(list, Int32Array.of(3, 5, 5, 9), 4);
  assert.deepEqual(live(list), []);
  removeSortedFromActiveList(null, Int32Array.of(1), 1);
});

const N = 600;

class CompactA extends GameObject {}
class CompactB extends GameObject {}
class CompactC extends GameObject {}
class CompactNoList extends GameObject {}
const CLASSES = [CompactA, CompactB, CompactC];

function classOf(e) {
  return CLASSES[e % 3];
}

function setup() {
  const all = [];
  for (let e = 0; e < N; e++) if (e % 7 !== 3) all.push(e);
  GameObject.activeEntitiesData = sortedList(Uint16Array, all);
  CLASSES.forEach((C, t) => {
    C.entityType = t;
    C._activeList = sortedList(Uint16Array, all.filter((e) => e % 3 === t));
  });
  CompactNoList.entityType = 3;
  CompactNoList._activeList = null;
  GameObject.typeListVersions = new Int32Array(new SharedArrayBuffer(16));
  Transform.active = new Uint8Array(N).fill(1);
}

/** The per-entity pass E-344 replaced, on the shipped single removals. */
function referencePass(idx, classes, n) {
  for (let i = 0; i < n; i++) {
    const e = idx[i];
    if (Transform.active[e] === 1) continue;
    removeFromActiveEntities(GameObject.activeEntitiesData, e);
    removeFromTypeActiveList(classes[i]._activeList, e);
  }
}

function snapshot() {
  return {
    active: live(GameObject.activeEntitiesData),
    types: CLASSES.map((C) => live(C._activeList)),
  };
}

test('the despawn pass leaves the lists the per-entity pass left, sorted, and moves each touched version', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const rng = mulberry32(0x344);
  const saved = {
    active: GameObject.activeEntitiesData,
    versions: GameObject.typeListVersions,
    transformActive: Transform.active,
  };
  try {
    for (let round = 0; round < 60; round++) {
      // Batches of 1 (the single path), around the queue's 256 and past it (the queue grows).
      const d = round % 6 === 0 ? 1 : round % 6 === 1 ? 300 : 1 + ((rng() * 120) | 0);
      const batch = [];
      for (let k = 0; k < d; k++) {
        const e = (rng() * N) | 0;
        // Mostly the entity's class; sometimes another (a reused index queued under its old class) or a class
        // without a list.
        const r = rng();
        const C = r < 0.85 ? classOf(e) : r < 0.95 ? CLASSES[(rng() * 3) | 0] : CompactNoList;
        batch.push([e, C]);
        if (rng() < 0.1) batch.push([e, C]);
      }
      // Despawned, except a few alive again (a reused index whose new life is already listed: skipped).
      setup();
      for (const [e] of batch) Transform.active[e] = 0;
      const alive = new Set();
      for (const [e] of batch) if (rng() < 0.1) alive.add(e);
      for (const e of alive) Transform.active[e] = 1;

      const idx = Int32Array.from(batch, ([e]) => e);
      const classes = batch.map(([, C]) => C);
      referencePass(idx, classes, idx.length);
      const want = snapshot();

      setup();
      for (const [e] of batch) Transform.active[e] = 0;
      for (const e of alive) Transform.active[e] = 1;
      const before = Array.from(GameObject.typeListVersions);
      for (const [e, C] of batch) worker.queueDespawnListUpdate(e, C.entityType, C);
      worker._processDespawnSoA(worker._despawnIdx, worker._despawnClass, worker._despawnN);
      worker._despawnN = 0;
      const got = snapshot();

      assert.deepEqual(got.active, want.active, `round ${round}: activeEntitiesData`);
      got.types.forEach((list, t) => assert.deepEqual(list, want.types[t], `round ${round}: type ${t}`));
      for (const list of [got.active, ...got.types]) {
        for (let i = 1; i < list.length; i++) assert.ok(list[i - 1] < list[i], `round ${round}: sorted and unique`);
      }
      // A type whose entity left moved its version (logic1 rebuilds its tick buckets from it).
      CLASSES.forEach((C, t) => {
        const queued = batch.some(([e, BC]) => BC === C && !alive.has(e));
        if (queued) assert.notEqual(GameObject.typeListVersions[t], before[t], `round ${round}: type ${t} version`);
      });
    }
  } finally {
    GameObject.activeEntitiesData = saved.active;
    GameObject.typeListVersions = saved.versions;
    Transform.active = saved.transformActive;
  }
});
