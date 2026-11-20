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

// N-247: every isPressed / isDown ran _normalizeKeyName's toLowerCase, a new string per call (341 B a frame in
// burningBoxes). A name is resolved once now; the reads after it normalize nothing and answer the same.
test('a key name is normalized once, not on every read', () => {
  const data = new Int32Array(16);
  Keyboard.initialize(data, makeMap());
  const lower = String.prototype.toLowerCase;
  let calls = 0;
  String.prototype.toLowerCase = function () {
    calls++;
    return lower.call(this);
  };
  try {
    data[2] = 1;
    data[3] = 1;
    for (let frame = 0; frame < 3; frame++) {
      assert.equal(Keyboard.isDown('ArrowUp'), true);
      assert.equal(Keyboard.isDown('Space'), true);
      assert.equal(Keyboard.isPressed('ArrowUp'), false);
      assert.equal(Keyboard.isDown('m'), false);
      assert.equal(Keyboard.isDown('nokey'), false);
    }
    assert.equal(calls, 4, 'one toLowerCase a name, on its first read');
  } finally {
    String.prototype.toLowerCase = lower;
  }
  assert.equal(Keyboard.isDown('constructor'), false, "a plain object's own names are not keys");
  Keyboard.initialize(data, { arrowup: 7 });
  data[7] = 1;
  assert.equal(Keyboard.isDown('ArrowUp'), true, 'a new map resolves names again');
  assert.equal(Keyboard.isDown('m'), false);
});
