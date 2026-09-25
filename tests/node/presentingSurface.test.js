import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { Scene } from '../../src/core/scene.js';
import {
  usableCanvasSize,
  stashResizeWhileHidden,
  takePendingResize,
} from '../../src/util/utils.js';

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

function flagEngine() {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(flag, 0, 1);
  const seen = [];
  const engine = {
    presentWhenHidden: false,
    _presentingFlag: flag,
    currentScene: {
      rebindSurface() { seen.push(['rebind', Atomics.load(flag, 0)]); },
      setPresenting(on) { seen.push(['post', on, Atomics.load(flag, 0)]); },
    },
    rebindSurface: GameEngine.prototype.rebindSurface,
    setPresenting: GameEngine.prototype.setPresenting,
  };
  return { engine, flag, seen };
}

test('hide stores 0 on the presenting flag before the renderer post', () => {
  const { engine, flag, seen } = flagEngine();
  GameEngine.prototype._onDocumentHidden.call(engine);
  assert.equal(Atomics.load(flag, 0), 0);
  assert.deepEqual(seen, [['post', false, 0]]);
});

test('show stores 1 on the presenting flag before rebind', () => {
  const { engine, flag, seen } = flagEngine();
  Atomics.store(flag, 0, 0);
  GameEngine.prototype._onDocumentVisible.call(engine);
  assert.equal(Atomics.load(flag, 0), 1);
  assert.deepEqual(seen, [['rebind', 1], ['post', true, 1]]);
});

test('hidden resize is stashed and does not call renderer.resize until rebind', () => {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(flag, 0, 0);
  const calls = [];
  const host = {
    _presentingFlag: flag,
    _pendingResizeW: null,
    _pendingResizeH: null,
    _applyResize(width, height) { calls.push([width, height]); },
  };
  if (!stashResizeWhileHidden(host, 800, 600)) host._applyResize(800, 600);
  assert.deepEqual(calls, []);
  assert.equal(host._pendingResizeW, 800);
  assert.equal(host._pendingResizeH, 600);

  Atomics.store(flag, 0, 1);
  const pending = takePendingResize(host);
  if (pending) host._applyResize(pending.width, pending.height);
  assert.deepEqual(calls, [[800, 600]]);
  assert.equal(host._pendingResizeW, null);
  assert.equal(takePendingResize(host), null);
});
