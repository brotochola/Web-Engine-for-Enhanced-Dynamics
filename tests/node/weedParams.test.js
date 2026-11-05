/** DX-SCENEPARAMS: WEED.params, the same on the main thread and in a real logic worker. */
import test from 'node:test';
import assert from 'node:assert/strict';

import WEED from '../../src/index.js';
import { GameEngine } from '../../src/core/gameEngine.js';
import { Scene } from '../../src/core/scene.js';
import { pageQuery, sceneParams, setSceneParams } from '../../src/core/sceneParams.js';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

test('WEED.params reads the current scene params, after a change too', () => {
  setSceneParams('a=1&b=two');
  assert.ok(WEED.params instanceof URLSearchParams);
  assert.equal(WEED.params.get('a'), '1');
  setSceneParams({ a: 'x' });
  assert.equal(WEED.params.get('a'), 'x');
  assert.equal(WEED.params.get('b'), null);
  setSceneParams(new URLSearchParams('c=3'));
  assert.equal(WEED.params.get('c'), '3');
  setSceneParams();
  assert.equal(WEED.params.toString(), '');
});

test('pageQuery is the page URL on the main thread and empty where there is no location', () => {
  const saved = globalThis.location;
  try {
    assert.equal(pageQuery(), typeof saved === 'undefined' ? '' : saved.search || '');
    Object.defineProperty(globalThis, 'location', { value: { search: '?hora=9' }, configurable: true, writable: true });
    assert.equal(pageQuery(), '?hora=9');
  } finally {
    Object.defineProperty(globalThis, 'location', { value: saved, configurable: true, writable: true });
  }
});

test('a real worker takes the value from its init message, before its scripts load', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  setSceneParams('');
  await initWorker(worker, {
    config: { logic: {}, physics: {} },
    globalEntityCount: 0,
    buffers: {},
    extra: { sceneParams: 'hora=9&seed=4' },
  }).catch(() => {});
  assert.equal(WEED.params.get('hora'), '9');
  assert.equal(WEED.params.get('seed'), '4');
  setSceneParams('');
});

test('loadScene sets them before it imports the scene, from { params } or else the page', async () => {
  const seen = [];
  const engine = Object.create(GameEngine.prototype);
  engine._isolation = Promise.resolve('ok');
  engine.state = GameEngine.states.READY;
  // Stops the load at the first step that reads the source: what matters is what ran before it.
  const load = (source, options) =>
    engine.loadScene(source, options).catch((err) => seen.push(err.message.slice(0, 16)));

  await load(42, { params: 'lvl=7' });
  assert.equal(sceneParams().get('lvl'), '7');

  engine.state = GameEngine.states.READY;
  const saved = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    value: { search: '?page=1', origin: 'http://x' },
    configurable: true,
    writable: true,
  });
  try {
    await load(42);
    assert.equal(sceneParams().get('page'), '1');
    assert.equal(sceneParams().get('lvl'), null);
  } finally {
    Object.defineProperty(globalThis, 'location', { value: saved, configurable: true, writable: true });
    setSceneParams('');
  }
  assert.equal(seen.length, 2, 'both stopped on the bad source');
});

test('scene.params reads the same object WEED.params does', () => {
  const scene = Object.create(Scene.prototype);
  setSceneParams('lvl=7');
  assert.equal(scene.params, WEED.params);
  assert.equal(scene.params.get('lvl'), '7');
  setSceneParams('');
});
