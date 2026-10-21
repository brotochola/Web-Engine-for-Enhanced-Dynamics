import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsDebugRenderer } from '../../src/core/debug/rendering/physicsDebugRenderer.js';

// Review G7. Debug labels drew through a closure made per label (per entity
// for the index labels). They draw through one helper with no closure now;
// this pins what it draws.

function recorder() {
  const log = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (...a) => log.push(`${String(k)}(${a.join(',')})`),
    set: (_, k, v) => {
      log.push(`${String(k)}=${v}`);
      return true;
    },
  });
  return { ctx, log };
}

test('an upright label on a level camera is its box and its text', () => {
  const { ctx, log } = recorder();
  new PhysicsDebugRenderer()._uprightLabel(ctx, { rotation: 0 }, 'id 7', 50, 40, 'white', 'black', 20, 2, -12, 14);
  assert.deepEqual(log, ['fillStyle=black', 'fillRect(38,28,24,14)', 'fillStyle=white', 'fillText(id 7,50,40)']);
});

test('on a turned camera the label turns back around its anchor', () => {
  const { ctx, log } = recorder();
  new PhysicsDebugRenderer()._uprightLabel(ctx, { rotation: 0.5 }, 'v', 10, 20, 'blue', null, 0, 0, 0, 0);
  assert.deepEqual(log, ['save()', 'translate(10,20)', 'rotate(-0.5)', 'translate(-10,-20)', 'fillStyle=blue', 'fillText(v,10,20)', 'restore()']);
});
