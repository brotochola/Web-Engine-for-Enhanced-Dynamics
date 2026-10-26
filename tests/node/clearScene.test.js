import test from 'node:test';
import assert from 'node:assert/strict';

import { registerOnLogicWorker, warnings } from '../helpers/logicWorkerEntities.mjs';
import { postedMessages } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { popEntity } from '../../src/util/atomicFreeList.js';

// VISUAL_EDITOR_PLAN.md ED-35: logic0's world clear for the fast swap, on the shipped logic worker.

class Coin extends GameObject {}
class Crate extends GameObject {
  // Breaking a crate drops a coin: the clear must not leave it behind.
  onDespawned() {
    Coin.spawn({ x: 0, y: 0 });
  }
}

const live = (C) => {
  let n = 0;
  for (let i = C.startIndex; i < C.endIndex; i++) n += Transform.active[i];
  return n;
};

test('clearScene despawns every entity, those a despawn hook spawns too, and gives every pool back whole', async () => {
  const worker = await registerOnLogicWorker([[Coin, 8], [Crate, 4]]);
  for (let k = 0; k < 3; k++) Coin.spawn({ x: k, y: 0 });
  for (let k = 0; k < 2; k++) Crate.spawn({ x: k, y: 0 });
  worker.processListUpdates();
  // A page spawn that reserved an index and was never set up (the despawn pass cannot see it).
  assert.ok(popEntity(Coin.freeListTop, Coin.freeList, Coin.startIndex) >= 0);
  worker.previousScreenVisibility = new Uint8Array(12).fill(1);
  const before = postedMessages().length;

  worker.handleCustomMessage({ msg: 'clearScene' });

  assert.equal(live(Coin), 0, 'the coins the crates dropped while despawning are gone too');
  assert.equal(live(Crate), 0);
  assert.equal(GameObject.getPoolStats(Coin).available, 8, 'the reserved index is free again');
  assert.equal(GameObject.getPoolStats(Crate).available, 4);
  assert.equal(GameObject.activeEntitiesData[0], 0);
  assert.equal(Coin._activeList[0], 0);
  assert.equal(worker.previousScreenVisibility.indexOf(1), -1);
  const replies = postedMessages().slice(before).filter((m) => m.msg === 'clearSceneComplete');
  assert.deepEqual(replies, [{ msg: 'clearSceneComplete', workerIndex: 0 }]);

  // The pools work as on a fresh scene.
  const again = Coin.spawn({ x: 5, y: 5 });
  assert.ok(again);
  assert.equal(live(Coin), 1);
});

test('a despawn hook that never stops spawning is cut after the passes, with a warning, and its pool kept', async () => {
  class Hydra extends GameObject {
    onDespawned() {
      Hydra.spawn({ x: 0, y: 0 });
    }
  }
  const worker = await registerOnLogicWorker([[Hydra, 4]]);
  Hydra.spawn({ x: 0, y: 0 });
  worker.processListUpdates();
  const seen = warnings(() => worker.handleCustomMessage({ msg: 'clearScene' }));
  assert.equal(live(Hydra), 1, 'the one spawned by the last pass');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /1 Hydra are still live: an onDespawned hook keeps spawning/);
  assert.equal(GameObject.getPoolStats(Hydra).available, 3, 'its free list was not rewritten under a live entity');
});

test('a logic worker other than logic0 only forgets the screen visibility it saw', async () => {
  const worker = await registerOnLogicWorker([[Coin, 4]]);
  Coin.spawn({ x: 0, y: 0 });
  worker.processListUpdates();
  worker.previousScreenVisibility = new Uint8Array(4).fill(1);
  worker.workerIndex = 1;
  try {
    worker.handleCustomMessage({ msg: 'clearScene' });
  } finally {
    worker.workerIndex = 0;
  }
  assert.equal(live(Coin), 1, 'only logic0 clears the world');
  assert.equal(worker.previousScreenVisibility.indexOf(1), -1);
});
