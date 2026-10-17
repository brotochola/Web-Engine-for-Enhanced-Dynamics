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

function pose(index, points, loop) {
  ChainPoints.begin[index] = 0;
  ChainPoints.count[index] = points.length / 2;
  ChainPoints.loop[index] = loop ? 1 : 0;
  ChainPoints.xy.set(points, 0);
  Transform.x[index] = 100;
  Transform.y[index] = 200;
  Transform.rotC[index] = 0;
  Transform.rotS[index] = 1;
  Collider.offsetX[index] = 3;
  Collider.offsetY[index] = -2;
}

test('a rotated loop and an open chain match the world-space hit distances', () => {
  init(1);
  pose(0, new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]), true);
  assert.equal(ChainPoints.rayDistance(0, 105, 195, 1, 0, 80), 3);
  assert.equal(ChainPoints.rayDistance(0, 90, 195, 0, -1, 80), 8);
  assert.equal(ChainPoints.rayDistance(0, 80, 205, 1, 0, 50), -1);
  assert.equal(ChainPoints.pointNear(0, 100, 205), true);
  assert.equal(ChainPoints.pointNear(0, 0, 0), false);

  pose(0, new Float32Array([0, 0, 0, 10, 20, 10, 20, 0]), false);
  assert.equal(ChainPoints.rayDistance(0, 93, 183, 1, 0, 80), 1);
  assert.equal(ChainPoints.pointNear(0, 92, 210), true);
  assert.equal(ChainPoints.pointNear(0, 0, 0), false);
});
