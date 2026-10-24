import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

// Without physics RigidBody's vx, vy, angularVelocity and sleeping are not bound (they are views of Box2D's heap,
// bindBox2dHotFields), and the spawn reset wrote them: a scene with physics off threw on its first spawn of a type
// with a RigidBody (bulletStressScene ?physics=0 did, before and after Phase 4).
test('a RigidBody type spawns in a scene without physics', { concurrency: false }, () => {
  class Crate extends GameObject {}
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(1)), 1);
  for (const hot of ['vx', 'vy', 'angularVelocity', 'sleeping']) RigidBody[hot] = undefined;
  Transform.active = new Uint8Array([0]);
  Transform.x = new Float32Array([5]);
  Transform.y = new Float32Array([6]);
  Transform.rotation = new Float32Array([1]);
  GameObject.nextTick = null;
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(1);
  resetFreeList(top, links, 1, 1);
  const instance = { _hasComponents: { RigidBody: true } };
  Crate.startIndex = 0;
  Crate.poolSize = 1;
  Crate.entityType = 0;
  Crate.freeList = links;
  Crate.freeListTop = top;
  Crate.instances = [instance];
  Crate._componentClassMap = {};
  const spawned = Crate.spawn({});
  assert.strictEqual(spawned, instance);
  assert.equal(RigidBody.active[0], 1, 'the body is on');
  assert.equal(RigidBody.static[0], 0);
  assert.equal(Transform.active[0], 1, 'the entity is live');
});
