import test from 'node:test';
import assert from 'node:assert/strict';

import { QuerySystem, createWorkerQueryFunctions } from '../../src/core/QuerySystem.js';
import { GameObject } from '../../src/core/gameObject.js';

class QueryTestComponentA {}
QueryTestComponentA.componentId = 0;

class QueryTestComponentB {}
QueryTestComponentB.componentId = 1;

class PrecomputedTransform {}
PrecomputedTransform.componentId = 10;

class PrecomputedRigidBody {}
PrecomputedRigidBody.componentId = 11;

class PrecomputedCollider {}
PrecomputedCollider.componentId = 12;

class PrecomputedSpriteRenderer {}
PrecomputedSpriteRenderer.componentId = 13;

class PrecomputedAdobeAnimComponent {}
PrecomputedAdobeAnimComponent.componentId = 14;

class PrecomputedLightEmitter {}
PrecomputedLightEmitter.componentId = 15;

class PrecomputedShadowCaster {}
PrecomputedShadowCaster.componentId = 16;

class PrecomputedFlashComponent {}
PrecomputedFlashComponent.componentId = 17;

class PrecomputedLightOccluder {}
PrecomputedLightOccluder.componentId = 18;

class PrecomputedCameraInOutListener {}
PrecomputedCameraInOutListener.componentId = 19;

class PrecomputedCollisionListener {}
PrecomputedCollisionListener.componentId = 20;

class PrecomputedParticleComponent {}
PrecomputedParticleComponent.componentId = 21;

class PrecomputedDecorationComponent {}
PrecomputedDecorationComponent.componentId = 22;

class PrecomputedBulletComponent {}
PrecomputedBulletComponent.componentId = 23;

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

test('definePrecomputedQueries covers all built-in entity components as single-component queries', () => {
  const previousLog = console.log;
  console.log = () => {};
  const querySystem = new QuerySystem();
  try {
    querySystem.definePrecomputedQueries({
      Transform: PrecomputedTransform,
      RigidBody: PrecomputedRigidBody,
      Collider: PrecomputedCollider,
      SpriteRenderer: PrecomputedSpriteRenderer,
      AdobeAnimComponent: PrecomputedAdobeAnimComponent,
      LightEmitter: PrecomputedLightEmitter,
      ShadowCaster: PrecomputedShadowCaster,
      FlashComponent: PrecomputedFlashComponent,
      LightOccluder: PrecomputedLightOccluder,
      CameraInOutListener: PrecomputedCameraInOutListener,
      CollisionListener: PrecomputedCollisionListener,
      ParticleComponent: PrecomputedParticleComponent,
      DecorationComponent: PrecomputedDecorationComponent,
      BulletComponent: PrecomputedBulletComponent,
    });

    const queryNames = new Set(querySystem.precomputedQueries.map((query) => query.name));

    assert.deepEqual(
      Array.from(queryNames).sort(),
      [
        'AdobeAnimComponent',
        'CameraInOutListener',
        'Collider',
        'CollisionListener',
        'FlashComponent',
        'LightEmitter',
        'LightEmitter+FlashComponent',
        'LightEmitter+ShadowCaster',
        'LightOccluder',
        'RigidBody',
        'RigidBody+Collider',
        'ShadowCaster',
        'SpriteRenderer',
        'SpriteRenderer+RigidBody',
        'Transform',
      ]
    );
    assert.equal(queryNames.has('ParticleComponent'), false);
    assert.equal(queryNames.has('DecorationComponent'), false);
    assert.equal(queryNames.has('BulletComponent'), false);
  } finally {
    console.log = previousLog;
  }
});

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
