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

test('Query.bindWorker uses SAB closures instead of the main-thread system', { concurrency: false }, () => {
  Query.reset();
  Query.bindWorker({
    query: () => new Uint16Array([7, 8]),
    queryActiveEntities: () => new Uint16Array([9]),
    queryActiveEntitiesSlow: () => new Uint16Array([10, 11, 12]),
  });
  assert.deepEqual(Array.from(Query.query([])), [7, 8]);
  assert.deepEqual(Array.from(Query.queryActiveEntities([])), [9]);
  assert.deepEqual(Array.from(Query.queryActiveEntitiesSlow([])), [10, 11, 12]);
});

test('Query.reset clears worker bind and starts a fresh system', { concurrency: false }, () => {
  Query.bindWorker({
    query: () => new Uint16Array([1]),
    queryActiveEntities: () => new Uint16Array([2]),
    queryActiveEntitiesSlow: () => new Uint16Array([3]),
  });
  Query.reset();
  assert.deepEqual(Array.from(Query.query([])), []);
});
