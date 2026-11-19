import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommandRingSab,
  bindCommandRing,
  enqueueSetTransform,
  enqueueSetVelocity,
  drainCommandRing,
  commandRingWritePosition,
} from '../../src/box2d/box2dCommandRing.js';

// SST-17: the ring's write position, and each SET_TRANSFORM's own position handed to its handler, so physics can tell
// the commands claimed before a sync (their setters had written the columns a body made in that sync read) from later
// ones. Positions keep counting across laps of the ring.

test('the write position counts the commands claimed; each SET_TRANSFORM reaches its handler with its position', () => {
  const sab = createCommandRingSab(4);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  bindCommandRing(sab);
  assert.equal(commandRingWritePosition(i32), 0);
  assert.equal(commandRingWritePosition(null), 0);
  const seen = [];
  const handlers = {
    setTransform: (e, x, y, c, s, position) => seen.push([e, x, y, position]),
    setVelocity: () => {},
  };
  for (let lap = 0; lap < 3; lap++) {
    enqueueSetTransform(7, lap, 1, 1, 0);
    enqueueSetVelocity(8, 1, 1);
    enqueueSetTransform(9, lap, 2, 1, 0);
    assert.equal(commandRingWritePosition(i32), (lap + 1) * 3);
    assert.equal(drainCommandRing(i32, f32, handlers), 3);
  }
  assert.deepEqual(seen, [
    [7, 0, 1, 0], [9, 0, 2, 2],
    [7, 1, 1, 3], [9, 1, 2, 5],
    [7, 2, 1, 6], [9, 2, 2, 8],
  ]);
});
