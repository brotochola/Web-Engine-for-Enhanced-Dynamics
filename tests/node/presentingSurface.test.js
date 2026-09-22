import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { Scene } from '../../src/core/scene.js';
import { usableCanvasSize } from '../../src/util/utils.js';

function fakeScene() {
  const posts = [];
  const scene = {
    workers: {
      renderer: { postMessage: (data) => posts.push(['renderer', data]) },
      physics: { postMessage: (data) => posts.push(['physics', data]) },
    },
    config: {},
    getAllWorkers() {
      return [this.workers.renderer, this.workers.physics];
    },
  };
  return { scene, posts };
}

test('usableCanvasSize rejects empty minimize sizes', () => {
  assert.equal(usableCanvasSize(800, 600), true);
  assert.equal(usableCanvasSize(1, 1), true);
  assert.equal(usableCanvasSize(0, 600), false);
  assert.equal(usableCanvasSize(800, 0), false);
  assert.equal(usableCanvasSize(-2, 400), false);
  assert.equal(usableCanvasSize(Number.NaN, 600), false);
});

test('Scene.setPresenting posts only to the renderer', () => {
  const { scene, posts } = fakeScene();
  Scene.prototype.setPresenting.call(scene, false);
  assert.deepEqual(posts, [['renderer', { msg: 'presenting', value: false }]]);
});

test('Scene.rebindSurface posts only to the renderer', () => {
  const { scene, posts } = fakeScene();
  Scene.prototype.rebindSurface.call(scene);
  assert.deepEqual(posts, [['renderer', { msg: 'rebindSurface' }]]);
});

test('Scene.resize skips a 0x0 canvas and does not post', () => {
  const { scene, posts } = fakeScene();
  Scene.prototype.resize.call(scene, 0, 0);
  assert.deepEqual(posts, []);
  assert.equal(scene.config.canvasWidth, undefined);
});

test('GameEngine.setPresenting(true) rebinds then enables present', () => {
  const calls = [];
  const engine = {
    currentScene: {
      rebindSurface() { calls.push('rebind'); },
      setPresenting(on) { calls.push(on ? 'on' : 'off'); },
    },
    rebindSurface: GameEngine.prototype.rebindSurface,
  };
  GameEngine.prototype.setPresenting.call(engine, true);
  assert.equal(engine._presenting, true);
  assert.deepEqual(calls, ['rebind', 'on']);
});

test('GameEngine.setPresenting(false) skips rebind', () => {
  const calls = [];
  const engine = {
    currentScene: {
      rebindSurface() { calls.push('rebind'); },
      setPresenting(on) { calls.push(on ? 'on' : 'off'); },
    },
  };
  GameEngine.prototype.setPresenting.call(engine, false);
  assert.equal(engine._presenting, false);
  assert.deepEqual(calls, ['off']);
});
