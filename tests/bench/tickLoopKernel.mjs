// E-215 step 0: the staggered tick loop with several types through one call site. LogicWorker._tickIntervalBucket (the
// shipped function, on a real logic worker from workerHarness) runs every type's bucket, so `obj.tick` and
// `typeof obj.tick` are loads at a megamorphic site. The candidate (a copy here: kernels never write src/) looks the
// type's tick up once per bucket and calls it with .call. Four types of Predator's kind (intervals 4, 6, 6, 30), each
// with its own tick and fields, 4000 entities each, all with a RigidBody (the acceleration resets run). Each "frame"
// runs every type's bucket for that frame number; the checksum is the sum of every entity's tick counter.
//   node tests/bench/tickLoopKernel.mjs [--frames 600] [--rounds 5] [--output path]
import { isCli, parseArgs, writeReport } from './microbenchHelpers.mjs';
import { loadWorker, quietly } from './workerHarness.mjs';

const PER_TYPE = 4000;

// Four classes with ticks of their own and different shapes, like Predator's people.
class Civilian {
  constructor() { this.n = 0; this.fear = 0.5; this.x = 1.5; }
  tick(dt) { this.n = (this.n + 1) | 0; this.fear = this.fear * 0.99 + dt * 0.01; }
}
class Soldier {
  constructor() { this.n = 0; this.ammo = 30; this.aim = 0.25; this.cool = 0; }
  tick(dt) { this.n = (this.n + 1) | 0; this.cool = this.cool > 0 ? this.cool - 1 : 0; this.aim += dt * 0.001; }
}
class Medic {
  constructor() { this.heal = 2; this.n = 0; }
  tick() { this.n = (this.n + 1) | 0; this.heal = (this.heal + 1) & 7; }
}
class Boid {
  constructor() { this.vx = 0.5; this.vy = -0.5; this.n = 0; }
  tick(dt) { this.n = (this.n + 1) | 0; this.vx += dt * 0.001; this.vy -= dt * 0.001; }
}
const TYPES = [[Civilian, 4], [Soldier, 6], [Medic, 6], [Boid, 30]];

/** The candidate: _tickIntervalBucket's RigidBody loop with the type's tick looked up once. */
function candidateBucket(typeInfo, tickFn, list, from, to, dtRatio, deltaTime, accTime, frameNum, transformActive, gameObjects, rbAx, rbAy, rbAa) {
  let visited = 0;
  for (let i = from; i < to; i++) {
    const entityIndex = list[i];
    if (transformActive[entityIndex] === 0) continue;
    const obj = gameObjects[entityIndex];
    if (obj === undefined) continue;
    rbAx[entityIndex] = 0;
    rbAy[entityIndex] = 0;
    rbAa[entityIndex] = 0;
    tickFn.call(obj, dtRatio, deltaTime, accTime, frameNum);
    visited++;
  }
  return visited;
}

export async function run({ frames = 600, rounds = 5 } = {}) {
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  const total = TYPES.length * PER_TYPE;
  const gameObjects = new Array(total);
  const transformActive = new Uint8Array(total).fill(1);
  const rbAx = new Float32Array(total);
  const rbAy = new Float32Array(total);
  const rbAa = new Float32Array(total);
  const infos = [];
  // Interleave the types over the indices, as pools are not: each type keeps a contiguous range.
  for (let t = 0; t < TYPES.length; t++) {
    const [C, interval] = TYPES[t];
    const start = t * PER_TYPE;
    const activeList = new Uint32Array(PER_TYPE + 1);
    activeList[0] = PER_TYPE;
    for (let k = 0; k < PER_TYPE; k++) {
      gameObjects[start + k] = new C();
      activeList[1 + k] = start + k;
    }
    infos.push({ info: { entityType: t, hasRigidBody: true }, activeList, interval, C });
  }
  const reset = () => {
    for (let i = 0; i < total; i++) gameObjects[i].n = 0;
  };
  const sum = () => {
    let s = 0;
    for (let i = 0; i < total; i++) s += gameObjects[i].n;
    return s;
  };
  const shipped = (frame) => {
    for (let t = 0; t < infos.length; t++) {
      const x = infos[t];
      lw._tickIntervalBucket(x.info, x.activeList, PER_TYPE, x.interval, frame, 1, 16.6, frame * 16.6, transformActive,
        gameObjects, rbAx, rbAy, rbAa, 1, 0);
    }
  };
  const candidate = (frame) => {
    for (let t = 0; t < infos.length; t++) {
      const x = infos[t];
      // The shipped bookkeeping keeps the buckets; the candidate reads the same ones.
      const phase = frame % x.interval;
      const list = x.info._buckets[phase];
      const n = x.info._bucketCounts[phase];
      candidateBucket(x.info, x.C.prototype.tick, list, 0, n, 1, 16.6, frame * 16.6, frame, transformActive, gameObjects, rbAx, rbAy, rbAa);
    }
  };
  // Buckets built, both sides warmed through short calls.
  await quietly(() => {
    for (let f = 1; f <= 400; f++) shipped(f);
  });
  for (let f = 1; f <= 400; f++) candidate(f);
  reset();
  for (let f = 1; f <= frames; f++) shipped(f);
  const want = sum();
  reset();
  for (let f = 1; f <= frames; f++) candidate(f);
  if (sum() !== want) throw new Error(`the candidate ticked ${sum()} times, the shipped loop ${want}`);

  const times = { shipped: [], candidate: [] };
  for (let r = 0; r < rounds; r++) {
    for (const side of r % 2 === 0 ? ['shipped', 'candidate'] : ['candidate', 'shipped']) {
      const fn = side === 'shipped' ? shipped : candidate;
      reset();
      const t0 = performance.now();
      for (let f = 1; f <= frames; f++) fn(f);
      times[side].push(performance.now() - t0);
      if (sum() !== want) throw new Error(`${side}: checksum moved`);
    }
  }
  const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
  const ticks = want;
  return {
    kernel: 'tickLoop',
    types: TYPES.map(([C, i]) => `${C.name}/${i}`),
    perType: PER_TYPE,
    frames,
    rounds,
    ticks,
    shipped: { ms: med(times.shipped), nsPerTick: (med(times.shipped) * 1e6) / ticks, runs: times.shipped },
    candidate: { ms: med(times.candidate), nsPerTick: (med(times.candidate) * 1e6) / ticks, runs: times.candidate },
    change: med(times.candidate) / med(times.shipped) - 1,
  };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const res = await run({ frames: args.frames ?? 600, rounds: args.rounds ?? 5 });
  console.log(`${res.types.join(', ')}; ${res.perType} each, ${res.frames} frames, ${res.ticks} ticks a run`);
  console.log(`  shipped:   ${res.shipped.nsPerTick.toFixed(1)} ns a tick`);
  console.log(`  candidate: ${res.candidate.nsPerTick.toFixed(1)} ns a tick (${(res.change * 100).toFixed(1)} %)`);
  if (args.output) writeReport(args.output, res);
}
