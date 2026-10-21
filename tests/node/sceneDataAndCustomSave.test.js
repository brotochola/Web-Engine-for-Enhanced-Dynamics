import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';
import { loadGame, SaveStore, encodeSave } from '../../src/core/save/saveGame.js';

// DX 3.5. onSaveGame() saves the scene state that lives outside entities (score, quest
// flags, level); onLoadGame gets it back as payload.custom.

function payload(extra = {}) {
  return {
    sceneName: 'Level',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: 0 },
    camera: null,
    sun: null,
    entities: [],
    joints: [],
    ...extra,
  };
}

test('onSaveGame data round-trips as payload.custom', () => {
  const custom = { score: 1250, level: 3, flags: ['met-king', 'has-key'], note: 'ñandú ✓' };
  const back = decodeBinarySaveBody(encodeBinarySaveBody(payload({ custom })));
  assert.deepEqual(back.custom, custom);
});

test('a save without onSaveGame data decodes custom as null', () => {
  assert.equal(decodeBinarySaveBody(encodeBinarySaveBody(payload())).custom, null);
  assert.equal(decodeBinarySaveBody(encodeBinarySaveBody(payload({ custom: null }))).custom, null);
});

test('onSaveGame data that is not JSON fails the save with a clear message', () => {
  const loop = {};
  loop.self = loop;
  assert.throws(() => encodeBinarySaveBody(payload({ custom: loop })), /onSaveGame\(\) must return JSON data/);
});

test('a loaded save hands onSaveGame data to loadScene as payload.custom', async () => {
  const blob = await encodeSave(payload({ custom: { level: 2 } }));
  const realGet = SaveStore.get;
  SaveStore.get = async () => blob;
  let options = null;
  try {
    await loadGame({ loadScene: async (_, o) => ((options = o), true) }, 'LevelScene', 'slot1');
  } finally {
    SaveStore.get = realGet;
  }
  assert.deepEqual(options.restorePayload.custom, { level: 2 });
});

test('buildSavePayload asks the scene for onSaveGame data', async () => {
  const { buildSavePayload } = await import('../../src/core/save/entitySaveSnapshot.js');
  class LevelScene {
    onSaveGame() {
      return { score: 7 };
    }
  }
  const scene = Object.assign(new LevelScene(), { registeredClasses: [], totalEntityCount: 0 });
  assert.deepEqual(buildSavePayload(scene, { camera: null, sun: null }).custom, { score: 7 });
  const plain = Object.assign(Object.create(null), { registeredClasses: [], totalEntityCount: 0 });
  assert.equal('custom' in buildSavePayload(plain, { camera: null, sun: null }), false);
});
