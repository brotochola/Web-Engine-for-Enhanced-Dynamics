import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMovedBodiesSab,
  bindMovedBodies,
  getMovedBodiesViews,
  publishMovedBodies,
  readStableMoved,
} from '../../src/box2d/box2dMovedBodies.js';

test('moved bodies SAB: odd entityCount pads to 4-byte multiple', { concurrency: false }, () => {
  const sab = createMovedBodiesSab(9);
  assert.equal(sab.byteLength % 4, 0);

  const views = bindMovedBodies(sab);
  assert.ok(views);
  assert.equal(views.entityCapacity, 9);
  assert.equal(views.movedList.length, 9);
  assert.equal(views.movedBits.length, 9);
  assert.equal(views.fellAsleep.length, 9);

  const bound = getMovedBodiesViews();
  assert.equal(bound.entityCapacity, 9);
});

test('publishMovedBodies leaves an even generation and a stable copy', { concurrency: false }, () => {
  const sab = createMovedBodiesSab(4);
  bindMovedBodies(sab);
  const slots = new Int32Array([1, 3]);
  const asleep = new Uint8Array([0, 1]);
  const n = publishMovedBodies(slots, asleep, 2, null, 0, null, 7);
  assert.equal(n, 2);
  const views = getMovedBodiesViews();
  assert.equal(views.generation & 1, 0);
  assert.equal(views.count, 2);
  const scratch = new Uint32Array(4);
  const stable = readStableMoved(scratch);
  assert.ok(stable);
  assert.equal(stable.poseStamp, 7);
  assert.equal(stable.count, 2);
  assert.equal(scratch[0], 1);
  assert.equal(scratch[1], 3);
});
