import test from 'node:test';
import assert from 'node:assert/strict';

import { compareSceneParams, mismatchMessage } from '../bench/sceneParams.mjs';

/**
 * F-07. Every fixture below is the actual failure, not a shape invented to
 * exercise the branch.
 *
 * `spritePackStressScene` read its population from `location.search` while the
 * runner put the query on `--scene`, where it landed in the module specifier.
 * The scene used its 60000 default and reported a healthy STEP_MS with exit 0,
 * for every one of seven runs. A "20k/60k/150k sweep" that was one scene.
 */

test('a scene that received the requested population passes', () => {
  const m = compareSceneParams(
    { sprites: 65535, spacing: 16, scale: 1 },
    'sprites=65535&spacing=16&scale=1',
  );
  assert.deepEqual(m, []);
});

test('the silent fallback is caught: 150000 requested, 60000 used', () => {
  // The exact F-07 failure, at the exact numbers from the run.
  const m = compareSceneParams({ sprites: 60000 }, 'sprites=150000');
  assert.equal(m.length, 1);
  assert.match(m[0], /sprites: requested 150000, scene used 60000/);
});

test('an unrequested parameter is the scene default and is not a mismatch', () => {
  // `scale=1` was never asked for; the scene chose it. Nothing to check.
  const m = compareSceneParams({ sprites: 60000, scale: 1 }, 'sprites=60000');
  assert.deepEqual(m, []);
});

test('a scene that declares nothing is not failed', () => {
  // Opt-in: a scene that does not export stressSceneConfig cannot be checked,
  // and refusing every such scene would break every existing bench.
  assert.deepEqual(compareSceneParams(null, 'sprites=150000'), []);
});

test('string parameters compare as strings', () => {
  const m = compareSceneParams({ mode: 'dense' }, 'mode=sparse');
  assert.equal(m.length, 1);
  assert.match(m[0], /mode: requested sparse, scene used dense/);
});

test('numeric strings compare numerically, so 16000 is not a mismatch for 1.6e4', () => {
  assert.deepEqual(compareSceneParams({ sprites: 1.6e4 }, 'sprites=16000'), []);
});

test('every mismatching parameter is reported, not just the first', () => {
  // One at a time is how a scene with two wrong knobs gets half-fixed.
  const m = compareSceneParams({ sprites: 60000, spacing: 24 }, 'sprites=150000&spacing=8');
  assert.equal(m.length, 2);
  assert.ok(m.some((x) => x.startsWith('sprites:')));
  assert.ok(m.some((x) => x.startsWith('spacing:')));
});

test('the message names both ways to pass parameters', () => {
  const msg = mismatchMessage(['sprites: requested 150000, scene used 60000']);
  assert.match(msg, /SCENE PARAMETER MISMATCH/);
  assert.match(msg, /--scene lands in the module specifier/);
  assert.match(msg, /--query/);
  assert.match(msg, /stressSceneConfig\.requested/);
});

test('a URLSearchParams is accepted as well as a string', () => {
  const m = compareSceneParams(
    { sprites: 60000 },
    new URLSearchParams('sprites=150000'),
  );
  assert.equal(m.length, 1);
});