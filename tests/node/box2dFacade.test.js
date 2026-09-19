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
import { Ray } from '../../src/core/ray.js';

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

test('Box2d.explode accepts positional x,y,radius,impulse', { concurrency: false }, () => {
  const ring = createCommandRingSab(32);
  bindCommandRing(ring);
  const i32 = new Int32Array(ring);
  const f32 = new Float32Array(ring);

  assert.equal(Box2d.explode(11, 22, 40, 4), true);

  let calls = 0;
  drainCommandRing(i32, f32, {
    explode(maskBits, x, y, radius, impulse) {
      calls++;
      assert.equal(maskBits >>> 0, 0xffffffff);
      assert.equal(x, 11);
      assert.equal(y, 22);
      assert.equal(radius, 40);
      assert.equal(impulse, 4);
    },
  });
  assert.equal(calls, 1);
});

test('Box2d.explode rejects a lone number (old console footgun) and NaN', { concurrency: false }, () => {
  const ring = createCommandRingSab(32);
  bindCommandRing(ring);
  const i32 = new Int32Array(ring);
  const f32 = new Float32Array(ring);

  assert.equal(Box2d.explode(100), false);
  assert.equal(Box2d.explode(1, 2, NaN, 10), false);
  assert.equal(Box2d.explode({ x: 1, y: 2, radius: 0, impulsePerLength: 10 }), false);

  let calls = 0;
  drainCommandRing(i32, f32, {
    explode() { calls++; },
  });
  assert.equal(calls, 0);
});

test('Ray work does not increment Box2d ray stats', { concurrency: false }, () => {
  const prevRay = Ray.collectDetailedStats;
  const prevBox = Box2d.collectDetailedStats;
  Ray.collectDetailedStats = true;
  Box2d.collectDetailedStats = true;
  try {
    Ray.beginFrame();
    Box2d.beginFrame();
    Ray._enterStats();
    Ray._leaveStats();
    const ray = Ray.consumeStats();
    const box = Box2d.consumeStats();
    assert.equal(ray.count, 1);
    assert.equal(box.count, 0);
    assert.equal(box.ms, 0);
  } finally {
    Ray.collectDetailedStats = prevRay;
    Box2d.collectDetailedStats = prevBox;
  }
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
