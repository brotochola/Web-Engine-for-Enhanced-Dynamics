import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSceneLiveness, readStats } from '../bench/sceneLiveness.mjs';

/**
 * These checks exist because four versions of one stress scene produced
 * confident, complete reports while measuring nothing. Every case below is
 * either one of those real failures or the shape that would have caught it.
 *
 * The failure this guards against is not a crash. It is NEUTRAL-with-a-cv,
 * which reads exactly like a legitimate negative result and gets logged as one.
 */

test('liveness: a worker reporting zeros is refused, not measured', () => {
  const r = checkSceneLiveness({
    worker: 'renderer',
    stats: 'renderer: STEP_MS 0.19 | Load 1% | VISIBLE_ENTITIES 0 | GPU_CASTERS 0 | GPU_PASSES 0.0',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_WORK');
  assert.match(r.detail, /did nothing/);
  assert.match(r.detail, /Do not log this as NEUTRAL/, 'the message must stop it being logged as a result');
});

test('liveness: the exact spritePackStressScene v1 output is refused', () => {
  // The real line from the run that produced flat 0.19 ms at 20k, 60k and 150k.
  const r = checkSceneLiveness({
    worker: 'renderer',
    stats:
      'renderer: STEP_MS 0.189 | Load 1% | GPU_PASSES 0.0 | GPU_CASTERS 0 | VISIBLE_ENTITIES 0',
  });
  assert.equal(r.code, 'NO_WORK');
});

test('saturation: 734 visible out of 60000 requested is refused', () => {
  // spritePackStressScene v3: a real number, but the same number at every
  // population, because the camera only ever saw 734 of them.
  const r = checkSceneLiveness({
    worker: 'renderer',
    stats: 'renderer: STEP_MS 0.318 | VISIBLE_ENTITIES 734 | GPU_PASSES 3.0',
    expected: 60000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_SATURATED');
  assert.match(r.detail, /734/);
  assert.match(r.detail, /60000/);
  assert.match(r.detail, /1\.2%/);
});

test('saturation: 11139 visible out of 150000 requested is refused', () => {
  const r = checkSceneLiveness({
    worker: 'renderer',
    stats: 'renderer: STEP_MS 0.486 | VISIBLE_ENTITIES 11139 | GPU_PASSES 3.0',
    expected: 150000,
  });
  assert.equal(r.code, 'NOT_SATURATED');
});

test('a genuinely deep scene passes', () => {
  const r = checkSceneLiveness({
    worker: 'renderer',
    stats: 'renderer: STEP_MS 28.4 | VISIBLE_ENTITIES 120000 | GPU_PASSES 3.0',
    expected: 150000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'OK');
});

test('a scene at just under the saturation floor is still refused', () => {
  // The floor is 25%. 24% is close enough to look deliberate and is still a
  // scene measuring a slice of the work.
  const r = checkSceneLiveness({
    worker: 'renderer',
    stats: 'renderer: STEP_MS 5.0 | VISIBLE_ENTITIES 24000',
    expected: 100000,
  });
  assert.equal(r.code, 'NOT_SATURATED');
});

test('no expected population means liveness only', () => {
  // Scenes like Predator do not take a count from the URL, so saturation cannot
  // be checked. They must still not be allowed to measure nothing.
  const r = checkSceneLiveness({
    worker: 'renderer',
    stats: 'renderer: STEP_MS 5.7 | VISIBLE_ENTITIES 42633 | GPU_CASTERS 13558',
  });
  assert.equal(r.ok, true);
});

test('an unknown worker falls back to the renderer keys rather than passing silently', () => {
  const r = checkSceneLiveness({
    worker: 'somethingNew',
    stats: 'somethingNew: STEP_MS 4.0',
  });
  assert.equal(r.ok, false, 'an unrecognised worker with no known keys must not read as OK');
  assert.equal(r.code, 'NO_WORK');
});

test('readStats pulls the numeric keys out of a console line', () => {
  const s = readStats(
    'renderer: STEP_MS 5.610 | Load 34% | GPU_PASSES 3.0 | VISIBLE_ENTITIES 42633',
  );
  assert.equal(s.STEP_MS, 5.61);
  assert.equal(s.VISIBLE_ENTITIES, 42633);
  assert.equal(s.GPU_PASSES, 3);
  // `Load` is deliberately NOT picked up: keys are all-caps identifiers, and a
  // mixed-case display label is not one. Matching it would be a false positive
  // on every line.
  assert.equal(s.Load, undefined);
});

test('readStats tolerates a line with no keys at all', () => {
  const s = readStats('renderer: nothing parseable here');
  assert.deepEqual(Object.keys(s).filter((k) => Number.isNaN(s[k])), []);
  const r = checkSceneLiveness({ worker: 'renderer', stats: 'renderer: nothing parseable here' });
  assert.equal(r.code, 'NO_WORK');
});