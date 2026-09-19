import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_DIRTY,
  bindBodySyncBuffers,
  markBodyDirty,
  bumpBodyGeneration,
  withBodyDirtyDeferred,
} from '../../src/box2d/box2dBodySync.js';
import { Joint } from '../../src/core/joint.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';

test('body dirty: coalesces flags and publishes dirty words', () => {
  const entityCount = 64;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(Math.ceil(entityCount / 32) * 4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const flags = new Int32Array(buffers.bodyDirtyFlags);
  const words = new Int32Array(buffers.bodyDirtyWords);

  assert.equal(markBodyDirty(5, BODY_DIRTY.MASS), true);
  assert.equal(markBodyDirty(5, BODY_DIRTY.FILTER), true);
  assert.equal(flags[5] & BODY_DIRTY.MASS, BODY_DIRTY.MASS);
  assert.equal(flags[5] & BODY_DIRTY.FILTER, BODY_DIRTY.FILTER);
  assert.ok(words[0] & (1 << 5));
});

test('body dirty: defer saves marks; bump publishes them with lifecycle', () => {
  const entityCount = 16;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const flags = new Int32Array(buffers.bodyDirtyFlags);
  const words = new Int32Array(buffers.bodyDirtyWords);

  withBodyDirtyDeferred(() => {
    assert.equal(markBodyDirty(5, BODY_DIRTY.GEOMETRY), true);
    assert.equal(markBodyDirty(5, BODY_DIRTY.DAMPING), true);
  });
  assert.equal(flags[5], 0);
  assert.equal(words[0], 0);

  assert.equal(bumpBodyGeneration(5), 1);
  const want = BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY | BODY_DIRTY.DAMPING;
  assert.equal(flags[5] & want, want);
  assert.ok(words[0] & (1 << 5));
});

test('body dirty: child bump inside parent defer publishes saved geometry', () => {
  const entityCount = 16;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const flags = new Int32Array(buffers.bodyDirtyFlags);
  const words = new Int32Array(buffers.bodyDirtyWords);

  withBodyDirtyDeferred(() => {
    markBodyDirty(7, BODY_DIRTY.GEOMETRY);
    assert.equal(flags[7], 0);
    assert.equal(words[0], 0);

    assert.equal(bumpBodyGeneration(7), 1);
    const want = BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY;
    assert.equal(flags[7] & want, want);
    assert.ok(words[0] & (1 << 7));

    assert.equal(markBodyDirty(7, BODY_DIRTY.FILTER, true), true);
    assert.equal(flags[7] & BODY_DIRTY.FILTER, BODY_DIRTY.FILTER);
  });
});

test('body dirty: bump of one entity does not publish the other', () => {
  const entityCount = 16;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const flags = new Int32Array(buffers.bodyDirtyFlags);
  const words = new Int32Array(buffers.bodyDirtyWords);

  withBodyDirtyDeferred(() => {
    markBodyDirty(4, BODY_DIRTY.GEOMETRY);
    markBodyDirty(9, BODY_DIRTY.FILTER);
    assert.equal(bumpBodyGeneration(4), 1);
  });

  const want4 = BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY;
  assert.equal(flags[4] & want4, want4);
  assert.equal(flags[9], 0);
  assert.ok(words[0] & (1 << 4));
  assert.equal(words[0] & (1 << 9), 0);

  assert.equal(bumpBodyGeneration(9), 1);
  const want9 = BODY_DIRTY.LIFECYCLE | BODY_DIRTY.FILTER;
  assert.equal(flags[9] & want9, want9);
  assert.ok(words[0] & (1 << 9));
});

test('body dirty: mark outside defer publishes leftover saved flags', () => {
  const entityCount = 16;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const flags = new Int32Array(buffers.bodyDirtyFlags);

  withBodyDirtyDeferred(() => {
    markBodyDirty(2, BODY_DIRTY.GEOMETRY);
  });
  assert.equal(flags[2], 0);

  assert.equal(markBodyDirty(2, BODY_DIRTY.MASS), true);
  const want = BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS;
  assert.equal(flags[2] & want, want);
});

test('body generation: bump increments and marks lifecycle dirty', () => {
  const entityCount = 16;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const gen = new Int32Array(buffers.bodyGeneration);
  const flags = new Int32Array(buffers.bodyDirtyFlags);

  assert.equal(gen[3], 0);
  assert.equal(bumpBodyGeneration(3), 1);
  assert.equal(gen[3], 1);
  assert.equal(bumpBodyGeneration(3), 2);
  assert.equal(gen[3], 2);
  assert.equal(flags[3] & BODY_DIRTY.LIFECYCLE, BODY_DIRTY.LIFECYCLE);
});

test('joint revision: bumps on add, update, remove; slot reuse gets new rev', () => {
  const maxJoints = 8;
  Joint.reset();
  const sab = new SharedArrayBuffer(Joint.getBufferSize(maxJoints, 8));
  Joint.initializeArrays(sab, maxJoints, 8);

  const freeListSab = new SharedArrayBuffer(maxJoints * 2);
  const freeListTopSab = new SharedArrayBuffer(8);
  const freeList = new Uint16Array(freeListSab);
  const freeListTop = new Int32Array(freeListTopSab);
  resetFreeList(freeListTop, freeList, maxJoints, 1);
  Joint.initialize(maxJoints);
  Joint.initializeFreeList(freeListSab, freeListTopSab);

  const idx = Joint.addDistance({
    entityA: 1,
    entityB: 2,
    length: 10,
  });
  assert.ok(idx >= 0);
  assert.equal(Joint.hasBetween(1, 2), true);
  assert.equal(Joint.hasBetween(2, 1), true);
  assert.equal(Joint.getJointCount(1), 1);
  assert.equal(Joint.getJoint(1, 0), idx);
  const rev1 = Atomics.load(Joint.revision, idx);
  assert.ok(rev1 > 0);

  Joint.update(idx, { length: 12 });
  const rev2 = Atomics.load(Joint.revision, idx);
  assert.ok(rev2 > rev1);

  Joint.remove(idx);
  const revAfterRemove = Atomics.load(Joint.revision, idx);
  assert.ok(revAfterRemove > rev2);
  assert.equal(Joint.hasBetween(1, 2), false);
  assert.equal(Joint.getJointCount(1), 0);

  const idx2 = Joint.addDistance({
    entityA: 3,
    entityB: 4,
    length: 5,
  });
  assert.equal(idx2, idx);
  const revReuse = Atomics.load(Joint.revision, idx2);
  assert.ok(revReuse > revAfterRemove);

  Joint.reset();
});

test('collider/rigidBody.active setters publish combined dirty flags', () => {
  const entityCount = 8;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(Math.ceil(entityCount / 32) * 4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const flags = new Int32Array(buffers.bodyDirtyFlags);

  Collider.initializeArrays(
    new SharedArrayBuffer(Collider.getBufferSize(entityCount)),
    entityCount,
  );
  RigidBody.initializeArrays(
    new SharedArrayBuffer(RigidBody.getBufferSize(entityCount)),
    entityCount,
  );
  Collider.active[1] = 1;
  RigidBody.active[2] = 1;

  const col = Object.create(Collider.prototype);
  col.index = 1;
  const rb = Object.create(RigidBody.prototype);
  rb.index = 2;

  const colMask =
    BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS;
  const rbMask =
    BODY_DIRTY.LIFECYCLE | BODY_DIRTY.BODY_TYPE | BODY_DIRTY.MASS;

  col.active = 0;
  assert.equal(Collider.active[1], 0);
  assert.equal(flags[1] & colMask, colMask);

  flags[1] = 0;
  col.active = 0; // noop
  assert.equal(flags[1], 0);

  col.active = 1;
  assert.equal(Collider.active[1], 1);
  assert.equal(flags[1] & colMask, colMask);

  rb.active = 0;
  assert.equal(RigidBody.active[2], 0);
  assert.equal(flags[2] & rbMask, rbMask);

  flags[2] = 0;
  rb.active = 0; // noop
  assert.equal(flags[2], 0);

  rb.active = 1;
  assert.equal(RigidBody.active[2], 1);
  assert.equal(flags[2] & rbMask, rbMask);
});
