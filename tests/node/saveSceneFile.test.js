import test from 'node:test';
import assert from 'node:assert/strict';

import { Scene } from '../../src/core/scene.js';
import { Messages } from '../../src/core/messages.js';
import { applySavePayloadToScene, decodeSave, encodeSave, loadGame, SaveStore } from '../../src/core/save/saveGame.js';

// VISUAL_EDITOR_PLAN.md ED-36: a save records the scene file it was made in, and the names of what the file placed.

const BASE_PAYLOAD = {
  sceneName: 'Level',
  engineVersion: '0',
  layout: { types: [], totalEntityCount: 0 },
  camera: null,
  sun: null,
  entities: [],
  joints: [],
};

test('the scene file section round-trips, and a save without one reads as null', async () => {
  const sceneFile = { url: '/demos/platformerGameScene/levels/1-2.scene.json', names: [['Door1', 4], ['Lever', 9]] };
  const withFile = await decodeSave(await encodeSave({ ...BASE_PAYLOAD, sceneFile }));
  assert.deepEqual(withFile.sceneFile, sceneFile);
  const without = await decodeSave(await encodeSave(BASE_PAYLOAD));
  assert.equal(without.sceneFile, null);
});

/** A Scene with a scene file and named entities, the spawn generation column bound. */
function sceneWithNames(entries) {
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(16) }, []);
  const scene = Object.create(Scene.prototype);
  scene.sceneFileUrl = 'http://host/demos/levels/1-2.scene.json';
  scene._namedEntities = new Map(entries.map(([name, index]) => [name, index * 65536 + Messages.spawnGen[index]]));
  return scene;
}

test('a save records the file from the site root and the names still live', () => {
  const scene = sceneWithNames([['Door1', 4], ['Coin7', 9]]);
  Messages.bumpGeneration(9); // Coin7 was collected: its slot may hold another entity now
  const saved = globalThis.location;
  globalThis.location = { origin: 'http://host' };
  try {
    assert.deepEqual(scene._sceneFileForSave(), { url: '/demos/levels/1-2.scene.json', names: [['Door1', 4]] });
  } finally {
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  }
  scene.sceneFileUrl = null;
  assert.equal(scene._sceneFileForSave(), null, 'a scene loaded from its class records none');
});

test('a restore gives the entities it brought back their names, at their new indices', async () => {
  const scene = sceneWithNames([['Plank1', 2]]);
  scene.registeredClasses = [];
  scene.workers = {
    logicWorkers: [
      {
        postMessage() {
          // logic0 restored the saved entity 3 at index 9.
          queueMicrotask(() => scene._pendingRestoreComplete.resolve({ restored: 1, failed: 0, idPairs: [3, 9] }));
        },
      },
    ],
  };
  const sceneFile = { url: '/levels/1-2.scene.json', names: [['Door1', 3], ['Gone', 5]] };
  const payload = await decodeSave(await encodeSave({ ...BASE_PAYLOAD, sceneFile }));
  await applySavePayloadToScene(scene, payload, { allTypes: true });
  assert.equal(scene._namedEntities.get('Door1'), 9 * 65536 + Messages.spawnGen[9]);
  assert.equal(scene._namedEntities.has('Gone'), false, 'an entity the save did not bring back keeps no name');
  assert.ok(scene._namedEntities.has('Plank1'), 'names the file placed this load stay');
});

test('loadGame loads the scene file the save was made in', async () => {
  const blob = await encodeSave({ ...BASE_PAYLOAD, sceneFile: { url: '/levels/1-2.scene.json', names: [] } });
  const older = await encodeSave(BASE_PAYLOAD);
  const realGet = SaveStore.get;
  const calls = [];
  const engine = { loadScene: async (source) => (calls.push(source), true) };
  try {
    SaveStore.get = async () => blob;
    await loadGame(engine, '/demos/level.js', 'slot1');
    SaveStore.get = async () => older;
    await loadGame(engine, '/demos/level.js', 'slot1');
  } finally {
    SaveStore.get = realGet;
  }
  assert.deepEqual(calls, ['/levels/1-2.scene.json', '/demos/level.js']);
});
