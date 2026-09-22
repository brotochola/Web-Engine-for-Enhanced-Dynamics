import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMovedBodiesSab,
  bindMovedBodies,
  getMovedBodiesViews,
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
