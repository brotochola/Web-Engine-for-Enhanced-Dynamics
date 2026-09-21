import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSceneWorkerScriptUrls } from '../../src/util/sceneWorkerBootstrap.js';
import { collectWorkerScriptsToLoad } from '../../src/util/sceneScript.js';

test('collectSceneWorkerScriptUrls: pooled entities before zero-count parents', () => {
  const urls = collectSceneWorkerScriptUrls(
    [
      { scriptPath: '/person.js', count: 0 },
      { scriptPath: '/lootable.js', count: 0 },
      { scriptPath: '/civilian.js', count: 100 },
      { scriptPath: '/destination.js', count: 1 },
    ],
    'http://127.0.0.1'
  );
  assert.deepEqual(urls, [
    'http://127.0.0.1/civilian.js',
    'http://127.0.0.1/destination.js',
    'http://127.0.0.1/person.js',
    'http://127.0.0.1/lootable.js',
  ]);
});

test('collectSceneWorkerScriptUrls: skips missing scriptPath, keeps pooled order', () => {
  const urls = collectSceneWorkerScriptUrls(
    [
      { scriptPath: '/house.js', count: 10 },
      { scriptPath: null, count: 0 },
      { scriptPath: '/tree.js', count: 5 },
    ],
    'http://127.0.0.1'
  );
  assert.deepEqual(urls, ['http://127.0.0.1/house.js', 'http://127.0.0.1/tree.js']);
});

test('collectWorkerScriptsToLoad: scene URL first, leftover entity scriptPath only', () => {
  const urls = collectWorkerScriptsToLoad(
    {
      sceneScriptUrl: '/demos/predatorScene/predatorScene.js',
      registeredClasses: [
        { scriptPath: '/demos/predatorScene/gameObjects/house.js', count: 10 },
        { scriptPath: null, count: 1 },
      ],
      sharedResourceRegs: [],
    },
    'http://127.0.0.1',
  );
  assert.deepEqual(urls, [
    'http://127.0.0.1/demos/predatorScene/predatorScene.js',
    'http://127.0.0.1/demos/predatorScene/gameObjects/house.js',
  ]);
});

test('collectWorkerScriptsToLoad: no scene URL falls back to entity list', () => {
  const urls = collectWorkerScriptsToLoad(
    {
      sceneScriptUrl: null,
      registeredClasses: [
        { scriptPath: '/house.js', count: 10 },
        { scriptPath: null, count: 0 },
      ],
      sharedResourceRegs: [],
    },
    'http://127.0.0.1',
  );
  assert.deepEqual(urls, ['http://127.0.0.1/house.js']);
});

test('collectWorkerScriptsToLoad: skips scriptUrl null leftovers', () => {
  const urls = collectWorkerScriptsToLoad(
    {
      sceneScriptUrl: 'http://127.0.0.1/scene.js',
      registeredClasses: [{ scriptPath: null, count: 1 }],
      sharedResourceRegs: [{ scriptUrl: null }],
    },
    'http://127.0.0.1',
  );
  assert.deepEqual(urls, ['http://127.0.0.1/scene.js']);
});
