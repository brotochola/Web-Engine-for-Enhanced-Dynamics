import test from 'node:test';
import assert from 'node:assert/strict';
import { Query } from '../../src/core/query.js';

class QueryTestComponentA {}
QueryTestComponentA.componentId = 0;

class QueryTestComponentB {}
QueryTestComponentB.componentId = 1;

test('Query.queryActiveEntities throws when the pair is not precomputed', { concurrency: false }, () => {
  Query.reset();
  assert.throws(
    () => Query.queryActiveEntities([QueryTestComponentA, QueryTestComponentB]),
    /queryActiveEntities\(\[QueryTestComponentA, QueryTestComponentB\]\) is not precomputed/
  );
});

test('Query calls the system it is bound to (a worker\'s QuerySystem.fromSerialized, or a stand-in)', { concurrency: false }, () => {
  Query.reset();
  Query.bindSystem({
    query: () => new Uint16Array([7, 8]),
    queryActiveEntities: () => new Uint16Array([9]),
    queryActiveEntitiesSlow: () => new Uint16Array([10, 11, 12]),
  });
  assert.deepEqual(Array.from(Query.query([])), [7, 8]);
  assert.deepEqual(Array.from(Query.queryActiveEntities([])), [9]);
  assert.deepEqual(Array.from(Query.queryActiveEntitiesSlow([])), [10, 11, 12]);
});

test('Query.reset drops the bound system and starts a fresh one', { concurrency: false }, () => {
  Query.bindSystem({
    query: () => new Uint16Array([1]),
    queryActiveEntities: () => new Uint16Array([2]),
    queryActiveEntitiesSlow: () => new Uint16Array([3]),
  });
  Query.reset();
  assert.deepEqual(Array.from(Query.query([])), []);
});
