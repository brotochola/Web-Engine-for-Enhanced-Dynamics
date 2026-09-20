import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import {
  createWeedPosePayload,
  bindWeedPoseFields,
  initWeedPoseDefaults,
} from '../../src/box2d/box2dHotFields.js';
import { Box2d } from '../../src/core/box2d.js';

test('weed pose SAB backs Transform.x/y without Box2D HEAP', () => {
  const payload = createWeedPosePayload(4);
  initWeedPoseDefaults(payload);
  assert.equal(Transform.rotC[0], 1);
  Transform.x[0] = 12;
  Transform.y[1] = 34;
  bindWeedPoseFields(payload);
  assert.equal(Transform.x[0], 12);
  assert.equal(Transform.y[1], 34);
});

test('Box2d.queryAABB throws a clear error when the physics worker is absent', () => {
  const prev = Box2d.physicsWorkerAbsent;
  Box2d.physicsWorkerAbsent = true;
  try {
    assert.throws(
      () => Box2d.queryAABB(0, 0, 1, 1, []),
      /physics worker absent/,
    );
  } finally {
    Box2d.physicsWorkerAbsent = prev;
  }
});

test('Box2d.explode throws when the physics worker is absent', () => {
  const prev = Box2d.physicsWorkerAbsent;
  Box2d.physicsWorkerAbsent = true;
  try {
    assert.throws(
      () => Box2d.explode({ x: 0, y: 0, radius: 10, impulsePerLength: 1 }),
      /physics worker absent/,
    );
  } finally {
    Box2d.physicsWorkerAbsent = prev;
  }
});
