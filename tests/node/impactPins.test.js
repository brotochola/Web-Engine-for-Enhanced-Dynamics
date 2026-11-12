import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { IMPACT_FLOATS, bindImpactRing, impactRingBytes, publishImpacts } from '../../src/util/impactRing.js';

// N-129: processImpacts sent each impact to the logic worker targetId % workers, where ticks and collision callbacks
// honour GameObject.forceProcessOnLogicWorker: a pinned entity was shot on a worker that does not tick it. And the
// impacts were one batch the particle worker overwrote each frame: a logic worker that missed a particle frame lost
// its impacts. Now a ring (impactRing.js) each logic worker reads from where it stopped.

const MAX_IMPACTS = 64;

/** The real logic worker bound to a fresh impact ring, as its init binds it, and the ring's writer side. */
async function ringWorker() {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const buffer = new SharedArrayBuffer(impactRingBytes(MAX_IMPACTS));
  const ring = bindImpactRing(buffer, MAX_IMPACTS);
  worker._impactRing = bindImpactRing(buffer, MAX_IMPACTS);
  worker._impactData = worker._impactRing.data;
  worker._impactMask = worker._impactRing.mask;
  worker._impactRead = Atomics.load(worker._impactRing.header, 0);
  worker._impactsLostWarned = false;
  return { worker, ring };
}

/** A particle frame's impacts on `targets` (damage 10 + k), published as the particle worker publishes them. */
function particleFrame(ring, targets, damage0 = 10) {
  const src = new Float32Array(targets.length * IMPACT_FLOATS);
  targets.forEach((id, k) => src.set([id, damage0 + k, 1, 2, 99, 3], k * IMPACT_FLOATS));
  publishImpacts(ring, src, targets.length);
}

/** Every shot a poll of `worker` runs, as [entity, damage], with every target listening. */
function poll(worker, workerIndex, totalWorkers, ids) {
  worker.workerIndex = workerIndex;
  worker.totalLogicWorkers = totalWorkers;
  const shots = [];
  const gameObjects = [];
  for (const id of ids) gameObjects[id] = { onGotShot: (damage) => shots.push([id, damage]) };
  worker.gameObjects = gameObjects;
  worker._pollImpacts();
  return shots;
}

test('a pinned entity is shot on the worker it is pinned to, the rest by index', async () => {
  const saved = GameObject.forceProcessOnLogicWorker;
  try {
    const pins = new Int16Array(16).fill(-1);
    pins[5] = 0; // 5 % 2 is 1: the modulo would send it to worker 1
    GameObject.forceProcessOnLogicWorker = pins;
    const targets = [4, 5, 7];
    const w0 = await ringWorker();
    particleFrame(w0.ring, targets);
    assert.deepEqual(poll(w0.worker, 0, 2, targets), [[4, 10], [5, 11]]);
    const w1 = await ringWorker();
    particleFrame(w1.ring, targets);
    assert.deepEqual(poll(w1.worker, 1, 2, targets), [[7, 12]]);
    GameObject.forceProcessOnLogicWorker = null;
    const w2 = await ringWorker();
    particleFrame(w2.ring, targets);
    assert.deepEqual(poll(w2.worker, 1, 2, targets), [[5, 11], [7, 12]], 'without pins, by index');
  } finally {
    GameObject.forceProcessOnLogicWorker = saved;
  }
});

test('a logic worker that misses particle frames runs every impact they published, each once', async () => {
  const { worker, ring } = await ringWorker();
  // Two particle frames before the logic frame: the second used to overwrite the first.
  particleFrame(ring, [1, 2], 10);
  particleFrame(ring, [3], 20);
  assert.deepEqual(poll(worker, 0, 1, [1, 2, 3]), [[1, 10], [2, 11], [3, 20]]);
  assert.deepEqual(poll(worker, 0, 1, [1, 2, 3]), [], 'nothing twice');
  particleFrame(ring, [2], 30);
  assert.deepEqual(poll(worker, 0, 1, [1, 2, 3]), [[2, 30]]);
});

test('the ring wraps, and a worker further behind than it holds runs the newest and says it lost the rest', async () => {
  const { worker, ring } = await ringWorker();
  const warns = [];
  const warn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    // Around the ring a few times, polled each frame: every impact once, in order.
    const seen = [];
    for (let f = 0; f < 3 * ring.slots / MAX_IMPACTS; f++) {
      const ids = Array.from({ length: MAX_IMPACTS }, (_, k) => 1 + ((f * 7 + k) % 50));
      particleFrame(ring, ids, f * 1000);
      for (const [, d] of poll(worker, 0, 1, Array.from({ length: 51 }, (_, i) => i))) seen.push(d);
      assert.equal(seen.length, (f + 1) * MAX_IMPACTS, `frame ${f}: each impact once`);
      assert.equal(seen[seen.length - 1], f * 1000 + MAX_IMPACTS - 1);
    }
    assert.deepEqual(warns, []);
    // Now more than the ring holds between two polls: the newest ring.slots run, and the loss is said once.
    const frames = ring.slots / MAX_IMPACTS + 2;
    for (let f = 0; f < frames; f++) particleFrame(ring, Array.from({ length: MAX_IMPACTS }, () => 3), f * 100);
    const shots = poll(worker, 0, 1, [3]);
    assert.equal(shots.length, ring.slots, 'the ring\'s worth');
    assert.equal(shots[0][1], 2 * 100, 'from the oldest it still holds');
    assert.equal(warns.length, 1);
    assert.match(warns[0], new RegExp(`${2 * MAX_IMPACTS} bullet impacts lost`));
  } finally {
    console.warn = warn;
  }
});
