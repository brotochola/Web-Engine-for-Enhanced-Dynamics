import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';

test('GameObject.deriveSpeed defaults false; subclass opt-in', () => {
  assert.equal(GameObject.deriveSpeed, false);

  class NeedsSpeed extends GameObject {
    static deriveSpeed = true;
  }
  class Quiet extends GameObject {}

  assert.equal(NeedsSpeed.deriveSpeed, true);
  assert.equal(Quiet.deriveSpeed, false);
  assert.equal(Quiet.deriveSpeed === true, false);
});
