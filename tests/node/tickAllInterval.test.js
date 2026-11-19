import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';

// E-527: a type with a static tickAll ignored its tickInterval: tickAll got every entity every frame. With
// logic.staggeredUpdates, a tickAll type with tickInterval N now gets, each frame, the entities a tick() type with
// interval N ticks on it (its buckets), each once in N frames, with the dtRatio tick() gets. Interval 1 keeps E-218's
// view of the active list. Through the real logic worker: createGameObjectInstances classifies the types, update() runs
// the frames.

const INTERVAL = 4;
const PER_TYPE = 16; // a multiple of INTERVAL: the two pools' ids have the same phases, shifted by PER_TYPE
const N = 3 * PER_TYPE;

let log = [];

/** tick() every INTERVAL frames: the reference. */
class Grazer extends GameObject {
  static components = [SpriteRenderer];
  static tickInterval = INTERVAL;
  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    log.push({ who: 'tick', frame: frameNumber, id: this.index, dtRatio });
  }
}

let herdFrame = 0;
/** tickAll every INTERVAL frames. */
class Herd extends GameObject {
  static components = [SpriteRenderer];
  static tickInterval = INTERVAL;
  static tickAll(list, count, dtRatio) {
    log.push({ who: 'tickAll', frame: herdFrame, ids: Array.from(list.subarray(0, count)), list, dtRatio });
  }
}

/** tickAll every frame (E-218's view). */
class Flock extends GameObject {
  static components = [SpriteRenderer];
  static tickAll(list, count, dtRatio) {
    log.push({ who: 'flock', frame: herdFrame, ids: Array.from(list.subarray(0, count)), list, dtRatio });
  }
}

/** tickAll every INTERVAL frames, with a body. */
class Cart extends GameObject {
  static components = [SpriteRenderer, RigidBody];
  static tickInterval = INTERVAL;
  static tickAll(list, count, dtRatio) {
    log.push({ who: 'cart', frame: herdFrame, ids: Array.from(list.subarray(0, count)), list, dtRatio });
  }
}

/**
 * A logic worker with `classes` registered in PER_TYPE pools from index 0, every slot active and listed, and
 * logic.staggeredUpdates on unless `staggered` is false.
 */
async function setup(classes, { staggered = true, workers = 1, worker = 0 } = {}) {
  const scene = buildPoolScene({ entities: N });
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  GameObject.nextTick = staggered ? new Uint8Array(N) : null;
  GameObject.typeListVersions = null;
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = { ...scene.config, logic: { staggeredUpdates: staggered } };
  lw.globalEntityCount = N;
  lw.gameObjects = new Array(N).fill(null);
  lw.totalLogicWorkers = workers;
  lw.workerIndex = worker;
  lw.nonDecimatedTypes = [];
  lw.decimatedTypes = [];
  lw.tickAllTypes = [];
  lw.tickAllBucketTypes = [];
  lw.directionalTypes = [];
  lw._drainSpawnCommandRing = () => {};
  lw.processListUpdates = () => {};
  lw._latchDisplayPose = () => {};
  lw.sendListUpdatesToLogic0 = () => {};
  lw.registeredClasses = classes.map((C, t) => {
    globalThis.self[C.name] = C;
    C._activeList = new (EntityIdArray())(1 + PER_TYPE);
    return { name: C.name, poolSize: PER_TYPE, startIndex: t * PER_TYPE, endIndex: (t + 1) * PER_TYPE - 1, entityType: t };
  });
  await quietly(() => lw.createGameObjectInstances());
  for (let t = 0; t < classes.length; t++) {
    const list = classes[t]._activeList;
    list[0] = PER_TYPE;
    for (let k = 0; k < PER_TYPE; k++) {
      list[1 + k] = t * PER_TYPE + k;
      Transform.active[t * PER_TYPE + k] = 1;
    }
  }
  log = [];
  return lw;
}

function frame(lw, f, dtRatio) {
  lw.frameNumber = f;
  herdFrame = f;
  lw.update(16.67 * dtRatio, dtRatio, false);
}

function restore() {
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = null;
  GameObject.entityTypeHasForcedLogicWorker = null;
  Transform.active.fill(0);
}

test('tickInterval 4: each frame tickAll gets the entities tick() ticks on it, with the same dtRatio; each once in 4 frames', { concurrency: false }, async () => {
  try {
    const lw = await setup([Grazer, Herd]);
    assert.equal(lw.decimatedTypes.length, 1, 'Grazer ticks through the buckets');
    assert.equal(lw.tickAllBucketTypes.length, 1, 'Herd is a bucketed tickAll type');
    assert.equal(lw.tickAllTypes.length, 0, 'and not an every-frame one');

    const seen = new Map();
    for (let f = 1; f <= 3 * INTERVAL; f++) {
      const dtRatio = 0.5 + f / 8; // a different one each frame
      log = [];
      frame(lw, f, dtRatio);
      const ticked = log.filter((e) => e.who === 'tick');
      const batches = log.filter((e) => e.who === 'tickAll');
      assert.equal(batches.length, 1, `frame ${f}: one tickAll call`);
      const [batch] = batches;
      // The tick() pool's ids, shifted onto the tickAll pool: the same phases.
      assert.deepEqual(batch.ids, ticked.map((e) => e.id + PER_TYPE), `frame ${f}: the ids tick() ticks`);
      assert.equal(batch.ids.length, PER_TYPE / INTERVAL);
      for (const e of ticked) assert.equal(e.dtRatio, dtRatio, `frame ${f}: tick() gets the frame's dtRatio`);
      assert.equal(batch.dtRatio, dtRatio, `frame ${f}: tickAll gets the same`);
      for (const id of batch.ids) {
        if (seen.has(id)) assert.equal(f - seen.get(id), INTERVAL, `entity ${id} again ${INTERVAL} frames later`);
        seen.set(id, f);
      }
      if (f === INTERVAL) assert.equal(seen.size, PER_TYPE, 'every entity once in the first 4 frames');
    }
  } finally {
    restore();
  }
});

test('interval 1 keeps the view of the active list (E-218), every entity every frame, beside a bucketed type', { concurrency: false }, async () => {
  try {
    const lw = await setup([Flock, Herd]);
    assert.equal(lw.tickAllTypes.length, 1);
    assert.equal(lw.tickAllBucketTypes.length, 1);
    for (let f = 1; f <= INTERVAL; f++) {
      log = [];
      frame(lw, f, 1);
      const [flock] = log.filter((e) => e.who === 'flock');
      assert.deepEqual(flock.ids, Array.from({ length: PER_TYPE }, (_, k) => k), `frame ${f}: all of them`);
      assert.equal(flock.list.buffer, Flock._activeList.buffer, 'a view of the active list');
      assert.equal(flock.list.byteOffset, Flock._activeList.byteOffset + Flock._activeList.BYTES_PER_ELEMENT);
      const [herd] = log.filter((e) => e.who === 'tickAll');
      assert.equal(herd.list.buffer, lw.tickAllBucketTypes[0]._buckets[f % INTERVAL].buffer, 'a view of the bucket');
    }
  } finally {
    restore();
  }
});

test('an entity despawned this frame is left out; with a body, only the frame\'s entities have their accelerations reset', { concurrency: false }, async () => {
  try {
    const lw = await setup([Herd, Cart]);
    RigidBody.ax.fill(7);
    RigidBody.ay.fill(7);
    RigidBody.angularAccel.fill(7);
    frame(lw, 1, 1);
    const herd1 = log.find((e) => e.who === 'tickAll').ids;
    const cart1 = log.find((e) => e.who === 'cart').ids;
    assert.equal(log.find((e) => e.who === 'cart').list, lw._tickAllScratch, 'a type with a body goes through the scratch');
    for (let i = PER_TYPE; i < 2 * PER_TYPE; i++) {
      const reset = RigidBody.ax[i] + RigidBody.ay[i] + RigidBody.angularAccel[i] === 0;
      assert.equal(reset, cart1.includes(i), `entity ${i}: reset only on its tick frame`);
    }
    // Frame 1 + 4 ticks the same bucket; one of it has despawned.
    Transform.active[herd1[1]] = 0;
    log = [];
    frame(lw, 1 + INTERVAL, 1);
    const herd5 = log.find((e) => e.who === 'tickAll');
    assert.deepEqual(herd5.ids, herd1.filter((id) => id !== herd1[1]));
    assert.equal(herd5.list, lw._tickAllScratch, 'filtered into the scratch');
  } finally {
    restore();
  }
});

test('two logic workers split each frame\'s bucket between them, a type with pinned entities too', { concurrency: false }, async () => {
  try {
    for (const pinned of [false, true]) {
      const shares = [];
      for (const worker of [0, 1]) {
        const lw = await setup([Herd], { workers: 2, worker });
        if (pinned) {
          // Entity 6 runs on logic worker 1 only; the others keep the list's own split.
          GameObject.forceProcessOnLogicWorker = new Int16Array(N).fill(-1);
          GameObject.forceProcessOnLogicWorker[6] = 1;
          GameObject.entityTypeHasForcedLogicWorker = Uint8Array.of(1);
        }
        const byFrame = [];
        for (let f = 1; f <= INTERVAL; f++) {
          log = [];
          frame(lw, f, 1);
          const batch = log.find((e) => e.who === 'tickAll');
          byFrame.push(batch ? batch.ids : []);
        }
        shares.push(byFrame);
        restore();
      }
      const all = [];
      for (let f = 0; f < INTERVAL; f++) {
        const a = shares[0][f];
        const b = shares[1][f];
        // The bucket's block split gives each worker some every frame. The list's own split (a type with pinned
        // entities, as tick()'s countdown path splits it) gives the slot's parity: a frame's bucket may sit on one.
        if (!pinned) assert.ok(a.length > 0 && b.length > 0, `frame ${f + 1}: both workers get some`);
        assert.equal(a.filter((id) => b.includes(id)).length, 0, 'no entity on both');
        all.push(...a, ...b);
        if (pinned) assert.ok(!a.includes(6), 'the pinned entity never on worker 0');
      }
      if (pinned) assert.ok(shares[1][2].includes(6), 'the pinned entity on worker 1, on its frame (phase 3)');
      assert.deepEqual(all.sort((p, q) => p - q), Array.from({ length: PER_TYPE }, (_, k) => k), `pinned ${pinned}: each once`);
    }
  } finally {
    restore();
  }
});

test('without logic.staggeredUpdates, tickInterval 4 ticks every frame, as tick() does', { concurrency: false }, async () => {
  try {
    const lw = await setup([Herd], { staggered: false });
    assert.equal(lw.tickAllBucketTypes.length, 0);
    assert.equal(lw.tickAllTypes.length, 1);
    for (let f = 1; f <= 2; f++) {
      log = [];
      frame(lw, f, 1);
      assert.equal(log.find((e) => e.who === 'tickAll').ids.length, PER_TYPE);
    }
  } finally {
    restore();
  }
});
