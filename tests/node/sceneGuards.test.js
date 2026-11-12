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

test('C9: no world size and a canvas bigger than the default world is named, once the canvas is known', () => {
  const Open = class Open extends Scene {
    static entities = [[Lamp, 4]];
    static config = {};
  };
  const lines = warningsOf(() => {
    const scene = new Open({});
    scene.config.canvasWidth = 1280;
    scene.config.canvasHeight = 720;
    scene._warnSmallWorld();
  });
  assert.deepEqual(lines, [
    'WeedJS: Open sets no worldWidth, so the world is the default 1000 × 1000, smaller than the 1280 × 720 canvas: ' +
      'the camera cannot zoom out past 1.28. Set config.worldWidth to the size of the world.',
  ]);
  const both = warningsOf(() => {
    const scene = new Open({});
    scene.config.canvasWidth = 1920;
    scene.config.canvasHeight = 1080;
    scene._warnSmallWorld();
  });
  assert.match(both[0], /sets no worldWidth and worldHeight, .* past 1\.92\. Set config\.worldWidth and worldHeight to/);
});

test('C9: a world size the scene sets, or a canvas inside the default world, is silent', () => {
  for (const [config, w, h] of [[WORLD, 1920, 1080], [{ worldWidth: 800, worldHeight: 600 }, 1920, 1080], [{}, 800, 600]]) {
    const S = class Sized extends Scene {
      static entities = [[Lamp, 4]];
      static config = config;
    };
    assert.deepEqual(warningsOf(() => {
      const scene = new S({});
      scene.config.canvasWidth = w;
      scene.config.canvasHeight = h;
      scene._warnSmallWorld();
    }), [], JSON.stringify(config));
  }
});
