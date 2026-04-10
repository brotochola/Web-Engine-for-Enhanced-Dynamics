import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { DecorationPool } from '../../src/core/DecorationPool.js';
import { Transform } from '../../src/components/Transform.js';
import { RigidBody } from '../../src/components/RigidBody.js';
import { LightEmitter } from '../../src/components/LightEmitter.js';
import { FlashComponent } from '../../src/components/FlashComponent.js';

test('despawnAll clears attached decorations plus rigidbody, light, and flash pooled state', { concurrency: false }, () => {
  class BulkDespawnEntity extends GameObject {}

  const previousTransformActive = Transform.active;
  const previousRigidBodyActive = RigidBody.active;
  const previousRigidBodySleeping = RigidBody.sleeping;
  const previousRigidBodyStillnessTime = RigidBody.stillnessTime;
  const previousLightEmitterActive = LightEmitter.active;
  const previousLightEmitterColor = LightEmitter.lightColor;
  const previousLightEmitterIntensity = LightEmitter.lightIntensity;
  const previousLightEmitterSqrtIntensity = LightEmitter.sqrtLightIntensity;
  const previousLightEmitterHeight = LightEmitter.height;
  const previousLightEmitterGlowHeightOffset = LightEmitter.glowHeightOffset;
  const previousLightEmitterHasGlowSprite = LightEmitter.hasGlowSprite;
  const previousLightEmitterGlowLayerId = LightEmitter.layerIdOfGlowSprite;
  const previousFlashActive = FlashComponent.active;
  const previousFlashLifespan = FlashComponent.lifespan;
  const previousFlashCurrentLife = FlashComponent.currentLife;
  const previousFlashInitialIntensity = FlashComponent.initialIntensity;
  const previousClearAttached = DecorationPool.clearAttachedAndDespawnAll;

  const onDespawnedCalls = [];
  const clearedAttachments = [];

  Transform.active = new Uint8Array([1, 0, 1]);
  RigidBody.active = new Uint8Array([1, 0, 1]);
  RigidBody.sleeping = new Uint8Array([1, 7, 1]);
  RigidBody.stillnessTime = new Float32Array([12, 34, 56]);
  LightEmitter.active = new Uint8Array([1, 0, 1]);
  LightEmitter.lightColor = new Uint32Array([0x112233, 0x010203, 0x445566]);
  LightEmitter.lightIntensity = new Float32Array([900, 25, 400]);
  LightEmitter.sqrtLightIntensity = new Float32Array([30, 5, 20]);
  LightEmitter.height = new Float32Array([7, 1, 9]);
  LightEmitter.glowHeightOffset = new Float32Array([3, 2, 8]);
  LightEmitter.hasGlowSprite = new Uint8Array([0, 1, 0]);
  LightEmitter.layerIdOfGlowSprite = new Uint8Array([4, 5, 6]);
  FlashComponent.active = new Uint8Array([1, 0, 1]);
  FlashComponent.lifespan = new Float32Array([90, 12, 45]);
  FlashComponent.currentLife = new Float32Array([10, 3, 20]);
  FlashComponent.initialIntensity = new Float32Array([1000, 50, 600]);

  DecorationPool.clearAttachedAndDespawnAll = (entityIndex) => {
    clearedAttachments.push(entityIndex);
  };

  BulkDespawnEntity.startIndex = 0;
  BulkDespawnEntity.endIndex = 3;
  BulkDespawnEntity.poolSize = 3;
  BulkDespawnEntity.entityType = 0;
  BulkDespawnEntity.freeList = null;
  BulkDespawnEntity.freeListTop = null;
  BulkDespawnEntity._activeList = null;
  BulkDespawnEntity.instances = [
    { onDespawned: () => onDespawnedCalls.push(0) },
    { onDespawned: () => onDespawnedCalls.push(1) },
    { onDespawned: () => onDespawnedCalls.push(2) },
  ];

  try {
    const despawned = GameObject.despawnAll(BulkDespawnEntity);

    assert.equal(despawned, 2);
    assert.deepEqual(onDespawnedCalls, [0, 2]);
    assert.deepEqual(clearedAttachments, [0, 2]);
    assert.deepEqual(Array.from(Transform.active), [0, 0, 0]);
    assert.deepEqual(Array.from(RigidBody.active), [0, 0, 0]);
    assert.deepEqual(Array.from(RigidBody.sleeping), [0, 7, 0]);
    assert.deepEqual(Array.from(RigidBody.stillnessTime), [0, 34, 0]);
    assert.deepEqual(Array.from(LightEmitter.active), [0, 0, 0]);
    assert.deepEqual(Array.from(LightEmitter.lightColor), [0xffffff, 0x010203, 0xffffff]);
    assert.deepEqual(Array.from(LightEmitter.lightIntensity), [0, 25, 0]);
    assert.deepEqual(Array.from(LightEmitter.sqrtLightIntensity), [0, 5, 0]);
    assert.deepEqual(Array.from(LightEmitter.height), [0, 1, 0]);
    assert.deepEqual(Array.from(LightEmitter.glowHeightOffset), [0, 2, 0]);
    assert.deepEqual(Array.from(LightEmitter.hasGlowSprite), [1, 1, 1]);
    assert.deepEqual(Array.from(LightEmitter.layerIdOfGlowSprite), [0, 5, 0]);
    assert.deepEqual(Array.from(FlashComponent.active), [0, 0, 0]);
    assert.deepEqual(Array.from(FlashComponent.lifespan), [0, 12, 0]);
    assert.deepEqual(Array.from(FlashComponent.currentLife), [0, 3, 0]);
    assert.deepEqual(Array.from(FlashComponent.initialIntensity), [0, 50, 0]);
  } finally {
    Transform.active = previousTransformActive;
    RigidBody.active = previousRigidBodyActive;
    RigidBody.sleeping = previousRigidBodySleeping;
    RigidBody.stillnessTime = previousRigidBodyStillnessTime;
    LightEmitter.active = previousLightEmitterActive;
    LightEmitter.lightColor = previousLightEmitterColor;
    LightEmitter.lightIntensity = previousLightEmitterIntensity;
    LightEmitter.sqrtLightIntensity = previousLightEmitterSqrtIntensity;
    LightEmitter.height = previousLightEmitterHeight;
    LightEmitter.glowHeightOffset = previousLightEmitterGlowHeightOffset;
    LightEmitter.hasGlowSprite = previousLightEmitterHasGlowSprite;
    LightEmitter.layerIdOfGlowSprite = previousLightEmitterGlowLayerId;
    FlashComponent.active = previousFlashActive;
    FlashComponent.lifespan = previousFlashLifespan;
    FlashComponent.currentLife = previousFlashCurrentLife;
    FlashComponent.initialIntensity = previousFlashInitialIntensity;
    DecorationPool.clearAttachedAndDespawnAll = previousClearAttached;
  }
});

test('despawn clears LightEmitter and FlashComponent pooled state without relying on onDespawned', { concurrency: false }, () => {
  class FlashCleanupEntity extends GameObject {}

  const previousTransformActive = Transform.active;
  const previousLightEmitterActive = LightEmitter.active;
  const previousLightEmitterColor = LightEmitter.lightColor;
  const previousLightEmitterIntensity = LightEmitter.lightIntensity;
  const previousLightEmitterSqrtIntensity = LightEmitter.sqrtLightIntensity;
  const previousLightEmitterHeight = LightEmitter.height;
  const previousLightEmitterGlowHeightOffset = LightEmitter.glowHeightOffset;
  const previousLightEmitterHasGlowSprite = LightEmitter.hasGlowSprite;
  const previousLightEmitterGlowLayerId = LightEmitter.layerIdOfGlowSprite;
  const previousFlashActive = FlashComponent.active;
  const previousFlashLifespan = FlashComponent.lifespan;
  const previousFlashCurrentLife = FlashComponent.currentLife;
  const previousFlashInitialIntensity = FlashComponent.initialIntensity;
  const previousClearAttached = DecorationPool.clearAttachedAndDespawnAll;

  Transform.active = new Uint8Array([1]);
  LightEmitter.active = new Uint8Array([1]);
  LightEmitter.lightColor = new Uint32Array([0x123456]);
  LightEmitter.lightIntensity = new Float32Array([777]);
  LightEmitter.sqrtLightIntensity = new Float32Array([27.87472]);
  LightEmitter.height = new Float32Array([13]);
  LightEmitter.glowHeightOffset = new Float32Array([4]);
  LightEmitter.hasGlowSprite = new Uint8Array([0]);
  LightEmitter.layerIdOfGlowSprite = new Uint8Array([9]);
  FlashComponent.active = new Uint8Array([1]);
  FlashComponent.lifespan = new Float32Array([120]);
  FlashComponent.currentLife = new Float32Array([45]);
  FlashComponent.initialIntensity = new Float32Array([8000]);

  DecorationPool.clearAttachedAndDespawnAll = () => {};

  FlashCleanupEntity.entityType = 0;
  FlashCleanupEntity.freeList = null;
  FlashCleanupEntity.freeListTop = null;

  const entity = {
    index: 0,
    constructor: FlashCleanupEntity,
    lightEmitter: true,
    flashComponent: true,
  };

  try {
    GameObject.prototype.despawn.call(entity);

    assert.deepEqual(Array.from(Transform.active), [0]);
    assert.deepEqual(Array.from(LightEmitter.active), [0]);
    assert.deepEqual(Array.from(LightEmitter.lightColor), [0xffffff]);
    assert.deepEqual(Array.from(LightEmitter.lightIntensity), [0]);
    assert.deepEqual(Array.from(LightEmitter.sqrtLightIntensity), [0]);
    assert.deepEqual(Array.from(LightEmitter.height), [0]);
    assert.deepEqual(Array.from(LightEmitter.glowHeightOffset), [0]);
    assert.deepEqual(Array.from(LightEmitter.hasGlowSprite), [1]);
    assert.deepEqual(Array.from(LightEmitter.layerIdOfGlowSprite), [0]);
    assert.deepEqual(Array.from(FlashComponent.active), [0]);
    assert.deepEqual(Array.from(FlashComponent.lifespan), [0]);
    assert.deepEqual(Array.from(FlashComponent.currentLife), [0]);
    assert.deepEqual(Array.from(FlashComponent.initialIntensity), [0]);
  } finally {
    Transform.active = previousTransformActive;
    LightEmitter.active = previousLightEmitterActive;
    LightEmitter.lightColor = previousLightEmitterColor;
    LightEmitter.lightIntensity = previousLightEmitterIntensity;
    LightEmitter.sqrtLightIntensity = previousLightEmitterSqrtIntensity;
    LightEmitter.height = previousLightEmitterHeight;
    LightEmitter.glowHeightOffset = previousLightEmitterGlowHeightOffset;
    LightEmitter.hasGlowSprite = previousLightEmitterHasGlowSprite;
    LightEmitter.layerIdOfGlowSprite = previousLightEmitterGlowLayerId;
    FlashComponent.active = previousFlashActive;
    FlashComponent.lifespan = previousFlashLifespan;
    FlashComponent.currentLife = previousFlashCurrentLife;
    FlashComponent.initialIntensity = previousFlashInitialIntensity;
    DecorationPool.clearAttachedAndDespawnAll = previousClearAttached;
  }
});

test('spawn initializes LightEmitter and FlashComponent defaults for reused pooled entities', { concurrency: false }, () => {
  class SpawnFlashEntity extends GameObject {}

  const previousTransformActive = Transform.active;
  const previousTransformX = Transform.x;
  const previousTransformY = Transform.y;
  const previousTransformRotation = Transform.rotation;
  const previousLightEmitterActive = LightEmitter.active;
  const previousLightEmitterColor = LightEmitter.lightColor;
  const previousLightEmitterIntensity = LightEmitter.lightIntensity;
  const previousLightEmitterSqrtIntensity = LightEmitter.sqrtLightIntensity;
  const previousLightEmitterHeight = LightEmitter.height;
  const previousLightEmitterGlowHeightOffset = LightEmitter.glowHeightOffset;
  const previousLightEmitterHasGlowSprite = LightEmitter.hasGlowSprite;
  const previousLightEmitterGlowLayerId = LightEmitter.layerIdOfGlowSprite;
  const previousFlashActive = FlashComponent.active;
  const previousFlashLifespan = FlashComponent.lifespan;
  const previousFlashCurrentLife = FlashComponent.currentLife;
  const previousFlashInitialIntensity = FlashComponent.initialIntensity;
  const previousNextTick = GameObject.nextTick;

  Transform.active = new Uint8Array([0]);
  Transform.x = new Float32Array([99]);
  Transform.y = new Float32Array([88]);
  Transform.rotation = new Float32Array([77]);
  LightEmitter.active = new Uint8Array([0]);
  LightEmitter.lightColor = new Uint32Array([0xabcdef]);
  LightEmitter.lightIntensity = new Float32Array([555]);
  LightEmitter.sqrtLightIntensity = new Float32Array([23.558437]);
  LightEmitter.height = new Float32Array([17]);
  LightEmitter.glowHeightOffset = new Float32Array([6]);
  LightEmitter.hasGlowSprite = new Uint8Array([0]);
  LightEmitter.layerIdOfGlowSprite = new Uint8Array([7]);
  FlashComponent.active = new Uint8Array([0]);
  FlashComponent.lifespan = new Float32Array([120]);
  FlashComponent.currentLife = new Float32Array([45]);
  FlashComponent.initialIntensity = new Float32Array([8000]);
  GameObject.nextTick = null;

  const freeListTopSAB = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const freeListTop = new Int32Array(freeListTopSAB);
  freeListTop[0] = 1;

  const pooledInstance = {
    _hasComponents: {
      LightEmitter: true,
      FlashComponent: true,
    },
  };

  SpawnFlashEntity.startIndex = 0;
  SpawnFlashEntity.poolSize = 1;
  SpawnFlashEntity.entityType = 0;
  SpawnFlashEntity.freeList = new Uint16Array([0]);
  SpawnFlashEntity.freeListTop = freeListTop;
  SpawnFlashEntity.instances = [pooledInstance];
  SpawnFlashEntity._componentClassMap = {};

  try {
    const spawned = GameObject.spawn(SpawnFlashEntity, {});

    assert.strictEqual(spawned, pooledInstance);
    assert.deepEqual(Array.from(Transform.active), [1]);
    assert.deepEqual(Array.from(Transform.x), [0]);
    assert.deepEqual(Array.from(Transform.y), [0]);
    assert.deepEqual(Array.from(Transform.rotation), [0]);
    assert.deepEqual(Array.from(LightEmitter.active), [1]);
    assert.deepEqual(Array.from(LightEmitter.lightColor), [0xffffff]);
    assert.deepEqual(Array.from(LightEmitter.lightIntensity), [0]);
    assert.deepEqual(Array.from(LightEmitter.sqrtLightIntensity), [0]);
    assert.deepEqual(Array.from(LightEmitter.height), [0]);
    assert.deepEqual(Array.from(LightEmitter.glowHeightOffset), [0]);
    assert.deepEqual(Array.from(LightEmitter.hasGlowSprite), [1]);
    assert.deepEqual(Array.from(LightEmitter.layerIdOfGlowSprite), [0]);
    assert.deepEqual(Array.from(FlashComponent.active), [1]);
    assert.deepEqual(Array.from(FlashComponent.lifespan), [0]);
    assert.deepEqual(Array.from(FlashComponent.currentLife), [0]);
    assert.deepEqual(Array.from(FlashComponent.initialIntensity), [0]);
    assert.equal(freeListTop[0], 0);
  } finally {
    Transform.active = previousTransformActive;
    Transform.x = previousTransformX;
    Transform.y = previousTransformY;
    Transform.rotation = previousTransformRotation;
    LightEmitter.active = previousLightEmitterActive;
    LightEmitter.lightColor = previousLightEmitterColor;
    LightEmitter.lightIntensity = previousLightEmitterIntensity;
    LightEmitter.sqrtLightIntensity = previousLightEmitterSqrtIntensity;
    LightEmitter.height = previousLightEmitterHeight;
    LightEmitter.glowHeightOffset = previousLightEmitterGlowHeightOffset;
    LightEmitter.hasGlowSprite = previousLightEmitterHasGlowSprite;
    LightEmitter.layerIdOfGlowSprite = previousLightEmitterGlowLayerId;
    FlashComponent.active = previousFlashActive;
    FlashComponent.lifespan = previousFlashLifespan;
    FlashComponent.currentLife = previousFlashCurrentLife;
    FlashComponent.initialIntensity = previousFlashInitialIntensity;
    GameObject.nextTick = previousNextTick;
  }
});

test('despawnAll forwards non-logic0 logic workers to logic0 without mutating local state', { concurrency: false }, () => {
  class ForwardedDespawnEntity extends GameObject {}

  const previousTransformActive = Transform.active;
  const previousRigidBodyActive = RigidBody.active;
  const previousRigidBodySleeping = RigidBody.sleeping;
  const previousRigidBodyStillnessTime = RigidBody.stillnessTime;
  const previousClearAttached = DecorationPool.clearAttachedAndDespawnAll;
  const previousSelf = globalThis.self;

  const onDespawnedCalls = [];
  const clearedAttachments = [];
  const forwardedMessages = [];

  Transform.active = new Uint8Array([1, 1]);
  RigidBody.active = new Uint8Array([1, 1]);
  RigidBody.sleeping = new Uint8Array([1, 1]);
  RigidBody.stillnessTime = new Float32Array([12, 56]);

  DecorationPool.clearAttachedAndDespawnAll = (entityIndex) => {
    clearedAttachments.push(entityIndex);
  };

  ForwardedDespawnEntity.startIndex = 0;
  ForwardedDespawnEntity.endIndex = 2;
  ForwardedDespawnEntity.poolSize = 2;
  ForwardedDespawnEntity.entityType = 0;
  ForwardedDespawnEntity.freeList = null;
  ForwardedDespawnEntity.freeListTop = null;
  ForwardedDespawnEntity._activeList = null;
  ForwardedDespawnEntity.instances = [
    { onDespawned: () => onDespawnedCalls.push(0) },
    { onDespawned: () => onDespawnedCalls.push(1) },
  ];

  globalThis.self = {
    logicWorker: {
      workerIndex: 1,
      sendDataToWorker(workerName, data) {
        forwardedMessages.push({ workerName, data });
        return true;
      },
    },
  };

  try {
    const result = GameObject.despawnAll(ForwardedDespawnEntity);

    assert.equal(result, undefined);
    assert.deepEqual(forwardedMessages, [
      {
        workerName: 'logic0',
        data: {
          msg: 'despawnAll',
          className: 'ForwardedDespawnEntity',
        },
      },
    ]);
    assert.deepEqual(onDespawnedCalls, []);
    assert.deepEqual(clearedAttachments, []);
    assert.deepEqual(Array.from(Transform.active), [1, 1]);
    assert.deepEqual(Array.from(RigidBody.active), [1, 1]);
    assert.deepEqual(Array.from(RigidBody.sleeping), [1, 1]);
    assert.deepEqual(Array.from(RigidBody.stillnessTime), [12, 56]);
  } finally {
    Transform.active = previousTransformActive;
    RigidBody.active = previousRigidBodyActive;
    RigidBody.sleeping = previousRigidBodySleeping;
    RigidBody.stillnessTime = previousRigidBodyStillnessTime;
    DecorationPool.clearAttachedAndDespawnAll = previousClearAttached;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

test('despawnAll returns 0 and preserves local state when non-logic0 forwarding fails', { concurrency: false }, () => {
  class FailedForwardDespawnEntity extends GameObject {}

  const previousTransformActive = Transform.active;
  const previousRigidBodyActive = RigidBody.active;
  const previousRigidBodySleeping = RigidBody.sleeping;
  const previousRigidBodyStillnessTime = RigidBody.stillnessTime;
  const previousClearAttached = DecorationPool.clearAttachedAndDespawnAll;
  const previousSelf = globalThis.self;

  const onDespawnedCalls = [];
  const clearedAttachments = [];

  Transform.active = new Uint8Array([1, 1]);
  RigidBody.active = new Uint8Array([1, 1]);
  RigidBody.sleeping = new Uint8Array([1, 1]);
  RigidBody.stillnessTime = new Float32Array([12, 56]);

  DecorationPool.clearAttachedAndDespawnAll = (entityIndex) => {
    clearedAttachments.push(entityIndex);
  };

  FailedForwardDespawnEntity.startIndex = 0;
  FailedForwardDespawnEntity.endIndex = 2;
  FailedForwardDespawnEntity.poolSize = 2;
  FailedForwardDespawnEntity.entityType = 0;
  FailedForwardDespawnEntity.freeList = null;
  FailedForwardDespawnEntity.freeListTop = null;
  FailedForwardDespawnEntity._activeList = null;
  FailedForwardDespawnEntity.instances = [
    { onDespawned: () => onDespawnedCalls.push(0) },
    { onDespawned: () => onDespawnedCalls.push(1) },
  ];

  globalThis.self = {
    logicWorker: {
      workerIndex: 1,
      sendDataToWorker() {
        return false;
      },
    },
  };

  try {
    const result = GameObject.despawnAll(FailedForwardDespawnEntity);

    assert.equal(result, 0);
    assert.deepEqual(onDespawnedCalls, []);
    assert.deepEqual(clearedAttachments, []);
    assert.deepEqual(Array.from(Transform.active), [1, 1]);
    assert.deepEqual(Array.from(RigidBody.active), [1, 1]);
    assert.deepEqual(Array.from(RigidBody.sleeping), [1, 1]);
    assert.deepEqual(Array.from(RigidBody.stillnessTime), [12, 56]);
  } finally {
    Transform.active = previousTransformActive;
    RigidBody.active = previousRigidBodyActive;
    RigidBody.sleeping = previousRigidBodySleeping;
    RigidBody.stillnessTime = previousRigidBodyStillnessTime;
    DecorationPool.clearAttachedAndDespawnAll = previousClearAttached;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});
