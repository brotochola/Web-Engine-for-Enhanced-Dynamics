import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Joint } from '../../src/core/joint.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

// N-130: despawn left the entity's joints in Weed's joint pool. The rows stayed active, the partner still counted
// them, the slots were not freed, and the entity spawned next into that index was born jointed to the old partner.
// Despawn now removes them, after onDespawned (which can still read them).

const N = 6;
const MAX_JOINTS = 8;

function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  RigidBody.sleeping = new Uint8Array(N);
  Joint.reset();
  Joint.initializeArrays(new SharedArrayBuffer(Joint.getBufferSize(MAX_JOINTS, N)), MAX_JOINTS, N);
  const freeList = new Uint16Array(new SharedArrayBuffer(MAX_JOINTS * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, MAX_JOINTS, 1);
  Joint.initialize(MAX_JOINTS);
  Joint.initializeFreeList(freeList.buffer, freeListTop.buffer);
  for (let i = 0; i < N; i++) {
    Transform.active[i] = 1;
    RigidBody.active[i] = 1;
    Collider.active[i] = 1;
  }
  return { freeListTop };
}

class Link extends GameObject {}
function bindClass() {
  Link.startIndex = 0;
  Link.endIndex = N;
  Link.poolSize = N;
  Link.entityType = 0;
  Link.freeList = null;
  Link.freeListTop = null;
  Link._activeList = null;
  Link.instances = [];
  for (let i = 0; i < N; i++) Link.instances.push(entity(i));
}

function entity(i) {
  const e = Object.create(Link.prototype);
  e.index = i;
  e._hasComponents = { RigidBody: true, Collider: true };
  return e;
}

function joinTheChain() {
  // 0 holds two joints (to 1 and to 2); 3 and 4 are joined apart from them.
  const a = Joint.addDistance({ entityA: 0, entityB: 1, length: 10 });
  const b = Joint.addRevolute({ entityA: 2, entityB: 0 });
  const c = Joint.addWeld({ entityA: 3, entityB: 4 });
  assert.ok(a >= 0 && b >= 0 && c >= 0);
  assert.equal(Joint.getJointCount(0), 2);
  return { a, b, c };
}

test('despawn removes the entity\'s joints at both ends and frees their slots', () => {
  const { freeListTop } = setup();
  bindClass();
  const freeBefore = freeListTop[1];
  const { a, b, c } = joinTheChain();
  assert.equal(freeListTop[1], freeBefore - 3);

  entity(0).despawn();

  assert.equal(Joint.getJointCount(0), 0);
  assert.equal(Joint.getJointCount(1), 0, 'the partner no longer counts it');
  assert.equal(Joint.getJointCount(2), 0);
  assert.equal(Joint.isActive(a), false);
  assert.equal(Joint.isActive(b), false);
  assert.equal(Joint.isActive(c), true, 'a joint between two other entities stays');
  assert.equal(Joint.getJointCount(3), 1);
  assert.equal(freeListTop[1], freeBefore - 1, 'two slots back in the pool');
});

test('the entity spawned next into the index is born without the old joints', () => {
  setup();
  bindClass();
  joinTheChain();
  entity(0).despawn();
  // The next spawn into slot 0.
  Transform.active[0] = 1;
  RigidBody.active[0] = 1;
  assert.equal(Joint.getJointCount(0), 0);
  assert.equal(Joint.hasBetween(0, 1), false);
  assert.equal(Joint.hasBetween(2, 0), false);
});

test('onDespawned still sees the joints, and one that removes them itself still works', () => {
  setup();
  bindClass();
  joinTheChain();
  const e = entity(0);
  let seen = -1;
  e.onDespawned = function onDespawned() {
    seen = Joint.getJointCount(this.index);
    Joint.removeAllForEntity(this.index);
  };
  e.despawn();
  assert.equal(seen, 2, 'the joints are still there in onDespawned');
  assert.equal(Joint.getJointCount(1), 0);
  assert.equal(Joint.getDenseActiveCount(), 1, 'only the weld between 3 and 4 is left');
});

test('despawnAll removes every despawned entity\'s joints', () => {
  const { freeListTop } = setup();
  bindClass();
  const freeBefore = freeListTop[1];
  joinTheChain();
  Link.despawnAll();
  assert.equal(Joint.getDenseActiveCount(), 0);
  for (let i = 0; i < N; i++) assert.equal(Joint.getJointCount(i), 0, `entity ${i}`);
  assert.equal(freeListTop[1], freeBefore);
});
