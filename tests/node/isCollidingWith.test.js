import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { collisionPairKey } from '../../src/util/utils.js';

test('isCollidingWith uses collisionPairKey, not Cantor', () => {
  const previousSelf = globalThis.self;
  const a = 3;
  const b = 12;
  const key = collisionPairKey(Math.min(a, b), Math.max(a, b));
  const frameCollisions = new Set([key]);

  globalThis.self = { logicWorker: { frameCollisions } };
  try {
    const obj = Object.create(GameObject.prototype);
    obj.index = a;
    assert.equal(obj.isCollidingWith(b), true);
    assert.equal(obj.isCollidingWith(99), false);

    const other = Object.create(GameObject.prototype);
    other.index = b;
    assert.equal(obj.isCollidingWith(other), true);
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

test('collisionPairKey is order-normalized by callers (min, max)', () => {
  assert.notEqual(collisionPairKey(1, 2), collisionPairKey(2, 1));
  const min = 1;
  const max = 2;
  assert.equal(collisionPairKey(min, max), (1 << 16) | 2);
});
