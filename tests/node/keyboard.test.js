import test from 'node:test';
import assert from 'node:assert/strict';

import { Keyboard } from '../../src/core/keyboard.js';

function makeMap() {
  return {
    m: 0,
    a: 1,
    arrowup: 2,
    ' ': 3,
    control: 4,
    enter: 5,
  };
}

test('Keyboard.m / M / arrowup / space getters follow SAB', () => {
  const map = makeMap();
  const data = new Int32Array(16);
  Keyboard.initialize(data, map);

  assert.equal(Keyboard.m, false);
  assert.equal(Keyboard.M, false);
  data[0] = 1;
  assert.equal(Keyboard.m, true);
  assert.equal(Keyboard.M, true);
  assert.equal(Keyboard.isDown('m'), true);

  assert.equal(Keyboard.arrowup, false);
  data[2] = 1;
  assert.equal(Keyboard.arrowup, true);

  data[3] = 1;
  assert.equal(Keyboard.space, true);
  assert.equal(Keyboard.SPACE, true);
  assert.equal(Keyboard.Space, true);
  assert.equal(Keyboard.isDown(' '), true);

  data[4] = 1;
  assert.equal(Keyboard.ctrl, true);
  assert.equal(Keyboard.isDown('control'), true);

  Keyboard.initialize(null);
  assert.equal(Keyboard.m, undefined);
  assert.equal(Keyboard.isDown('m'), false);
});

test('updateEdgeFlags latches isPressed from press counters', () => {
  const map = { m: 0 };
  const data = new Int32Array(4);
  Keyboard.initialize(data, map);

  data[1] = 1;
  Keyboard.updateEdgeFlags();
  assert.equal(Keyboard.isPressed('m'), true);

  Keyboard.updateEdgeFlags();
  assert.equal(Keyboard.isPressed('m'), false);

  data[1] = 2;
  Keyboard.updateEdgeFlags();
  assert.equal(Keyboard.isPressed('m'), true);

  Keyboard.initialize(null);
});
