import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createCommandRingSab,
  bindCommandRing,
  drainCommandRing,
  enqueueSetRadialGravity,
} from '../../src/box2d/box2dCommandRing.js';

// N-17. The planet's water pull sent one force command per particle per logic
// tick: ~4000 of the ring's 4096 slots, tied to logic ticks instead of physics
// steps. LiquidFun.setRadialGravity(x, y, accel) is one command; the physics
// host keeps it and adds the pull to every particle's velocity before each step.

test('setRadialGravity reaches the host as one command', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  assert.ok(enqueueSetRadialGravity(4500, 4400, 1800));
  assert.ok(enqueueSetRadialGravity(1, 2, Number.NaN), 'a bad accel turns it off rather than poisoning it');
  const seen = [];
  drainCommandRing(new Int32Array(sab), new Float32Array(sab), {
    setRadialGravity: (x, y, accel) => seen.push([x, y, accel]),
  });
  assert.deepEqual(seen, [[4500, 4400, 1800], [1, 2, 0]]);
});

test('the host pulls each particle toward the point by accel × dt', () => {
  const post = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');
  const start = post.indexOf('// radial-gravity-start');
  const end = post.indexOf('// radial-gravity-end');
  assert.ok(start > 0 && end > start, 'radial gravity block missing in weedjsPost.js');
  // A fake WASM heap: the x, y, vx, vy columns of 3 particles start at floats
  // 1, 9, 17 and 25 (offset 0 means "no buffer" to the host).
  const X = 1, Y = 9, VX = 17, VY = 25;
  const heap = new Float32Array(32);
  heap.set([10, 0, 5], X);
  heap.set([0, 10, 0], Y);
  heap.set([1, 1, 1], VX);
  const world = {
    getParticleCount: () => 3,
    getParticleXByteOffset: () => X * 4,
    getParticleYByteOffset: () => Y * 4,
    getParticleVxByteOffset: () => VX * 4,
    getParticleVyByteOffset: () => VY * 4,
  };
  const apply = new Function(
    'world', 'Module', 'radialGravityX', 'radialGravityY', 'radialGravityAccel',
    `${post.slice(start, end)}\nreturn applyRadialGravity;`,
  )(world, { HEAPF32: heap }, 5, 0, 100);
  apply(0.5); // 100 px/s² for half a second: 50 px/s toward (5, 0)
  const near = (i, vx, vy, msg) => {
    assert.ok(Math.abs(heap[VX + i] - vx) < 1e-4 && Math.abs(heap[VY + i] - vy) < 1e-4,
      `${msg}: got (${heap[VX + i]}, ${heap[VY + i]})`);
  };
  near(0, 1 - 50, 0, 'particle at (10, 0)');
  near(1, 1 + 50 * (5 / Math.sqrt(125)), 50 * (-10 / Math.sqrt(125)), 'particle at (0, 10)');
  near(2, 1, 0, 'a particle on the centre is left alone');
});
