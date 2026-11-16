import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { collisionPairKey } from '../../src/util/utils.js';
import { BOX2D_CONTACT_KIND, createContactWorker, logicWorkerClass, publishContactEvent } from '../bench/contactFlowHarness.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

// E-282. The logic worker's contact pairs moved from a Map keyed by collisionPairKey (_pairSlot)
// to an open-addressing table on typed arrays. The slot columns and their swap-remove did not
// change, so the callbacks, their order (stays follow slot order) and isCollidingWith's answers
// must be exactly those of the Map version. The Map version here is the same worker with the
// three table methods over a Map keyed by collisionPairKey, the index _pairSlot was. Both run one
// seeded script: thousands of pairs (the table doubles three times), ends, re-begins of ended
// pairs, ends without a begin or with stale gens, and ids reused (a body generation bumped, an
// entity off and on again), with and without stay listeners (E-302's lazy pairs).

const N = 400;
const WORKERS = 3;

const mapIndexed = (Base, none) => class MapIndexedLogicWorker extends Base {
  _pairFind(minE, maxE) {
    const v = this._refPairs.get(collisionPairKey(minE, maxE));
    return v === undefined ? none : v;
  }

  _pairPut(minE, maxE, value) {
    this._refPairs.set(collisionPairKey(minE, maxE), value);
  }

  _pairDelete(minE, maxE) {
    this._refPairs.delete(collisionPairKey(minE, maxE));
  }

  _clearContactState(reason) {
    this._refPairs.clear();
    super._clearContactState(reason);
  }
};

async function runScript({ Ctor, workerIndex, seed, stays }) {
  const log = [];
  const { worker, gen } = await createContactWorker({ n: N, workerIndex, totalWorkers: WORKERS, Ctor, log });
  if (Ctor) worker._refPairs = new Map();
  if (!stays) worker.collisionStayByType.fill(0);
  const active = Transform.active;
  const rng = mulberry32(seed);
  const live = new Map();
  const ended = [];
  const frames = [];
  for (let frame = 0; frame < 90; frame++) {
    // Ten frames of 700 begins fill the table past 2048, 4096 and 8192 rows; churn after that.
    const begins = frame < 10 ? 700 : 40;
    for (let e = 0; e < begins; e++) {
      const a = (rng() * N) | 0;
      let b = (rng() * N) | 0;
      if (b === a) b = (a + 1) % N;
      publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_BEGIN, a, b, gen[a], gen[b]);
      live.set(collisionPairKey(Math.min(a, b), Math.max(a, b)), [a, b]);
    }
    if (frame >= 10) {
      const keys = [...live.keys()];
      for (let e = 0; e < 60 && keys.length; e++) {
        const key = keys[(rng() * keys.length) | 0];
        const pair = live.get(key);
        if (!pair) continue;
        const [a, b] = pair;
        const r = rng();
        if (r < 0.8) {
          publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_END, a, b, gen[a], gen[b]);
          live.delete(key);
          ended.push(pair);
        } else {
          // End with a stale gen (no exit), or of a pair that never began.
          publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_END, b, a, gen[b] + 1, gen[a]);
        }
      }
      // Re-begin pairs that ended earlier.
      for (let e = 0; e < 20 && ended.length; e++) {
        const [a, b] = ended.splice((rng() * ended.length) | 0, 1)[0];
        publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_BEGIN, b, a, gen[b], gen[a]);
        live.set(collisionPairKey(Math.min(a, b), Math.max(a, b)), [a, b]);
      }
      // Ids reused: a body rebuilt at the same index, an entity despawned and spawned again.
      if (rng() < 0.3) gen[(rng() * N) | 0]++;
      if (rng() < 0.2) {
        const i = (rng() * N) | 0;
        active[i] = 0;
        if (rng() < 0.5) active[i] = 1;
      } else if (rng() < 0.2) {
        active[(rng() * N) | 0] = 1;
      }
    }
    log.length = 0;
    worker.processCollisionCallbacks();
    const has = [];
    for (let q = 0; q < 200; q++) {
      const a = (rng() * N) | 0;
      const b = (a + 1 + ((rng() * (N - 1)) | 0)) % N;
      has.push(worker.frameCollisions.has(collisionPairKey(Math.min(a, b), Math.max(a, b))) ? 1 : 0);
    }
    frames.push({
      log: log.join('\n'),
      has: has.join(''),
      own: worker._pairCount,
      foreign: worker._foreignCount,
      ownPairs: Array.from(worker._pairMin.subarray(0, worker._pairCount), (m, s) => `${m}:${worker._pairMax[s]}`).join(','),
    });
  }
  return { frames, worker };
}

for (const stays of [true, false]) {
  for (const workerIndex of [0, 2]) {
    test(`the pair table fires what the Map version fires, in its order (worker ${workerIndex} of ${WORKERS}, ${stays ? 'stays' : 'no stay listener'})`, async () => {
      const Base = await logicWorkerClass();
      const seed = 0x282 + workerIndex * 7 + (stays ? 0 : 100);
      const table = await runScript({ Ctor: null, workerIndex, seed, stays });
      const none = table.worker._pairFind(N + 1, N + 2);
      const ref = await runScript({ Ctor: mapIndexed(Base, none), workerIndex, seed, stays });
      assert.ok(table.worker._pairHashMin.length >= 16384, `the table grew (${table.worker._pairHashMin.length} rows)`);
      let enters = 0;
      let exits = 0;
      let stayCalls = 0;
      for (let f = 0; f < table.frames.length; f++) {
        const a = table.frames[f];
        const b = ref.frames[f];
        assert.equal(a.log, b.log, `frame ${f}: callbacks and their order`);
        assert.equal(a.has, b.has, `frame ${f}: isCollidingWith answers`);
        assert.equal(a.own, b.own, `frame ${f}: own pairs`);
        assert.equal(a.foreign, b.foreign, `frame ${f}: foreign pairs`);
        assert.equal(a.ownPairs, b.ownPairs, `frame ${f}: own slot order`);
        enters += (a.log.match(/^enter /gm) || []).length;
        exits += (a.log.match(/^exit /gm) || []).length;
        stayCalls += (a.log.match(/^stay /gm) || []).length;
      }
      assert.ok(enters > 1000 && exits > 100, `the script exercised begins (${enters}) and ends (${exits})`);
      if (stays) assert.ok(stayCalls > 1000, `and stays (${stayCalls})`);
      // Every pair the table holds is one slot, and the table's count is the slots'.
      assert.equal(table.worker._pairHashSize, table.worker._pairCount + table.worker._foreignCount);
    });
  }
}

test('the pair table finds, updates and deletes through collisions and wrap-around', async () => {
  const { worker } = await createContactWorker({ n: 8, workerIndex: 0, totalWorkers: 1 });
  const none = worker._pairFind(1, 2);
  const ref = new Map();
  const rng = mulberry32(0x7ab1e);
  // Many keys over few ids: long probe runs that wrap past the last row.
  for (let step = 0; step < 40000; step++) {
    const minE = (rng() * 300) | 0;
    const maxE = minE + 1 + ((rng() * 300) | 0);
    const key = minE * 1024 + maxE;
    const r = rng();
    if (r < 0.55) {
      const v = (rng() * 1e6) | 0;
      worker._pairPut(minE, maxE, v);
      ref.set(key, v);
    } else if (r < 0.9) {
      worker._pairDelete(minE, maxE);
      ref.delete(key);
    }
    const got = worker._pairFind(minE, maxE);
    assert.equal(got, ref.has(key) ? ref.get(key) : none, `step ${step}`);
    assert.equal(worker._pairHashSize, ref.size, `step ${step} size`);
  }
  for (const [key, v] of ref) assert.equal(worker._pairFind((key / 1024) | 0, key % 1024), v);
  worker._clearContactState(null);
  assert.equal(worker._pairHashSize, 0);
  for (const key of ref.keys()) assert.equal(worker._pairFind((key / 1024) | 0, key % 1024), none);
});
