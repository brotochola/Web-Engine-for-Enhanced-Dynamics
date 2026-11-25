#!/usr/bin/env node
/**
 * Kernel (E-342): which entities a staggered type ticks on a frame, and what that costs the caches. Today a type with
 * tickInterval T ticks the ids with id % T equal to the frame's phase: one entity in T of every 64-byte line of every
 * per-entity column, each frame. By blocks ((id >> 6) % T) the same number of entities fill whole lines, and the other
 * lines are left alone.
 *
 *   mod    id % T
 *   block  (id >> 6) % T
 *
 * As a logic worker sees it: another thread (physics) has just rewritten every entity's pose, velocity and turn and read
 * its accelerations, so those lines are in its core's cache; the ticks read the pose columns and a few game columns, read
 * their object, and write the accelerations and two game columns. N entities of four types with T 2, 4, 6 and 12 (a quarter
 * each). One op is a frame: the pose written by the other thread (not timed), then every type's bucket.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/tickPhaseBlocksKernel.mjs --variants mod,block --rounds 5
 *   node tests/bench/tickPhaseBlocksKernel.mjs [--variant block] [--n 24000] [--neighbors 4] [--output path]
 *
 * --neighbors k: each tick also reads the pose of k entities near it in the world (near in id here: the best case for both).
 * The checksum is the number of ticks each entity got over whole cycles of its type (the same whichever way they go) and
 * the accelerations they leave.
 */
import { Worker, isMainThread, workerData } from 'node:worker_threads';

import { isCli, parseArgs, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const POSE = 6; // x, y, vx, vy, rotC, rotS
const ACC = 3; // ax, ay, aa
const GAME = 7; // hp, energy, speed, range, fear, cooldown, target

if (!isMainThread) {
  // "Physics": each frame rewrites the pose columns from the accelerations.
  const { sab, n, ctl } = workerData;
  const c = new Int32Array(ctl);
  const col = (k) => new Float32Array(sab, k * n * 4, n);
  const [x, y, vx, vy, rc, rs, ax, ay, aa] = Array.from({ length: POSE + ACC }, (_, k) => col(k));
  for (let f = 1; ; f++) {
    Atomics.wait(c, 0, f - 1);
    if (Atomics.load(c, 2) !== 0) break;
    for (let i = 0; i < n; i++) {
      vx[i] = vx[i] * 0.98 + ax[i] * 0.01;
      vy[i] = vy[i] * 0.98 + ay[i] * 0.01;
      x[i] += vx[i];
      y[i] += vy[i];
      const t = aa[i] * 0.001;
      rc[i] = 1 - t * t;
      rs[i] = t;
    }
    Atomics.store(c, 1, f);
    Atomics.notify(c, 1);
  }
}

class Agent {
  constructor(index) {
    this.index = index;
    this.ticks = 0;
    this.mood = index & 7;
  }
}

/** One tick: the columns a game's agent reads and writes, by its index. */
function tick(a, C, n, neighbors) {
  const i = a.index;
  const x = C.x[i];
  const y = C.y[i];
  let sx = 0;
  let sy = 0;
  for (let k = 1; k <= neighbors; k++) {
    const j = i + k * 3 < n ? i + k * 3 : i - k * 3;
    sx += x - C.x[j];
    sy += y - C.y[j];
  }
  const speed = C.speed[i];
  const fear = C.fear[i] * 0.99 + C.hp[i] * 0.001;
  const hurry = fear > 0.5 ? 1.5 : 1;
  C.ax[i] = (C.rc[i] * speed - C.vx[i]) * hurry + sx * 0.01;
  C.ay[i] = (C.rs[i] * speed - C.vy[i]) * hurry + sy * 0.01;
  C.aa[i] = C.range[i] * 0.1 - C.energy[i] * 0.01;
  C.fear[i] = fear;
  C.cooldown[i] = C.cooldown[i] > 0 ? C.cooldown[i] - 1 : C.target[i];
  a.ticks++;
  a.mood = (a.mood + 1) & 7;
}

function runBucket(list, count, agents, C, n, neighbors) {
  for (let k = 0; k < count; k++) tick(agents[list[k]], C, n, neighbors);
}

export function setupTickPhases({ n = 24000, variant = 'mod', neighbors = 4 } = {}) {
  const names = ['x', 'y', 'vx', 'vy', 'rc', 'rs', 'ax', 'ay', 'aa', 'hp', 'energy', 'speed', 'range', 'fear', 'cooldown', 'target'];
  if (names.length !== POSE + ACC + GAME) throw new Error('columns');
  const sab = new SharedArrayBuffer(names.length * n * 4);
  const C = Object.fromEntries(names.map((name, k) => [name, new Float32Array(sab, k * n * 4, n)]));
  for (let i = 0; i < n; i++) {
    C.x[i] = (i * 37) % 4000;
    C.y[i] = (i * 91) % 4000;
    C.rc[i] = 1;
    C.hp[i] = i % 100;
    C.energy[i] = i % 50;
    C.speed[i] = 1 + (i % 5) * 0.2;
    C.range[i] = i % 30;
    C.fear[i] = (i % 10) * 0.1;
    C.target[i] = i % 13;
  }
  const agents = Array.from({ length: n }, (_, i) => new Agent(i));
  const quarter = (n / 4) | 0;
  const types = [2, 4, 6, 12].map((T, t) => {
    const start = t * quarter;
    const buckets = Array.from({ length: T }, () => []);
    for (let i = start; i < start + quarter; i++) buckets[variant === 'block' ? (i >> 6) % T : i % T].push(i);
    return { T, buckets: buckets.map((b) => Uint32Array.from(b)) };
  });
  const frame = (f) => {
    for (const { T, buckets } of types) {
      const list = buckets[f % T];
      runBucket(list, list.length, agents, C, n, neighbors);
    }
  };
  return { n, sab, C, agents, types, frame, perCycle: 12 };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant ?? 'mod');
  if (!['mod', 'block'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const n = Number(args.n ?? 24000);
  const neighbors = Number(args.neighbors ?? 4);
  const s = setupTickPhases({ n, variant, neighbors });
  const ctl = new SharedArrayBuffer(12);
  const c = new Int32Array(ctl);
  const peer = new Worker(new URL(import.meta.url), { workerData: { sab: s.sab, n, ctl } });
  warmNormalCompile(() => runBucket(s.types[0].buckets[0], 64, s.agents, s.C, n, neighbors));
  let f = 0;
  const physics = () => {
    f++;
    Atomics.store(c, 0, f);
    Atomics.notify(c, 0);
    while (Atomics.load(c, 1) !== f) Atomics.wait(c, 1, f - 1);
  };
  const samples = [];
  const frames = 240 * s.perCycle;
  for (let k = 0; k < frames; k++) {
    physics();
    const t0 = performance.now();
    s.frame(k);
    const t = performance.now() - t0;
    if (k >= 40 * s.perCycle) samples.push(t);
  }
  Atomics.store(c, 2, 1);
  Atomics.add(c, 0, 1);
  Atomics.notify(c, 0);
  await peer.terminate();
  let h = 2166136261;
  for (const a of s.agents) h = Math.imul(h ^ (a.ticks % s.perCycle), 16777619) >>> 0;
  const ticks = s.types.reduce((sum, t) => sum + t.buckets.reduce((x, b) => x + b.length, 0) / t.T, 0);
  const meanMs = samples.reduce((x, v) => x + v, 0) / samples.length;
  const worst = [...samples].sort((x, y) => x - y)[Math.floor(samples.length * 0.95)];
  const report = {
    feature: 'tick-phase-blocks', variant, n, neighbors, checksum: h,
    cases: { frame: { opsPerSec: 1000 / meanMs, nsPerTick: (1e6 * meanMs) / ticks, p95Ms: worst } },
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`${variant}: ${((1e6 * meanMs) / ticks).toFixed(2)} ns a tick, ${meanMs.toFixed(3)} ms a frame, p95 ${worst.toFixed(3)} (checksum ${h})`);
}

if (isMainThread && isCli(import.meta.url)) await main();
