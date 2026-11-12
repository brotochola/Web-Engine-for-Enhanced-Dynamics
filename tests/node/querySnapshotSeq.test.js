import test from 'node:test';
import assert from 'node:assert/strict';

import { QuerySystem, QUERY_SNAPSHOT_COUNT, calculateQueryResultsSABSize } from '../../src/core/querySystem.js';
import { GameObject } from '../../src/core/gameObject.js';
import { writeCollectList } from '../../src/workers/preRenderCollectClient.js';

// E-217: the sprite query's published list was copied into the collect's memory every frame (200 000 ids in BunnyMark),
// though logic republishes it only when the population changes. A publish sequence in the query header lets the reader
// hand back the same view while nothing was published, and the collect keeps the copy it holds of that view. The index
// alone comes back round after QUERY_SNAPSHOT_COUNT publishes, with the same count when the churn evens out.

class CompA {}
CompA.componentId = 0;
class TypeA {}

function setup(ids) {
  const list = new Uint16Array(new SharedArrayBuffer(2 * 65));
  const setIds = (next) => {
    list[0] = next.length;
    list.set(next, 1);
  };
  setIds(ids);
  TypeA._activeList = list;
  const qs = new QuerySystem();
  qs.entityMetadata = [
    { entityType: 0, className: 'TypeA', entityClass: TypeA, componentMask: 1n, startIndex: 0, endIndex: 64, poolSize: 64 },
  ];
  qs.precomputedQueries = [{ name: 'CompA', queryMask: 1n, typeMask: 1n, resultOffset: 0 }];
  qs.queryMaskToIndex.set(1n, 0);
  qs.queryEntityCapacity = 64;
  qs.queryResultsSAB = new SharedArrayBuffer(calculateQueryResultsSABSize(1, 64));
  qs._initializeQueryResultViews();
  GameObject.activeEntitiesData = new Uint16Array([0]);
  return { qs, setIds, read: () => qs.queryActiveEntities([CompA]) };
}

test('no publish: the same view back; a publish: a new one', () => {
  const { qs, setIds, read } = setup([1, 2, 3]);
  qs.publishPrecomputedActiveQueries(1);
  const a = read();
  assert.deepEqual(Array.from(a), [1, 2, 3]);
  assert.equal(read(), a, 'nothing published');
  setIds([1, 2, 3, 4]);
  qs.publishPrecomputedActiveQueries(2);
  const b = read();
  assert.notEqual(b, a);
  assert.deepEqual(Array.from(b), [1, 2, 3, 4]);
});

test('the index back round with the same count is a new view, with the new ids', () => {
  const { qs, setIds, read } = setup([1, 2, 3]);
  qs.publishPrecomputedActiveQueries(1);
  const a = read();
  for (let i = 0; i < QUERY_SNAPSHOT_COUNT; i++) {
    setIds(i === QUERY_SNAPSHOT_COUNT - 1 ? [7, 8, 9] : [1, 2]);
    qs.publishPrecomputedActiveQueries(2 + i);
  }
  const b = read();
  assert.notEqual(b, a, 'same index, same count, other ids');
  assert.deepEqual(Array.from(b), [7, 8, 9]);
});

function collectBinding() {
  const buffer = new ArrayBuffer(4 * 80);
  return { table: new Uint32Array(buffer, 0, 16), list: new Uint32Array(buffer, 64, 64), listByte: 64, listIds: null, listCount: 0 };
}

test('the collect keeps its copy of an unchanged published view and copies a changed one', () => {
  const { qs, setIds, read } = setup([1, 2, 3]);
  qs.publishPrecomputedActiveQueries(1);
  const b = collectBinding();
  assert.equal(writeCollectList(b, read(), read().length, true), 3);
  assert.deepEqual(Array.from(b.list.subarray(0, 3)), [1, 2, 3]);
  b.list[0] = 99; // a copy would put 1 back
  writeCollectList(b, read(), read().length, true);
  assert.equal(b.list[0], 99, 'kept');
  setIds([5, 6]);
  qs.publishPrecomputedActiveQueries(2);
  assert.equal(writeCollectList(b, read(), read().length, true), 2);
  assert.deepEqual(Array.from(b.list.subarray(0, 2)), [5, 6]);
  assert.equal(b.table[0] !== undefined, true);
});

test('another list over the copy: the next published view is copied again', () => {
  const { qs, read } = setup([1, 2, 3]);
  qs.publishPrecomputedActiveQueries(1);
  const b = collectBinding();
  const ids = read();
  writeCollectList(b, ids, ids.length, true);
  const walk = new Uint32Array([40, 41, 42, 43]);
  writeCollectList(b, walk, 4);
  writeCollectList(b, ids, ids.length, true);
  assert.deepEqual(Array.from(b.list.subarray(0, 3)), [1, 2, 3], 'the query view, not the walk');
  // The same walk object with other contents is copied each time.
  walk[0] = 50;
  writeCollectList(b, walk, 4);
  assert.equal(b.list[0], 50);
});
