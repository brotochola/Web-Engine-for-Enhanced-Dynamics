import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criticalPathSummary, formatCriticalPath } from '../bench/criticalPath.mjs';

// E-223: tests/bench/criticalPath.mjs groups the frame clock's steps by the frame whose bell came before each started.

const FRAME = 1000 / 60;
const T0 = 1_000_000;

/** One sample a main-thread frame: its gen and t0, and the slots as given (name, gen stamped, start, end). */
function sample(frame, slots) {
  return { mainGen: frame + 1, mainT0: T0 + frame * FRAME, slots };
}
const at = (frame, ms) => T0 + frame * FRAME + ms;

test('the worker that finishes last gates the frame, by its lead over the next', () => {
  const samples = [];
  for (let f = 0; f < 3; f++) {
    samples.push(sample(f, [
      { name: 'main', gen: f + 1, start: at(f, 0), end: at(f, 0.1) },
      { name: 'physics', gen: f + 1, start: at(f, 0), end: at(f, 10) },
      { name: 'logic0', gen: f + 1, start: at(f, 0), end: at(f, 6) },
    ]));
  }
  const s = criticalPathSummary(samples);
  assert.equal(s.frames, 3);
  const physics = s.workers.find((w) => w.worker === 'physics');
  const logic = s.workers.find((w) => w.worker === 'logic0');
  assert.equal(physics.gates, 3);
  assert.equal(logic.gates, 0);
  assert.ok(Math.abs(physics.leadP50Ms - 4) < 1e-6);
  assert.ok(Math.abs(s.criticalP50Ms - 10) < 1e-6);
  assert.equal(s.framesOverBudget, 0);
  assert.ok(!s.workers.some((w) => w.worker === 'main'), 'the main thread is not a worker on the path');
  assert.match(formatCriticalPath(s), /physics\s+3\s+100 %/);
});

test('a step longer than a frame belongs to the frame it started in, and the worker skips the next', () => {
  // spatial starts in frame 0 and runs 25 ms: stampStep writes the gen seen at its end (frame 1's).
  const samples = [
    sample(0, [{ name: 'physics', gen: 1, start: at(0, 0), end: at(0, 12) }]),
    sample(1, [
      { name: 'physics', gen: 2, start: at(1, 0), end: at(1, 12) },
      { name: 'spatial0', gen: 2, start: at(0, 0), end: at(0, 25) },
    ]),
    sample(2, [
      { name: 'physics', gen: 3, start: at(2, 0), end: at(2, 12) },
      { name: 'spatial0', gen: 3, start: at(2, 0), end: at(2, 8) },
    ]),
  ];
  const s = criticalPathSummary(samples);
  assert.equal(s.frames, 3);
  const spatial = s.workers.find((w) => w.worker === 'spatial0');
  assert.equal(spatial.gates, 1);
  assert.equal(spatial.skipped, 1);
  assert.equal(spatial.overBudget, 1);
  assert.equal(s.framesOverBudget, 1);
  assert.ok(Math.abs(s.criticalP99Ms - 25) < 1e-6);
});

test('a worker that stamps its start a hair before main publishes is in that frame', () => {
  const samples = [
    sample(0, [{ name: 'physics', gen: 1, start: at(0, -0.01), end: at(0, 9) }, { name: 'logic0', gen: 1, start: at(0, 0), end: at(0, 5) }]),
    sample(1, [{ name: 'physics', gen: 2, start: at(1, -0.01), end: at(1, 9) }, { name: 'logic0', gen: 2, start: at(1, 0), end: at(1, 5) }]),
  ];
  const s = criticalPathSummary(samples);
  assert.equal(s.frames, 2);
  assert.equal(s.workers.find((w) => w.worker === 'physics').skipped, 0);
  assert.ok(Math.abs(s.criticalP50Ms - 9) < 1e-6);
});
