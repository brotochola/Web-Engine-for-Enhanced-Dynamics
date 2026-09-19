import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';

test('typeNeedsLogicTick skips inherited GameObject.tick', () => {
  class NoTick extends GameObject {}
  assert.equal(GameObject.typeNeedsLogicTick(NoTick), false);
  assert.equal(GameObject.typeNeedsLogicTick(GameObject), false);
});

test('typeNeedsLogicTick treats empty tick(){} as a real override', () => {
  class EmptyTick extends GameObject {
    tick() {}
  }
  assert.equal(GameObject.typeNeedsLogicTick(EmptyTick), true);
});

test('typeNeedsLogicTick is false when tickInterval is 0', () => {
  class ZeroInterval extends GameObject {
    static tickInterval = 0;
    tick() {}
  }
  assert.equal(GameObject.typeNeedsLogicTick(ZeroInterval), false);
});

test('typeNeedsLogicTick is true when tick has work', () => {
  class RealTick extends GameObject {
    tick() {
      this.x += 1;
    }
  }
  assert.equal(GameObject.typeNeedsLogicTick(RealTick), true);
});
