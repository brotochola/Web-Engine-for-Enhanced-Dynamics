import test from 'node:test';
import assert from 'node:assert/strict';

import { ChainPoints } from '../../src/core/chainPoints.js';
import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';

function init(entityCount) {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(entityCount)), entityCount);
  Transform.x = new Float32Array(entityCount);
  Transform.y = new Float32Array(entityCount);
  Transform.rotC = new Float32Array(entityCount);
  Transform.rotS = new Float32Array(entityCount);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entityCount)), entityCount);
  ChainPoints.initializeArrays(
    new SharedArrayBuffer(ChainPoints.getBufferSize(16, entityCount)),
    16,
    entityCount,
  );
}

function place(index, points, loop, { x = 0, y = 0, rotC = 1, rotS = 0, offX = 0, offY = 0 } = {}) {
  ChainPoints.begin[index] = 0;
  ChainPoints.count[index] = points.length / 2;
  ChainPoints.loop[index] = loop ? 1 : 0;
  ChainPoints.xy.set(points, 0);
  Transform.x[index] = x;
  Transform.y[index] = y;
  Transform.rotC[index] = rotC;
  Transform.rotS[index] = rotS;
  Collider.offsetX[index] = offX;
  Collider.offsetY[index] = offY;
}

// Expected values below are worked out from world geometry, not read back from the code.
// A chain is one-sided: a ray hits an edge only from the edge's outer (right-hand) side,
// so a ray that starts inside a loop passes through it.

test('an unrotated loop: hits from outside, misses when pointing away or starting inside', () => {
  init(1);
  place(0, new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]), true);
  assert.equal(ChainPoints.rayDistance(0, -5, 5, 1, 0, 80), 5, 'enters through x = 0');
  assert.equal(ChainPoints.rayDistance(0, 5, 15, 0, -1, 80), 5, 'enters through y = 10');
  assert.equal(ChainPoints.rayDistance(0, 15, 5, -1, 0, 80), 5, 'enters through x = 10');
  assert.equal(ChainPoints.rayDistance(0, -5, 5, 1, 0, 4), -1, 'shorter than the gap');
  assert.equal(ChainPoints.rayDistance(0, -8, -3, 0, -1, 80), -1, 'pointing away from the loop');
  assert.equal(ChainPoints.rayDistance(0, -5, 5, -1, 0, 80), -1, 'pointing away, edge behind it');
  assert.equal(ChainPoints.rayDistance(0, 5, 5, 1, 0, 80), -1, 'starts inside: one-sided chain');
  assert.equal(ChainPoints.rayDistance(0, -5, 20, 1, 0, 80), -1, 'passes beside the loop');
});

test('a rotated, offset loop matches the world-space hit distances', () => {
  init(1);
  // Body at (100 + 2, 200 + 3) after the rotated offset; 90 degrees maps local (lx, ly)
  // to world (102 - ly, 203 + lx), so the square covers x in [92, 102], y in [203, 213].
  place(0, new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]), true, {
    x: 100, y: 200, rotC: 0, rotS: 1, offX: 3, offY: -2,
  });
  assert.equal(ChainPoints.rayDistance(0, 80, 205, 1, 0, 50), 12, 'enters through x = 92');
  assert.equal(ChainPoints.rayDistance(0, 97, 230, 0, -1, 80), 17, 'enters through y = 213');
  assert.equal(ChainPoints.rayDistance(0, 105, 195, 1, 0, 80), -1, 'y = 195 never meets the square');
  assert.equal(ChainPoints.rayDistance(0, 90, 195, 0, -1, 80), -1, 'x = 90 never meets the square');
  assert.equal(ChainPoints.pointNear(0, 100, 205), true);
  assert.equal(ChainPoints.pointNear(0, 0, 0), false);
});

test('an open chain uses only its inner edges and is one-sided', () => {
  init(1);
  // Ghost vertices first and last: the only edge is local (0,10) -> (20,10), which the
  // same transform puts at world x = 92, y in [203, 223], facing +x.
  place(0, new Float32Array([0, 0, 0, 10, 20, 10, 20, 0]), false, {
    x: 100, y: 200, rotC: 0, rotS: 1, offX: 3, offY: -2,
  });
  assert.equal(ChainPoints.rayDistance(0, 110, 210, -1, 0, 80), 18, 'front side hit');
  assert.equal(ChainPoints.rayDistance(0, 80, 210, 1, 0, 80), -1, 'back side passes through');
  assert.equal(ChainPoints.rayDistance(0, 93, 183, 1, 0, 80), -1, 'beside the edge');
  assert.equal(ChainPoints.pointNear(0, 92, 210), true);
  assert.equal(ChainPoints.pointNear(0, 0, 0), false);
});
