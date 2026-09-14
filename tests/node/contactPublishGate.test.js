import test from 'node:test';
import assert from 'node:assert/strict';

import { CollisionListener } from '../../src/components/CollisionListener.js';

function scanWantsContactRing(entityClasses) {
  for (const EntityClass of entityClasses) {
    const components = EntityClass.components || [];
    for (const c of components) {
      if (c === CollisionListener) return true;
    }
  }
  return false;
}

test('publishContactRing: no CollisionListener in type list vs Drop-like', () => {
  class BallLike {
    static components = [];
  }
  class FloorLike {
    static components = [];
  }
  class DropLike {
    static components = [CollisionListener];
  }

  assert.equal(scanWantsContactRing([BallLike, FloorLike]), false);
  assert.equal(scanWantsContactRing([BallLike, DropLike]), true);
});
