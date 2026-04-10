import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { DecorationPool } from '../../src/core/DecorationPool.js';
import { Transform } from '../../src/components/Transform.js';
import { RigidBody } from '../../src/components/RigidBody.js';

test('despawnAll clears attached decorations and rigidbody sleep state for active entities', () => {
  class BulkDespawnEntity extends GameObject {}

  const previousTransformActive = Transform.active;
  const previousRigidBodyActive = RigidBody.active;
  const previousRigidBodySleeping = RigidBody.sleeping;
  const previousRigidBodyStillnessTime = RigidBody.stillnessTime;
  const previousClearAttached = DecorationPool.clearAttachedAndDespawnAll;

  const onDespawnedCalls = [];
  const clearedAttachments = [];

  Transform.active = new Uint8Array([1, 0, 1]);
  RigidBody.active = new Uint8Array([1, 0, 1]);
  RigidBody.sleeping = new Uint8Array([1, 7, 1]);
  RigidBody.stillnessTime = new Float32Array([12, 34, 56]);

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
  } finally {
    Transform.active = previousTransformActive;
    RigidBody.active = previousRigidBodyActive;
    RigidBody.sleeping = previousRigidBodySleeping;
    RigidBody.stillnessTime = previousRigidBodyStillnessTime;
    DecorationPool.clearAttachedAndDespawnAll = previousClearAttached;
  }
});
