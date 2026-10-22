import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { BODY_DIRTY, bindBodySyncBuffers, markBodyDirty } from '../../src/box2d/box2dBodySync.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

// B19. Physics creates a body when it sees the slot active and wanted, and
// stamps it with the slot's body generation. Spawn activated the entity first
// and bumped the generation after. A physics step landing between the two
// created the body under the old generation, then destroyed and recreated it
// on the next step (dropping any joint made in between). The same bump also
// cleared the slot's previous-life pose after activation, so a renderer could
// draw one frame at the old life's position.

const N = 4;

function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  // Pose and velocity live on the Box2D heap in a scene (bindBox2dHotFields).
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotation = new Float32Array(N);
  Transform.rotC = new Float32Array(N);
  Transform.rotS = new Float32Array(N);
  RigidBody.vx = new Float32Array(N);
  RigidBody.vy = new Float32Array(N);
  RigidBody.angularVelocity = new Float32Array(N);
  RigidBody.sleeping = new Uint8Array(N);
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(N * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(N * 4),
    bodyGenEpoch: new SharedArrayBuffer(4),
    poseDataA: new SharedArrayBuffer(N * 16),
    poseDataB: new SharedArrayBuffer(N * 16),
  };
  bindBodySyncBuffers(buffers);
  return {
    flags: new Int32Array(buffers.bodyDirtyFlags),
    generation: new Int32Array(buffers.bodyGeneration),
    rotC: new Float32Array(buffers.poseDataA, N * 8, N),
  };
}

test('physics that sees a spawned slot active already sees its new body life', { concurrency: false }, () => {
  class B19Entity extends GameObject {}
  const sync = setup();
  const prevNextTick = GameObject.nextTick;
  const prevForce = GameObject.forceProcessOnLogicWorker;
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = null;

  // Slot 0 had a previous life: generation 3, and a pose its body published.
  sync.generation[0] = 3;
  sync.rotC[0] = 1;

  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  const freeListLinks = new Uint16Array(1);
  resetFreeList(freeListTop, freeListLinks, 1, 1);
  const pooled = {
    index: 0,
    _hasComponents: { RigidBody: true, Collider: true },
    onSpawned() {
      // A setter inside the spawn window (e.g. radius) saves a mark.
      markBodyDirty(0, BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
    },
  };
  B19Entity.startIndex = 0;
  B19Entity.poolSize = 1;
  B19Entity.entityType = 0;
  B19Entity.freeList = freeListLinks;
  B19Entity.freeListTop = freeListTop;
  B19Entity.instances = [pooled];
  B19Entity._componentClassMap = {};

  // What a physics step would see at the moment the slot turns active.
  const real = Transform.active;
  let atActivation = null;
  Transform.active = new Proxy(real, {
    set(target, prop, value) {
      target[prop] = value;
      if (prop === '0' && value === 1 && !atActivation) {
        atActivation = {
          generation: Atomics.load(sync.generation, 0),
          rotC: sync.rotC[0],
          lifecycle: Atomics.load(sync.flags, 0) & BODY_DIRTY.LIFECYCLE,
        };
      }
      return true;
    },
  });

  try {
    assert.equal(B19Entity.spawn({}), pooled);
  } finally {
    Transform.active = real;
    GameObject.nextTick = prevNextTick;
    GameObject.forceProcessOnLogicWorker = prevForce;
  }

  const finalGeneration = Atomics.load(sync.generation, 0);
  assert.equal(finalGeneration, 4, 'one new life');
  assert.ok(atActivation, 'the slot was activated');
  assert.equal(atActivation.generation, finalGeneration, 'active only under the new generation');
  assert.equal(atActivation.rotC, 0, 'the previous life\'s pose is gone before activation');
  assert.equal(atActivation.lifecycle, 0, 'LIFECYCLE is published after activation');
  const f = Atomics.load(sync.flags, 0);
  assert.equal(f & BODY_DIRTY.LIFECYCLE, BODY_DIRTY.LIFECYCLE, 'and it is published');
  assert.equal(real[0], 1);
});
