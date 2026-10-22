import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, postedMessages } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { Transform } from '../../src/components/transform.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import {
  bindSpawnCommandRing,
  createSpawnCommandRingSab,
  drainSpawnCommands,
  tryPushSpawn,
} from '../../src/util/spawnCommandRing.js';

// N-53 / N-54. A spawn goes to the logic worker that owns it: logic0 through
// the ring (the entry carries the pin, which used to be dropped there), any
// other worker by message. create() waits for those workers too.

const N = 4;
Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
Transform.x = new Float32Array(N); // pose fields live in the physics buffers
Transform.y = new Float32Array(N);
Transform.rotation = new Float32Array(N);

class Walker extends GameObject {}

/** A Walker pool of N slots, its pins and the ring. */
function bindWalkers() {
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(N);
  resetFreeList(top, links, N, 1);
  Object.assign(Walker, { startIndex: 0, endIndex: N, poolSize: N, entityType: 1, freeList: links, freeListTop: top });
  Walker._componentClassMap = {};
  Walker.instances = Array.from({ length: N }, (_, index) => ({ index, _hasComponents: {} }));
  GameObject.forceProcessOnLogicWorker = new Int16Array(N).fill(-1);
  GameObject.entityTypeHasForcedLogicWorker = new Uint8Array(4);
  GameObject.entityTypeForcedLogicWorkerCount = new Uint16Array(4);
  GameObject.nextTick = null;
  Transform.active.fill(0);
  bindSpawnCommandRing(createSpawnCommandRingSab(16));
}

/** A page scene with two logic workers that record what they are sent. */
function pageScene({ batchOpen = false } = {}) {
  const sent = [];
  const worker = (w) => ({ postMessage: (m) => sent.push([w, m]) });
  const scene = {
    numberOfLogicWorkers: 2,
    workers: { logicWorkers: [worker(0), worker(1)] },
    _spawnBatchOpen: batchOpen,
    _createSpawnExtras: [],
    _createLogic0Spawns: 0,
    _createOwnerSpawns: new Set(),
    _warnedNotInScene: new Set(),
    _pendingSpawnBatch: null,
  };
  return { scene, sent };
}

function drained() {
  const out = [];
  drainSpawnCommands((kind, typeId, entityIndex, x, y, owner) => out.push({ kind, typeId, entityIndex, x, y, owner }));
  return out;
}

test('the ring entry carries its owner', () => {
  bindSpawnCommandRing(createSpawnCommandRingSab(4));
  assert.equal(tryPushSpawn(1, 2, 3, 4, 0), true);
  assert.equal(tryPushSpawn(1, 3, 0, 0), true);
  assert.deepEqual(drained().map((e) => e.owner), [0, -1]);
  bindSpawnCommandRing(null);
});

test('the page routes a spawn by owner: logic0 or none by ring, another worker by message', { concurrency: false }, () => {
  bindWalkers();
  const { scene, sent } = pageScene();
  const spawn = (config) => Scene.prototype._spawnFromPage.call(scene, Walker, config);

  const free = spawn({ x: 1, y: 2 });
  const pinned0 = spawn({ x: 3, y: 4, forceProcessOnLogicWorker: 0 });
  const pinned1 = spawn({ x: 5, y: 6, forceProcessOnLogicWorker: 1 });

  const ring = drained();
  assert.deepEqual(ring.map((e) => [e.entityIndex, e.owner]), [[free, -1], [pinned0, 0]]);
  assert.deepEqual(sent.map(([w, m]) => [w, m.msg, m.entityIndex]), [[1, 'spawn', pinned1]], 'logic1 directly, x/y only or not');
  assert.equal(GameObject.forceProcessOnLogicWorker[pinned1], 1);
  assert.equal(Transform.x[pinned1], 5, 'position written at once');
  assert.equal(Transform.active[pinned1], 0, 'the owner activates it');
  bindSpawnCommandRing(null);
});

test('logic0 keeps a pin that came through the ring', { concurrency: false }, async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  bindWalkers();
  worker.workerIndex = 0;
  worker.totalLogicWorkers = 2;
  worker._entityClassByType[1] = Walker;
  const queued = worker._spawnN;
  // The page put a spawn pinned to logic0 on the ring (x/y only, so no extras).
  const { scene } = pageScene();
  const index = Scene.prototype._spawnFromPage.call(scene, Walker, { x: 7, y: 8, forceProcessOnLogicWorker: 0 });
  GameObject.forceProcessOnLogicWorker[index] = -1; // only the ring entry may say who owns it

  worker._drainSpawnCommandRing();

  assert.equal(Transform.active[index], 1, 'set up on logic0');
  assert.equal(GameObject.forceProcessOnLogicWorker[index], 0, 'still pinned to logic0');
  assert.equal(worker._spawnN, queued + 1, 'listed');
  worker._spawnN = queued;
  bindSpawnCommandRing(null);
});

test('create() waits for the workers that got pinned spawns, then logic0 lists them', { concurrency: false }, async () => {
  bindWalkers();
  const { scene, sent } = pageScene({ batchOpen: true });
  scene._awaitSpawnAck = Scene.prototype._awaitSpawnAck;
  // Answer each message the way the workers do.
  for (const w of [0, 1]) {
    scene.workers.logicWorkers[w].postMessage = (m) => {
      sent.push([w, m]);
      queueMicrotask(() => {
        const reply =
          m.msg === 'spawnBarrier'
            ? { spawns: [{ entityIndex: 3, entityType: 1, className: 'Walker' }], despawns: [] }
            : m.msg === 'drainSpawnCommands' ? {} : null;
        if (reply) scene._pendingSpawnBatch.get(w)?.resolve(reply);
      });
    };
  }
  Scene.prototype._spawnFromPage.call(scene, Walker, { x: 1, y: 1 });
  Scene.prototype._spawnFromPage.call(scene, Walker, { x: 2, y: 2, forceProcessOnLogicWorker: 1 });

  await Scene.prototype._flushCreateSpawns.call(scene);

  assert.deepEqual(sent.map(([w, m]) => [w, m.msg]), [[1, 'spawn'], [1, 'spawnBarrier'], [0, 'drainSpawnCommands']]);
  const drain = sent[2][1];
  assert.deepEqual(drain.listUpdates, [{ spawns: [{ entityIndex: 3, entityType: 1, className: 'Walker' }], despawns: [] }]);
  assert.equal(scene._createOwnerSpawns.size, 0);
  assert.equal(scene._createLogic0Spawns, 0);
  bindSpawnCommandRing(null);
});

test('a worker answers the barrier with its list updates; logic0 queues them from the drain message', { concurrency: false }, async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const posted = postedMessages();
  posted.length = 0;
  worker.workerIndex = 1;
  worker._spawnN = 0;
  worker._despawnN = 0;
  worker.queueSpawnListUpdate(3, 1, Walker);

  worker.handleCustomMessage({ msg: 'spawnBarrier' });

  const reply = posted.find((m) => m.msg === 'spawnBatchComplete');
  assert.equal(reply.workerIndex, 1);
  assert.deepEqual(reply.spawns, [{ entityIndex: 3, entityType: 1, className: 'Walker' }]);
  assert.equal(worker._spawnN, 0, 'handed over, not sent again at the end of a frame');

  worker.workerIndex = 0;
  self.Walker = Walker;
  const flush = worker.processListUpdates;
  worker.processListUpdates = () => {};
  worker.receivedListUpdates.length = 0;
  try {
    worker.handleCustomMessage({ msg: 'drainSpawnCommands', listUpdates: [{ spawns: reply.spawns, despawns: [] }] });
    assert.equal(worker.receivedListUpdates.length, 1);
    assert.equal(worker.receivedListUpdates[0].spawns[0].EntityClass, Walker);
    assert.ok(posted.some((m) => m.msg === 'drainSpawnCommandsComplete'));
  } finally {
    worker.processListUpdates = flush;
    worker.receivedListUpdates.length = 0;
    delete self.Walker;
  }
});
