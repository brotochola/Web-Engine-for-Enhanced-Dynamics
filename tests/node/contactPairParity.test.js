import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { collisionPairKey } from '../../src/util/utils.js';
import { BOX2D_CONTACT_KIND, createContactWorker, publishContactEvent } from '../bench/contactFlowHarness.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

// Reference: the Set + two-Map contact tracker (gens in (min, max) order), one
// logic worker's view. The engine must match it frame by frame: the same
// enter/stay/exit callbacks (stay order across pairs is not a contract, so each
// frame's log is compared sorted) and the same isCollidingWith answers.
class ReferenceTracker {
  constructor(workerIndex, totalWorkers, gen, active, log) {
    this.w = workerIndex;
    this.n = totalWorkers;
    this.gen = gen;
    this.active = active;
    this.log = log;
    this.pairs = new Set();
    this.genA = new Map();
    this.genB = new Map();
  }
  begin(a, b, ga, gb) {
    if ((this.gen[a] | 0) !== (ga | 0) || (this.gen[b] | 0) !== (gb | 0)) return;
    if (!this.active[a] || !this.active[b]) return;
    const minE = a < b ? a : b;
    const maxE = a < b ? b : a;
    const key = collisionPairKey(minE, maxE);
    const isNew = !this.pairs.has(key);
    this.pairs.add(key);
    this.genA.set(key, (a < b ? ga : gb) >>> 0);
    this.genB.set(key, (a < b ? gb : ga) >>> 0);
    this.beginSet.add(key);
    if (!isNew || minE % this.n !== this.w) return;
    this.log.push(`enter ${a} ${b}`, `enter ${b} ${a}`);
  }
  end(a, b, ga, gb) {
    const minE = a < b ? a : b;
    const maxE = a < b ? b : a;
    const key = collisionPairKey(minE, maxE);
    if (!this.pairs.has(key)) return;
    const match = this.genA.get(key) === ((a < b ? ga : gb) >>> 0) && this.genB.get(key) === ((a < b ? gb : ga) >>> 0);
    this.pairs.delete(key);
    this.genA.delete(key);
    this.genB.delete(key);
    if (!match || minE % this.n !== this.w) return;
    this.log.push(`exit ${minE} ${maxE}`, `exit ${maxE} ${minE}`);
  }
  frame(events) {
    this.beginSet = new Set();
    for (const [kind, a, b, ga, gb] of events) {
      if (kind === BOX2D_CONTACT_KIND.CONTACT_END) this.end(a, b, ga, gb);
      else this.begin(a, b, ga, gb);
    }
    for (const key of [...this.pairs]) {
      const minE = key >>> 16;
      const maxE = key & 0xffff;
      const valid =
        this.active[minE] &&
        this.active[maxE] &&
        this.genA.get(key) === (this.gen[minE] >>> 0) &&
        this.genB.get(key) === (this.gen[maxE] >>> 0);
      if (!valid) {
        this.pairs.delete(key);
        this.genA.delete(key);
        this.genB.delete(key);
        continue;
      }
      if (this.beginSet.has(key) || minE % this.n !== this.w) continue;
      this.log.push(`stay ${minE} ${maxE}`, `stay ${maxE} ${minE}`);
    }
  }
}

async function runScenario(workerIndex, seed) {
  const N = 48;
  const engineLog = [];
  const refLog = [];
  const { worker, gen } = await createContactWorker({ n: N, workerIndex, totalWorkers: 3, log: engineLog });
  const active = Transform.active;
  const ref = new ReferenceTracker(workerIndex, 3, gen, active, refLog);
  const rng = mulberry32(seed);
  const live = new Map();
  for (let frame = 0; frame < 120; frame++) {
    const events = [];
    const count = 1 + ((rng() * 12) | 0);
    for (let e = 0; e < count; e++) {
      const a = (rng() * N) | 0;
      let b = (rng() * N) | 0;
      if (b === a) b = (a + 1) % N;
      const key = collisionPairKey(Math.min(a, b), Math.max(a, b));
      const r = rng();
      if (r < 0.5 || !live.has(key)) {
        events.push([BOX2D_CONTACT_KIND.CONTACT_BEGIN, a, b, gen[a], gen[b]]);
        live.set(key, [a, b]);
      } else if (r < 0.9) {
        const [la, lb] = live.get(key);
        events.push([BOX2D_CONTACT_KIND.CONTACT_END, la, lb, gen[la], gen[lb]]);
        live.delete(key);
      } else {
        // End without a begin, or with stale gens.
        events.push([BOX2D_CONTACT_KIND.CONTACT_END, b, a, gen[b] + 1, gen[a]]);
      }
    }
    if (rng() < 0.15) gen[(rng() * N) | 0]++;
    if (rng() < 0.05) {
      const i = (rng() * N) | 0;
      active[i] = active[i] ? 0 : 1;
    }
    for (const ev of events) publishContactEvent(...ev);
    engineLog.length = 0;
    refLog.length = 0;
    worker.processCollisionCallbacks();
    ref.frame(events);
    assert.deepEqual([...engineLog].sort(), [...refLog].sort(), `worker ${workerIndex} frame ${frame} callbacks`);
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        const key = collisionPairKey(a, b);
        assert.equal(worker.frameCollisions.has(key), ref.pairs.has(key), `worker ${workerIndex} frame ${frame} pair ${a},${b}`);
      }
    }
  }
}

test('contact tracker matches the Set + two-Map reference (worker 0 of 3)', async () => {
  await runScenario(0, 0x51eed);
});

test('contact tracker matches the Set + two-Map reference (worker 1 of 3)', async () => {
  await runScenario(1, 0xbeef5);
});
