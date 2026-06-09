import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/Scene.js';
import { Layer } from '../../src/core/Layer.js';
import { DecorationPool } from '../../src/core/DecorationPool.js';
import { Transform } from '../../src/components/Transform.js';
import { RigidBody } from '../../src/components/RigidBody.js';
import { SpriteRenderer } from '../../src/components/SpriteRenderer.js';
import { AdobeAnimComponent } from '../../src/components/AdobeAnimComponent.js';
import { LightEmitter } from '../../src/components/LightEmitter.js';
import { FlashComponent } from '../../src/components/FlashComponent.js';
import { resetFreeList } from '../../src/core/atomicFreeList.js';

test('Scene.preInitializeEntityTypeArrays fills registered ranges directly', { concurrency: false }, () => {
  class RangeFillA extends GameObject {}
  class RangeFillB extends GameObject {}
  class RangeFillEmpty extends GameObject {}

  const previousEntityType = Transform.entityType;

  RangeFillA.entityType = 2;
  RangeFillB.entityType = 5;
  RangeFillEmpty.entityType = 9;
  Transform.entityType = new Uint8Array(7);
  Transform.entityType.fill(255);

  try {
    Scene.prototype.preInitializeEntityTypeArrays.call({
      totalEntityCount: 7,
      registeredClasses: [
        { class: RangeFillA, startIndex: 0, count: 3 },
        { class: RangeFillEmpty, startIndex: 3, count: 0 },
        { class: RangeFillB, startIndex: 3, count: 4 },
      ],
    });

    assert.deepEqual(Array.from(Transform.entityType), [2, 2, 2, 5, 5, 5, 5]);
  } finally {
    Transform.entityType = previousEntityType;
  }
});

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

  // Treiber-stack free list: links array + [head, count] header
  const freeListTopSAB = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  const freeListTop = new Int32Array(freeListTopSAB);
  const freeListLinks = new Uint16Array(1);
  resetFreeList(freeListTop, freeListLinks, 1, 1);

  const pooledInstance = {
    _hasComponents: {
      LightEmitter: true,
      FlashComponent: true,
    },
  };

  SpawnFlashEntity.startIndex = 0;
  SpawnFlashEntity.poolSize = 1;
  SpawnFlashEntity.entityType = 0;
  SpawnFlashEntity.freeList = freeListLinks;
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
    assert.equal(freeListTop[1], 0); // free count drained
    assert.equal(freeListTop[0] & 0xffff, 0); // stack head empty
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

test('render facade works for Adobe-only entities and fan-outs method updates when both render components exist', () => {
  const previousSpriteAlpha = SpriteRenderer.alpha;
  const previousSpriteBaseTint = SpriteRenderer.baseTint;
  const previousSpriteTint = SpriteRenderer.tint;
  const previousSpriteVisible = SpriteRenderer.renderVisible;
  const previousSpriteScaleX = SpriteRenderer.scaleX;
  const previousSpriteScaleY = SpriteRenderer.scaleY;
  const previousSpriteDirty = SpriteRenderer.renderDirty;
  const previousSpriteOnScreen = SpriteRenderer.isItOnScreen;
  const previousSpriteLayerId = SpriteRenderer.layerId;
  const previousSpriteUpdateBounds = SpriteRenderer.updateBounds;

  const previousAdobeAlpha = AdobeAnimComponent.alpha;
  const previousAdobeTint = AdobeAnimComponent.tint;
  const previousAdobeVisible = AdobeAnimComponent.renderVisible;
  const previousAdobeScaleX = AdobeAnimComponent.scaleX;
  const previousAdobeScaleY = AdobeAnimComponent.scaleY;
  const previousAdobeOnScreen = AdobeAnimComponent.isItOnScreen;
  const previousAdobeLayerId = AdobeAnimComponent.layerId;
  const previousAdobeApplyClipBounds = AdobeAnimComponent.applyClipBounds;

  const previousLayerGetName = Layer.getName;
  const previousLayerGetId = Layer.getId;

  const spriteBoundsUpdates = [];
  const adobeBoundsUpdates = [];

  SpriteRenderer.alpha = new Float32Array([1, 1]);
  SpriteRenderer.baseTint = new Uint32Array([0xffffff, 0xffffff]);
  SpriteRenderer.tint = new Uint32Array([0xffffff, 0xffffff]);
  SpriteRenderer.renderVisible = new Uint8Array([0, 1]);
  SpriteRenderer.scaleX = new Float32Array([1, 1]);
  SpriteRenderer.scaleY = new Float32Array([1, 1]);
  SpriteRenderer.renderDirty = new Uint8Array([0, 0]);
  SpriteRenderer.isItOnScreen = new Uint8Array([0, 1]);
  SpriteRenderer.layerId = new Uint8Array([0, 1]);
  SpriteRenderer.updateBounds = (index) => spriteBoundsUpdates.push(index);

  AdobeAnimComponent.alpha = new Float32Array([1, 1]);
  AdobeAnimComponent.tint = new Uint32Array([0xffffff, 0xffffff]);
  AdobeAnimComponent.renderVisible = new Uint8Array([0, 1]);
  AdobeAnimComponent.scaleX = new Float32Array([1, 1]);
  AdobeAnimComponent.scaleY = new Float32Array([1, 1]);
  AdobeAnimComponent.isItOnScreen = new Uint8Array([1, 0]);
  AdobeAnimComponent.layerId = new Uint8Array([7, 3]);
  AdobeAnimComponent.applyClipBounds = (index) => adobeBoundsUpdates.push(index);

  Layer.getName = (id) => `layer-${id}`;
  Layer.getId = (name) => (name === 'fx' ? 9 : -1);

  const adobeOnly = Object.create(GameObject.prototype);
  adobeOnly.index = 0;
  adobeOnly._hasComponents = { adobeAnimComponent: true };

  const both = Object.create(GameObject.prototype);
  both.index = 1;
  both._hasComponents = { SpriteRenderer: true, adobeAnimComponent: true };

  try {
    adobeOnly.alpha = 0.4;
    adobeOnly.tint = 0x123456;
    adobeOnly.visible = true;
    adobeOnly.scaleX = 2;
    adobeOnly.scaleY = 3;

    assert.ok(Math.abs(adobeOnly.alpha - 0.4) < 1e-6);
    assert.equal(adobeOnly.tint, 0x123456);
    assert.equal(adobeOnly.visible, true);
    assert.equal(adobeOnly.isOnScreen, true);
    assert.equal(adobeOnly.layerName, 'layer-7');
    assert.ok(Math.abs(AdobeAnimComponent.alpha[0] - 0.4) < 1e-6);
    assert.equal(AdobeAnimComponent.tint[0], 0x123456);
    assert.equal(AdobeAnimComponent.renderVisible[0], 1);
    assert.ok(Math.abs(AdobeAnimComponent.scaleX[0] - 2) < 1e-6);
    assert.ok(Math.abs(AdobeAnimComponent.scaleY[0] - 3) < 1e-6);

    both.setAlpha(0.25).setTint(0x224466).setVisible(false).setScale(1.5, 2.5).setLayer('fx');

    assert.ok(Math.abs(SpriteRenderer.alpha[1] - 0.25) < 1e-6);
    assert.ok(Math.abs(AdobeAnimComponent.alpha[1] - 0.25) < 1e-6);
    assert.equal(SpriteRenderer.baseTint[1], 0x224466);
    assert.equal(SpriteRenderer.tint[1], 0x224466);
    assert.equal(AdobeAnimComponent.tint[1], 0x224466);
    assert.equal(SpriteRenderer.renderVisible[1], 0);
    assert.equal(AdobeAnimComponent.renderVisible[1], 0);
    assert.ok(Math.abs(SpriteRenderer.scaleX[1] - 1.5) < 1e-6);
    assert.ok(Math.abs(SpriteRenderer.scaleY[1] - 2.5) < 1e-6);
    assert.ok(Math.abs(AdobeAnimComponent.scaleX[1] - 1.5) < 1e-6);
    assert.ok(Math.abs(AdobeAnimComponent.scaleY[1] - 2.5) < 1e-6);
    assert.equal(SpriteRenderer.layerId[1], 9);
    assert.equal(AdobeAnimComponent.layerId[1], 9);
    assert.equal(both.layerName, 'layer-9');
    assert.deepEqual(spriteBoundsUpdates, [1]);
    assert.deepEqual(adobeBoundsUpdates, [0, 0, 1]);
    assert.equal(SpriteRenderer.renderDirty[1], 1);
  } finally {
    SpriteRenderer.alpha = previousSpriteAlpha;
    SpriteRenderer.baseTint = previousSpriteBaseTint;
    SpriteRenderer.tint = previousSpriteTint;
    SpriteRenderer.renderVisible = previousSpriteVisible;
    SpriteRenderer.scaleX = previousSpriteScaleX;
    SpriteRenderer.scaleY = previousSpriteScaleY;
    SpriteRenderer.renderDirty = previousSpriteDirty;
    SpriteRenderer.isItOnScreen = previousSpriteOnScreen;
    SpriteRenderer.layerId = previousSpriteLayerId;
    SpriteRenderer.updateBounds = previousSpriteUpdateBounds;

    AdobeAnimComponent.alpha = previousAdobeAlpha;
    AdobeAnimComponent.tint = previousAdobeTint;
    AdobeAnimComponent.renderVisible = previousAdobeVisible;
    AdobeAnimComponent.scaleX = previousAdobeScaleX;
    AdobeAnimComponent.scaleY = previousAdobeScaleY;
    AdobeAnimComponent.isItOnScreen = previousAdobeOnScreen;
    AdobeAnimComponent.layerId = previousAdobeLayerId;
    AdobeAnimComponent.applyClipBounds = previousAdobeApplyClipBounds;

    Layer.getName = previousLayerGetName;
    Layer.getId = previousLayerGetId;
  }
});

test('Scene.getPoolStats handles entity classes that start at index 0', () => {
  const previousTransformActive = Transform.active;
  Transform.active = new Uint8Array([1, 0, 1]);

  try {
    const stats = Scene.prototype.getPoolStats.call({}, {
      startIndex: 0,
      endIndex: 3,
      poolSize: 3,
    });

    assert.deepEqual(stats, {
      total: 3,
      active: 2,
      available: 1,
    });
  } finally {
    Transform.active = previousTransformActive;
  }
});
