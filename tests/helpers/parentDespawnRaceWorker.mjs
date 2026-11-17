// Thread for tests/node/transformParent.test.js (DX-PARENT): two of these despawn the same entity at once, round after
// round, on one scene's shared buffers (Transform, the body sync words, the class's free list), as logic0's despawn of
// an orphaned child and the child's own despawn on its worker can. Each thread has its own GameObject statics and
// instances; what they share is the shared memory. onDespawned holds the despawn open a while, so the two overlap.
import { parentPort, workerData } from 'node:worker_threads';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { bindBodySyncBuffers } from '../../src/box2d/box2dBodySync.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';

const { n, transform, sync, top, links, go, holdMs } = workerData;

bindEntityIdWidth(16);
Transform.initializeArrays(transform, n);
bindBodySyncBuffers(sync);

class Crate extends GameObject {
  onDespawned() {
    const until = performance.now() + holdMs;
    while (performance.now() < until);
  }
}
GameObject._assignComponentClassMap(Crate);
Crate.startIndex = 0;
Crate.endIndex = n;
Crate.poolSize = n;
Crate.entityType = 0;
Crate.freeList = new Uint16Array(links);
Crate.freeListTop = new Int32Array(top);
Crate.instances = [];
GameObject.classByType = [Crate];
GameObject.nextTick = null;
GameObject.forceProcessOnLogicWorker = null;
// lazy: the slot's Transform is the scene's (the main thread's), not reset here.
for (let i = 0; i < n; i++) new Crate(i, undefined, null, { lazy: true });

// go: [0] the round to run (-1: stop), [1] threads done with it.
const words = new Int32Array(go);
parentPort.postMessage('ready');
let round = 0;
for (;;) {
  Atomics.wait(words, 0, round);
  round = Atomics.load(words, 0);
  if (round < 0) break;
  GameObject.despawn(0);
  Atomics.add(words, 1, 1);
  Atomics.notify(words, 1);
}
