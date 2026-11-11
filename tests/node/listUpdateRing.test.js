// E-208: logic workers 1..N hand logic0 their list updates through a ring each (listUpdateRing.js) instead of a
// message a frame (an object and a class name a record: about 33 MB/s of garbage on logic0 in spawnStormScene with two
// workers). The real logic worker: as worker 1 its frame's updates go into its ring and no message is sent; as logic0
// it queues them, despawns and spawns, each with its class from its type; a frame the ring has no room for goes by
// message, as before.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import {
  bindListUpdateRing, createListUpdateRings, listUpdateRingSlots, listUpdatesPending, listUpdatesRead,
} from '../../src/util/listUpdateRing.js';

class RingA {}
class RingB {}
const ENTITIES = 1000;

async function setup() {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const saved = GameObject.classByType;
  GameObject.classByType = [];
  GameObject.classByType[3] = RingA;
  GameObject.classByType[5] = RingB;
  const buffer = createListUpdateRings(3, ENTITIES);
  const sent = [];
  worker.sendDataToWorker = (to, msg) => {
    sent.push({ to, msg: { ...msg, spawns: msg.spawns.map((s) => ({ ...s })), despawns: msg.despawns.map((d) => ({ ...d })) } });
    return true;
  };
  const restore = () => {
    GameObject.classByType = saved;
  };
  return { worker, buffer, sent, restore };
}

/** Worker `k`'s frame end with these updates queued, as the worker queues them. */
function writerFrame(worker, buffer, k, despawns, spawns) {
  worker.workerIndex = k;
  worker._listUpdateRings = [];
  worker._listUpdateRing = bindListUpdateRing(buffer, k, ENTITIES);
  worker._spawnN = 0;
  worker._despawnN = 0;
  for (const [i, type, C] of despawns) worker.queueDespawnListUpdate(i, type, C);
  for (const [i, type, C] of spawns) worker.queueSpawnListUpdate(i, type, C);
  return worker.sendListUpdatesToLogic0();
}

/** logic0's drain: what it queued, as [index, type, class] lists. */
function readerDrain(worker, buffer) {
  worker.workerIndex = 0;
  worker._listUpdateRing = null;
  worker._listUpdateRings = [bindListUpdateRing(buffer, 1, ENTITIES), bindListUpdateRing(buffer, 2, ENTITIES)];
  worker._spawnN = 0;
  worker._despawnN = 0;
  worker._drainListUpdateRings();
  const spawns = [];
  const despawns = [];
  for (let i = 0; i < worker._spawnN; i++) spawns.push([worker._spawnIdx[i], worker._spawnType[i], worker._spawnClass[i]]);
  for (let i = 0; i < worker._despawnN; i++) despawns.push([worker._despawnIdx[i], worker._despawnType[i], worker._despawnClass[i]]);
  worker._spawnN = 0;
  worker._despawnN = 0;
  return { spawns, despawns };
}

test('a worker\'s list updates reach logic0 through its ring, no message, each class from its type', async () => {
  const { worker, buffer, sent, restore } = await setup();
  try {
    assert.equal(createListUpdateRings(1, ENTITIES), null, 'one logic worker: no rings');
    assert.equal(writerFrame(worker, buffer, 1, [[7, 3, RingA]], [[8, 5, RingB], [9, 3, RingA]]), true);
    assert.equal(writerFrame(worker, buffer, 2, [], [[400, 5, RingB]]), true);
    assert.equal(sent.length, 0, 'nothing posted');
    assert.equal(worker._spawnN + worker._despawnN, 0, 'the writer\'s queues emptied');
    const got = readerDrain(worker, buffer);
    assert.deepEqual(got.despawns, [[7, 3, RingA]]);
    assert.deepEqual(got.spawns, [[8, 5, RingB], [9, 3, RingA], [400, 5, RingB]]);
    assert.deepEqual(readerDrain(worker, buffer), { spawns: [], despawns: [] }, 'nothing twice');
    // Around the ring a few times: each frame's updates once, in order.
    const slots = listUpdateRingSlots(ENTITIES);
    for (let f = 0; f < 3 * slots / 500; f++) {
      const spawns = Array.from({ length: 500 }, (_, i) => [(f * 500 + i) % ENTITIES, 3, RingA]);
      assert.equal(writerFrame(worker, buffer, 1, [], spawns), true);
      assert.deepEqual(readerDrain(worker, buffer).spawns, spawns, `frame ${f}`);
    }
    const ring = bindListUpdateRing(buffer, 1, ENTITIES);
    assert.equal(listUpdatesPending(ring), listUpdatesRead(ring));
  } finally {
    restore();
  }
});

test('a frame the ring has no room for goes by message, and the ring keeps the frames before it', async () => {
  const { worker, buffer, sent, restore } = await setup();
  try {
    const slots = listUpdateRingSlots(ENTITIES);
    const first = Array.from({ length: slots - 10 }, (_, i) => [i % ENTITIES, 3, RingA]);
    assert.equal(writerFrame(worker, buffer, 1, [], first), true);
    // logic0 has not read yet: the next frame does not fit.
    const second = [[11, 5, RingB], [12, 5, RingB]];
    const big = Array.from({ length: 20 }, (_, i) => [i, 3, RingA]);
    assert.equal(writerFrame(worker, buffer, 1, second, big), true, 'sent by message');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'logic0');
    assert.deepEqual(sent[0].msg.despawns.map((d) => [d.entityIndex, d.entityType, d.className]), [[11, 5, 'RingB'], [12, 5, 'RingB']]);
    assert.equal(sent[0].msg.spawns.length, 20);
    assert.equal(readerDrain(worker, buffer).spawns.length, first.length, 'the ring\'s frame arrives whole');
    // Read, there is room again.
    assert.equal(writerFrame(worker, buffer, 1, [], [[1, 3, RingA]]), true);
    assert.equal(sent.length, 1, 'no message');
    assert.deepEqual(readerDrain(worker, buffer).spawns, [[1, 3, RingA]]);
  } finally {
    restore();
  }
});
