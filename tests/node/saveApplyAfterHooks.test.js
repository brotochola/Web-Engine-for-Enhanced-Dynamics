import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { Scene } = await import('../../src/core/scene.js');
const { SharedResource } = await import('../../src/core/sharedResource.js');
const { NavGrid } = await import('../../src/core/navGrid.js');
const { applySavePayloadToScene } = await import('../../src/core/save/saveGame.js');
const { SAVE_MAGIC } = await import('../../src/core/save/entitySaveSnapshot.js');

// B23 (part). Shared resources and nav walkability were written before logic0
// restored the entities. That restore despawns the create()-time entities and
// spawns the saved ones, so their onDespawned / onSpawned hooks ran on top of
// the restored bytes: a kills counter bumped in onDespawned, or an occupancy
// count per nav cell, ended the load off by the hook deltas. The saved bytes
// already hold every effect those entities had, so they win at the end.

class TestScene {}

function makeScene(onRestore) {
  const scene = new TestScene();
  scene.registeredClasses = [];
  scene._pendingRestoreComplete = null;
  scene.workers = {
    logicWorkers: [
      {
        postMessage(msg) {
          if (msg.msg !== 'restoreSave') return;
          queueMicrotask(() => {
            onRestore();
            Scene.prototype.handleMessageFromWorker.call(scene, {
              data: { msg: 'restoreSaveComplete', restored: 0, failed: 0, idPairs: [] },
            });
          });
        },
      },
    ],
  };
  return scene;
}

test('shared resources end the load with the saved bytes, whatever restore hooks wrote', async () => {
  class Tally extends SharedResource {}
  SharedResource.resetAll();
  const schema = { kills: { type: Int32Array, length: 1, atomic: true } };
  const size = SharedResource.getBufferSize(schema);
  Tally.initialize(new SharedArrayBuffer(size), schema);

  const saved = new Uint8Array(size);
  new Int32Array(saved.buffer)[0] = 12;
  let seenByHooks = -1;
  const scene = makeScene(() => {
    seenByHooks = Tally.kills.load(0);
    Tally.kills.add(3, 0); // three create()-time enemies despawned: onDespawned kills++
  });
  Tally.kills.store(0, 0);

  await applySavePayloadToScene(scene, {
    magic: SAVE_MAGIC,
    sceneName: 'TestScene',
    entities: [],
    sharedResources: [{ name: 'Tally', bytes: saved }],
  });

  assert.equal(seenByHooks, 12, 'hooks already read the saved value');
  assert.equal(Tally.kills.load(0), 12, 'not 15');
  SharedResource.resetAll();
});

test('nav walkability ends the load as saved', async () => {
  const config = { cellSize: 32, maxFlowfields: 1, maxPaths: 1, maxPathLength: 4 };
  const sab = new SharedArrayBuffer(NavGrid.calculateSABSize(config, 4, 4));
  NavGrid.writeHeader(sab, config, 4, 4);
  NavGrid.initialize(sab, { worldWidth: 128, worldHeight: 128 });
  const walk = NavGrid.getWalkabilityArray();
  assert.equal(walk.length, 16, 'nav grid bound');
  const info = NavGrid.getGridInfo();
  const saved = new Uint8Array(walk.length).fill(1);
  saved[5] = 0;
  const scene = makeScene(() => {
    walk[5] = 1; // a restore hook re-marked a cell walkable
    walk[6] = 0;
  });

  await applySavePayloadToScene(scene, {
    magic: SAVE_MAGIC,
    sceneName: 'TestScene',
    entities: [],
    nav: { walkability: saved, gridWidth: info.width, gridHeight: info.height, cellSize: info.cellSize },
  });

  assert.deepEqual(Array.from(walk), Array.from(saved));
});
