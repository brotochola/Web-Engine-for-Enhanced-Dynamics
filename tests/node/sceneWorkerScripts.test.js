import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSceneWorkerScriptUrls } from '../../src/util/sceneWorkerBootstrap.js';

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
