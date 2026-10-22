import test from 'node:test';
import assert from 'node:assert/strict';

const { Scene } = await import('../../src/core/scene.js');

// DX 3.6. Nothing told a loading screen how far a scene was. Scene.onLoadProgress
// (and loadScene's onProgress) get one call per finished boot step.

function bareScene(hook, option = null) {
  const scene = Object.create(Scene.prototype);
  scene._loadStepsDone = 0;
  scene._onProgressOption = option;
  scene.onLoadProgress = hook;
  return scene;
}

test('every step reports done / total and its name; the last one is world', () => {
  const calls = [];
  const viaOption = [];
  const scene = bareScene(
    (done, total, stage) => calls.push([done, total, stage]),
    (done, total, stage) => viaOption.push([done, total, stage])
  );
  for (const stage of Scene.LOAD_STEPS) scene._loadStep(stage);
  const total = Scene.LOAD_STEPS.length;
  assert.equal(calls.length, total);
  assert.deepEqual(calls[0], [1, total, 'audio']);
  assert.deepEqual(calls[total - 1], [total, total, 'world']);
  assert.deepEqual(viaOption, calls, 'loadScene({ onProgress }) sees the same calls');
});

test('a throwing progress hook is logged and loading goes on', () => {
  const original = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a[0]);
  let seen = 0;
  try {
    const scene = bareScene(() => {
      seen++;
      throw new Error('loading bar broke');
    });
    scene._loadStep('audio');
    scene._loadStep('scripts');
  } finally {
    console.error = original;
  }
  assert.equal(seen, 2);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /onLoadProgress threw/);
});
