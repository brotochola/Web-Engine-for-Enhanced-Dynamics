import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCommandRingSab,
  bindCommandRing,
  enqueueSetVelocity,
  drainCommandRing,
  readCommandRingOverflow,
} from '../../src/box2d/box2dCommandRing.js';

// N-16. A full command ring drops the command (enqueue returns false and bumps
// an overflow counter), but nothing read the counter, so velocities, forces and
// teleports vanished without a word. The drain now warns once per ring.

test('a full ring reports how many commands it dropped, once', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  let accepted = 0;
  for (let k = 0; k < 70; k++) if (enqueueSetVelocity(k, 1, 2)) accepted++;
  assert.equal(accepted, 64);
  assert.equal(readCommandRingOverflow(i32), 6);

  const warnings = [];
  const saved = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    let seen = 0;
    assert.equal(drainCommandRing(i32, f32, { setVelocity: () => { seen++; } }), 64);
    assert.equal(seen, 64);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /6 command/);
    assert.match(warnings[0], /capacity 64/);
    assert.match(warnings[0], /physics\.commandRingCapacity/);

    for (let k = 0; k < 70; k++) enqueueSetVelocity(k, 1, 2);
    drainCommandRing(i32, f32, {});
    assert.equal(warnings.length, 1, 'warned once per ring');
    assert.equal(readCommandRingOverflow(i32), 12, 'still counted');
  } finally {
    console.warn = saved;
    bindCommandRing(null);
  }
});

test('a ring that never fills stays quiet', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const warnings = [];
  const saved = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (let k = 0; k < 10; k++) enqueueSetVelocity(k, 1, 2);
    drainCommandRing(new Int32Array(sab), new Float32Array(sab), {});
    assert.equal(warnings.length, 0);
    assert.equal(readCommandRingOverflow(new Int32Array(sab)), 0);
  } finally {
    console.warn = saved;
    bindCommandRing(null);
  }
});
