import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceImpulsePhase,
  SWAY_ANGLE_PER_MS,
  IMPULSE_DONE,
} from '../../src/util/decorationSway.js';

test('advanceImpulsePhase completes half-sine at π', { concurrency: false }, () => {
  let phase = 0;
  const freq = 10;
  const dt = 1;
  let steps = 0;
  let done = false;
  while (!done && steps < 100000) {
    const next = advanceImpulsePhase(phase, dt, freq);
    if (next === IMPULSE_DONE) {
      phase = 0;
      done = true;
    } else {
      phase = next;
    }
    steps++;
  }
  assert.equal(done, true);
  assert.equal(phase, 0);
  const expectedSteps = Math.ceil(Math.PI / (SWAY_ANGLE_PER_MS * freq));
  assert.ok(Math.abs(steps - expectedSteps) <= 1, `steps=${steps} expected≈${expectedSteps}`);
});

test('advanceImpulsePhase mid-step stays below π', { concurrency: false }, () => {
  const next = advanceImpulsePhase(0, 16, 1);
  assert.notEqual(next, IMPULSE_DONE);
  assert.ok(next > 0 && next < Math.PI);
});
