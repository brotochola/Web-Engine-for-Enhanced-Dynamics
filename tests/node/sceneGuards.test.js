// DX-GUARDS C8, C9: a scene config that works as written and still shows what the game did not mean.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';

function warningsOf(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    resetWarnOnce();
    fn();
  } finally {
    console.warn = saved;
  }
  return lines;
}

class Lamp extends GameObject {}
const WORLD = { worldWidth: 2000, worldHeight: 2000 };
const sceneWith = (config) => class Cave extends Scene {
  static entities = [[Lamp, 4]];
  static config = { ...WORLD, ...config };
};

test('C8: lighting on with the default ambient and no sun is named', () => {
  assert.deepEqual(warningsOf(() => new (sceneWith({ lighting: { enabled: true } }))({})), [
    'WeedJS: Cave turns lighting on with the default baseAmbient (0.05) and no sun, so what no light reaches is drawn ' +
      'almost black. Set lighting.baseAmbient (0 to 1), or lighting.sun: { enabled: true }.',
  ]);
});

test('C8: an ambient set by the scene, a sun, or lighting off is silent', () => {
  for (const lighting of [
    { enabled: true, baseAmbient: 0.05 },
    { enabled: true, baseAmbient: 0.4 },
    { enabled: true, sun: { enabled: true } },
    { enabled: false },
    {},
  ]) {
    assert.deepEqual(warningsOf(() => new (sceneWith({ lighting }))({})), [], JSON.stringify(lighting));
  }
  assert.deepEqual(warningsOf(() => new (sceneWith({}))({})), [], 'no lighting key');
});
