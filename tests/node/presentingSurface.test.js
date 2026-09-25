import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const terminated = [];
  const engine = {
    presentWhenHidden: false,
    _presenting: true,
    _presentingFlag: flag,
    _hidePresentingTimer: null,
    _abandoned: false,
    currentScene: {
      rebindSurface() { seen.push(['rebind', Atomics.load(flag, 0)]); },
      setPresenting(on) { seen.push(['post', on, Atomics.load(flag, 0)]); },
      killWorkers() { terminated.push(1); },
    },
    rebindSurface: GameEngine.prototype.rebindSurface,
    setPresenting: GameEngine.prototype.setPresenting,
    _armHidePresenting: GameEngine.prototype._armHidePresenting,
    _disarmHidePresenting: GameEngine.prototype._disarmHidePresenting,
    _handlePageHide: GameEngine.prototype._handlePageHide,
    _abandonDocument: GameEngine.prototype._abandonDocument,
    _onDocumentHidden: GameEngine.prototype._onDocumentHidden,
    _onDocumentVisible: GameEngine.prototype._onDocumentVisible,
  };
  return { engine, flag, seen, terminated };
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

test('arm hide stores 0 immediately and posts presenting on the next turn', async () => {
  const { engine, flag, seen } = flagEngine();
  GameEngine.prototype._armHidePresenting.call(engine);
  assert.equal(Atomics.load(flag, 0), 0);
  assert.equal(engine._presenting, false);
  assert.deepEqual(seen, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [['post', false, 0]]);
});

test('pagehide without bfcache terminates workers and does not post presenting', async () => {
  const { engine, flag, seen, terminated } = flagEngine();
  GameEngine.prototype._armHidePresenting.call(engine);
  GameEngine.prototype._handlePageHide.call(engine, { persisted: false });
  assert.equal(Atomics.load(flag, 0), 0);
  assert.equal(engine._abandoned, true);
  assert.equal(engine.currentScene, null);
  assert.deepEqual(terminated, [1]);
  assert.deepEqual(seen, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, []);
});

test('pagehide persisted only stops presenting', () => {
  const { engine, flag, seen, terminated } = flagEngine();
  GameEngine.prototype._handlePageHide.call(engine, { persisted: true });
  assert.equal(Atomics.load(flag, 0), 0);
  assert.equal(engine._abandoned, false);
  assert.ok(engine.currentScene);
  assert.deepEqual(terminated, []);
  assert.deepEqual(seen, [['post', false, 0]]);
});

test('pixi SAB hide stops the clock and does not unconfigure', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/workers/pixiWorker.js'),
    'utf8'
  );
  const start = src.indexOf('/** Main thread stores 0 on hide/unload.');
  const gpuLive = src.slice(start, src.indexOf('_noteHidden()', start));
  assert.match(gpuLive, /_stopGpuClock\(\)/);
  assert.equal(/_unconfigureSurface/.test(gpuLive), false);
  assert.match(src, /_noteHidden\(\) \{\s*this\._stopGpuClock\(\);\s*this\._unconfigureSurface\(\);/s);
});

test('Scene.killWorkers terminates every worker once', () => {
  let n = 0;
  const renderer = { terminate() { n++; }, onmessage: 1, onerror: 1 };
  const physics = { terminate() { n++; }, onmessage: 1, onerror: 1 };
  const scene = {
    workers: { renderer, physics },
    getAllWorkers() { return [renderer, physics]; },
    animationFrameId: null,
  };
  Scene.prototype.killWorkers.call(scene);
  Scene.prototype.killWorkers.call(scene);
  assert.equal(n, 2);
  assert.equal(renderer.onmessage, null);
  assert.equal(physics.onerror, null);
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
