import test from 'node:test';
import assert from 'node:assert/strict';

import { getFeature } from '../bench/engineFeatureCatalog.mjs';
import { KERNEL_SAMPLE_MS, STEP_MS_FLOOR } from '../bench/benchmarkDefaults.mjs';
import {
  stepMsFloorOk,
  usesStressStepFloor,
} from '../bench/measureLib.mjs';
import { timeIt } from '../bench/microbenchHelpers.mjs';

test('STEP_MS_FLOOR is 6 ms (the owner, 2026-11-13); a kernel sample lasts 3 ms', () => {
  assert.equal(STEP_MS_FLOOR, 6);
  assert.equal(KERNEL_SAMPLE_MS, 3);
});

test('usesStressStepFloor follows catalog kind', () => {
  assert.equal(usesStressStepFloor(getFeature('emit').scene), true);
  assert.equal(usesStressStepFloor(getFeature('bullets').scene), true);
  assert.equal(usesStressStepFloor(getFeature('compute').scene), true);
  assert.equal(usesStressStepFloor(getFeature('box2d').scene), false);
  assert.equal(usesStressStepFloor(getFeature('steadyCombat').scene), false);
  assert.equal(usesStressStepFloor(getFeature('visPoly').scene), false);
  assert.equal(usesStressStepFloor(getFeature('decorations').scene), true);
  assert.equal(usesStressStepFloor({ path: '/demos/predatorScene/predatorScene.js', headed: true }), false);
  assert.equal(
    usesStressStepFloor({
      path: '/tests/bench/stressScenes/bulletStressScene.js',
      headed: false,
    }),
    true
  );
});

test('stepMsFloorOk fails when a ms primary is under the floor (6 ms)', () => {
  const cheap = { particle_STEP_MS: { median: 0.277, cv: 0 } };
  const okLoad = { particle_STEP_MS: { median: 7.2, cv: 0 } };
  const miss = stepMsFloorOk(cheap, okLoad, ['particle_STEP_MS']);
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /^step floor:/);
  assert.equal(miss.hits[0].side, 'baseline');
  assert.equal(miss.hits[0].key, 'particle_STEP_MS');

  const bothOk = stepMsFloorOk(okLoad, { particle_STEP_MS: { median: 6, cv: 0 } }, ['particle_STEP_MS']);
  assert.equal(bothOk.ok, true);

  const winAteFloor = stepMsFloorOk(okLoad, { particle_STEP_MS: { median: 1.2, cv: 0 } }, ['particle_STEP_MS']);
  assert.equal(winAteFloor.ok, true);

  const countsIgnored = stepMsFloorOk(
    { ACTIVE_PARTICLES: { median: 12, cv: 0 } },
    { ACTIVE_PARTICLES: { median: 12, cv: 0 } },
    ['ACTIVE_PARTICLES']
  );
  assert.equal(countsIgnored.ok, true);
});

test('timeIt raises iterations until the sample lasts at least KERNEL_SAMPLE_MS (3 ms)', () => {
  const result = timeIt(
    'floor-probe',
    (n) => {
      let x = 0;
      for (let i = 0; i < n; i++) x += i;
      if (x === -1) throw new Error('unreachable');
    },
    { iterations: 1, warmup: 0, reps: 3, silent: true }
  );
  assert.ok(result.ms >= KERNEL_SAMPLE_MS, `sample ${result.ms} ms`);
  assert.ok(result.iterations > 1, 'iterations should grow from 1');
});
