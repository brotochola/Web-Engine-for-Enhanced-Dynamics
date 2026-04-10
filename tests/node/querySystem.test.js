import test from 'node:test';
import assert from 'node:assert/strict';

import { QuerySystem, createWorkerQueryFunctions } from '../../src/core/QuerySystem.js';
import { GameObject } from '../../src/core/gameObject.js';

class QueryTestComponentA {}
QueryTestComponentA.componentId = 0;

class QueryTestComponentB {}
QueryTestComponentB.componentId = 1;

function createUint16View(values) {
  const sab = new SharedArrayBuffer(values.length * Uint16Array.BYTES_PER_ELEMENT);
  const view = new Uint16Array(sab);
  view.set(values);
  return view;
}

function createFallbackMetadata() {
  return [
    {
      entityType: 0,
      className: 'QueryTestEnemy',
      componentMask: 3n,
      startIndex: 0,
      endIndex: 1000,
      poolSize: 1000,
    },
    {
      entityType: 1,
      className: 'QueryTestBoss',
      componentMask: 3n,
      startIndex: 1000,
      endIndex: 2000,
      poolSize: 1000,
    },
    {
      entityType: 2,
      className: 'QueryTestProp',
      componentMask: 1n,
      startIndex: 2000,
      endIndex: 3000,
      poolSize: 1000,
    },
  ];
}

function installWorkerActiveListGlobals() {
  const previous = {
    enemy: globalThis.QueryTestEnemy,
    boss: globalThis.QueryTestBoss,
    prop: globalThis.QueryTestProp,
  };

  class QueryTestEnemy {}
  class QueryTestBoss {}
  class QueryTestProp {}

  QueryTestEnemy._activeList = createUint16View([3, 2, 7, 999]);
  QueryTestBoss._activeList = createUint16View([2, 1001, 1500]);
  QueryTestProp._activeList = createUint16View([2, 2001, 2050]);

  globalThis.QueryTestEnemy = QueryTestEnemy;
  globalThis.QueryTestBoss = QueryTestBoss;
  globalThis.QueryTestProp = QueryTestProp;

  return {
    previous,
    QueryTestEnemy,
    QueryTestBoss,
    QueryTestProp,
  };
}

function restoreWorkerActiveListGlobals(previous) {
  if (previous.enemy === undefined) delete globalThis.QueryTestEnemy;
  else globalThis.QueryTestEnemy = previous.enemy;

  if (previous.boss === undefined) delete globalThis.QueryTestBoss;
  else globalThis.QueryTestBoss = previous.boss;

  if (previous.prop === undefined) delete globalThis.QueryTestProp;
  else globalThis.QueryTestProp = previous.prop;
}

test('main-thread fallback queryActiveEntities can use per-type active lists', () => {
  const previousActiveEntitiesData = GameObject.activeEntitiesData;
  const previousWarn = console.warn;
  const installed = installWorkerActiveListGlobals();
  console.warn = () => {};

  try {
    const querySystem = new QuerySystem();
    querySystem.entityMetadata = createFallbackMetadata().map((meta) => ({
      ...meta,
      entityClass: globalThis[meta.className],
    }));
    querySystem._queryResultBuffer = new Uint16Array(3000);

    GameObject.activeEntitiesData = null;

    const result = querySystem.queryActiveEntities([QueryTestComponentA, QueryTestComponentB]);
    assert.deepEqual(Array.from(result), [2, 7, 999, 1001, 1500]);
  } finally {
    console.warn = previousWarn;
    GameObject.activeEntitiesData = previousActiveEntitiesData;
    restoreWorkerActiveListGlobals(installed.previous);
  }
});

test('worker fallback queryActiveEntities uses per-type active lists and warns once', () => {
  const installed = installWorkerActiveListGlobals();
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));

  try {
    const queryFunctions = createWorkerQueryFunctions(
      {
        metadata: createFallbackMetadata().map((meta) => ({
          ...meta,
          componentMask: meta.componentMask.toString(),
        })),
        precomputedQueries: [],
      },
      {
        entityMetadataSAB: new SharedArrayBuffer(0),
        queryCacheSAB: new SharedArrayBuffer(0),
        queryResultsSAB: new SharedArrayBuffer(0),
      },
      null
    );

    const first = queryFunctions.queryActiveEntities([QueryTestComponentA, QueryTestComponentB]);
    const second = queryFunctions.queryActiveEntities([QueryTestComponentA, QueryTestComponentB]);

    assert.deepEqual(Array.from(first), [2, 7, 999, 1001, 1500]);
    assert.deepEqual(Array.from(second), [2, 7, 999, 1001, 1500]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /queryActiveEntities fallback used/);
  } finally {
    console.warn = previousWarn;
    restoreWorkerActiveListGlobals(installed.previous);
  }
});
