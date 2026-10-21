import test from 'node:test';
import assert from 'node:assert/strict';

import { loadGame, SaveStore, encodeSave } from '../../src/core/save/saveGame.js';

// DX 3.4. loadScene(url, { data }) hands the scene its parameters (this.data,
// and the argument of preload / create / createNewGame). A save remount from
// a running scene keeps them.

test('loadGame remounts with the save and forwards loadScene data', async () => {
  const blob = await encodeSave({
    sceneName: 'Level',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: 0 },
    camera: null,
    sun: null,
    entities: [],
    joints: [],
  });
  const realGet = SaveStore.get;
  SaveStore.get = async () => blob;
  const calls = [];
  const engine = { loadScene: async (scene, options) => (calls.push({ scene, options }), true) };
  try {
    await loadGame(engine, 'LevelScene', 'slot1', { data: { level: 2, hard: true } });
    await loadGame(engine, 'LevelScene', 'slot1');
  } finally {
    SaveStore.get = realGet;
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.data, { level: 2, hard: true });
  assert.equal(calls[0].options.restorePayload.sceneName, 'Level');
  assert.equal(calls[1].options.data, undefined, 'no data: the scene gets null');
});
