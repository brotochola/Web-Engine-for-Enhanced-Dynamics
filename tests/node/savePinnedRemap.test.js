import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSaveWorld, liveIndicesOf } from '../helpers/saveWorld.mjs';
import { Component } from '../../src/core/component.js';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { captureSavePayload, applySavePayloadToScene, encodeSave, decodeSave } from '../../src/core/save/saveGame.js';
import { entityIdNone } from '../../src/util/entityIdWidth.js';

// N-327: a player's load hands a pinned class's spawns to the logic worker it is pinned to, each with its saved row,
// and logic0 remaps every entity id once all the saved entities have their new indices. The receiving worker writes
// its rows when it reads its messages, so logic0 must remap after that worker has written them (a barrier through the
// same port), or the saved ids come back unmapped. Here logic0 is the real worker and the test plays logic1: it sets
// up the spawns it was sent, and answers the barrier once it has.

class Aim extends Component {
  static ARRAY_SCHEMA = {
    target: { type: Uint16Array, entityId: true },
    pair: { type: Uint16Array, length: 2, entityId: true },
  };
}

class Target extends GameObject {
  static serializable = true;
  static components = [SpriteRenderer];
}

/** Set up by logic1 on a player's load. */
class Pinned extends GameObject {
  static serializable = true;
  static forceProcessOnLogicWorker = 1;
  static components = [SpriteRenderer, Aim];
}

const world = await buildSaveWorld(
  [
    { class: Target, pool: 24, live: 12 },
    { class: Pinned, pool: 8, live: 4 },
  ],
  { seed: 0x327 },
);
const { scene, logic } = world;
const none = entityIdNone >>> 0;

const targets = liveIndicesOf(Target);
const pinned = liveIndicesOf(Pinned);
// Each pinned entity aims at a Target, pairs with the next pinned one (a pinned id) and with none.
for (let k = 0; k < pinned.length; k++) {
  const i = pinned[k];
  Aim.target[i] = targets[(k * 5) % targets.length];
  Aim.pair[i * 2] = pinned[(k + 1) % pinned.length];
  Aim.pair[i * 2 + 1] = none;
}
const savedAim = new Map(pinned.map((i) => [i, [Aim.target[i], Aim.pair[i * 2], Aim.pair[i * 2 + 1]]]));

test("a player's load remaps the entity ids of a pinned class's entities, which another worker sets up", async () => {
  const decoded = await decodeSave(await encodeSave(await captureSavePayload(scene, { staysPaused: true, decalsCompressed: false })));
  // A Target spawned after the save takes a slot, so the load's spawns land on other indices than the saved ones.
  GameObject._spawnAt(Target, { x: 0, y: 0, _hotRestore: true }, -1, false);
  logic.processListUpdates();

  const queued = [];
  const playLogic1 = () => {
    logic.workerIndex = 1;
    try {
      while (queued.length) logic._mainThreadSpawn(queued.shift());
    } finally {
      logic.workerIndex = 0;
    }
  };
  const prev = { total: logic.totalLogicWorkers, send: logic.sendDataToWorker };
  logic.totalLogicWorkers = 2;
  logic.sendDataToWorker = (to, msg) => {
    const m = structuredClone(msg);
    assert.equal(to, 'logic1');
    if (m.msg === 'spawn') queued.push(m);
    else if (m.msg === 'restoreBarrier') {
      // logic1 reads its port in order: the spawns first, then the barrier, which it answers.
      setImmediate(() => {
        playLogic1();
        logic.handleCustomMessage({ msg: 'restoreBarrierAck', id: m.id, _fromWorker: 'logic1' });
      });
    }
    return true;
  };
  let result;
  try {
    result = await applySavePayloadToScene(scene, decoded);
    playLogic1(); // whatever logic1 had not read yet
  } finally {
    logic.totalLogicWorkers = prev.total;
    logic.sendDataToWorker = prev.send;
  }

  const moved = new Map();
  for (let k = 0; k < result.idPairs.length; k += 2) moved.set(result.idPairs[k], result.idPairs[k + 1]);
  assert.ok([...moved].some(([old, neu]) => old !== neu), 'the load moved some entities (else a remap is not seen)');
  for (const [old, [target, pair0, pair1]] of savedAim) {
    const neu = moved.get(old);
    assert.ok(neu !== undefined, `Pinned ${old} restored`);
    assert.equal(Aim.target[neu], moved.get(target), `Pinned ${old} -> ${neu}: its target ${target} -> ${moved.get(target)}`);
    assert.equal(Aim.pair[neu * 2], moved.get(pair0), `Pinned ${old} -> ${neu}: its pinned pair ${pair0} -> ${moved.get(pair0)}`);
    assert.equal(Aim.pair[neu * 2 + 1] >>> 0, pair1 >>> 0, 'none stays none');
  }
});
