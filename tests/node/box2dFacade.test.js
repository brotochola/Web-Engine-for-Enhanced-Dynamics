import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommandRingSab,
  bindCommandRing,
  drainCommandRing,
  BOX2D_CMD,
} from '../../src/box2d/box2dCommandRing.js';
import { bindMovedBodies } from '../../src/box2d/box2dMovedBodies.js';
import { Box2d } from '../../src/core/box2d.js';

test('Box2d.explode enqueues EXPLODE on the command ring', { concurrency: false }, () => {
  const ring = createCommandRingSab(32);
  bindCommandRing(ring);
  const i32 = new Int32Array(ring);
  const f32 = new Float32Array(ring);

  Box2d.explode({
    x: 10,
    y: 20,
    radius: 50,
    impulsePerLength: 3,
    maskBits: 0x00ff00ff,
  });

  assert.equal(BOX2D_CMD.EXPLODE, 6);

  let calls = 0;
  drainCommandRing(i32, f32, {
    explode(maskBits, x, y, radius, impulse) {
      calls++;
      assert.equal(maskBits, 0x00ff00ff);
      assert.equal(x, 10);
      assert.equal(y, 20);
      assert.equal(radius, 50);
      assert.equal(impulse, 3);
    },
  });
  assert.equal(calls, 1);
});

test('Box2d.getMovedBodies without bind returns empty list', { concurrency: false }, () => {
  bindMovedBodies(null);
  const moved = Box2d.getMovedBodies();
  assert.equal(moved.count, 0);
  assert.equal(moved.list.length, 0);
  assert.equal(moved.generation, 0);
  assert.equal(moved.bits, null);
  assert.equal(moved.fellAsleep, null);
});
