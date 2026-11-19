#!/usr/bin/env node
/**
 * Kernel for the shipped publishPose inside weedjsPost.js.
 * The function is a closure, so this evals the real script (importScripts
 * stubbed) and calls weedjsPublishPose. It does not copy the loop.
 * `--variant ph1` applies the epoch fast-path as a source diff before eval (shipped since; its anchor is gone).
 * `--variant runs` (E-246): when no slot was respawned, the dense list's runs of consecutive slots are copied with
 * set(), one call per column, instead of four loads and stores a body.
 * `--variant slots` (E-246): when no slot was respawned and at least 3/4 of the slots hold a body, the slots are walked
 * in order (densePositions) and each run of 256 or more slots with a body is copied with set(); the dense list's order no longer
 * matters.
 * `--holes f`: f of the bodies removed from the dense list for good (empty slots between the runs).
 * `--runs r [--occupancy 0.58]`: the bodies (occupancy of the slots) in r runs spread over the table with gaps between,
 * as entity pools hold them (Predator: 24 800 bodies in 42 600 slots), the dense list in a shuffled order.
 * `--respawn`: the generation epoch moves every frame (somebody respawned), so publishPose checks each body's
 * generation (no generation actually changes, so every body still publishes).
 * `--churn f`: f of the bodies swap-removed from the dense list and added back at its end, as despawns and respawns
 * leave it (0: the list in slot order).
 *
 * Frames as Predator's (E-327): with any of the options below each frame changes the pose first, then publishes, and only
 * the publish is timed (performance.now around weedjsPublishPose; the report gives the mean per publish and its ops/s).
 * `--moving f`: f of the bodies (every 1/f-th of the dense list) move every frame (x and y change).
 * `--turning k`: k bodies, spread over the dense list, turn every frame (rotC and rotS change); the others keep theirs.
 * `--stamps`: Box2D's rotation stamps (E-327) bound as the physics worker binds them, and each turning body's block of 64
 * slots stamped with the epoch before the publish, as Box2D's export stamps it; a revision without stamps ignores them.
 * `--readers r`: r worker threads read every published buffer whole, as pre-render and Pixi do, and the next frame
 * waits until all of them read it, so the buffer the publish writes was last read on other cores (their lines shared).
 * `--frames f` (default 1500) measured frames, after `--warm w` (default 1500) frames that are not timed.
 * `--post file`: the weedjsPost.js to load instead of this tree's (A/B against another revision: git show
 * <rev>:src/box2d/weedjsPost.js > file); its importScripts still load from this tree.
 * The checksum is then every slot of both buffers (bits) and the frame count: equal between revisions when the
 * published poses are.
 *
 *   node tests/bench/publishPoseMicrobench.mjs --variant base|runs [--n 16500] [--churn 0.1]
 *   node tests/bench/publishPoseMicrobench.mjs --n 57600 --occupancy 0.67 --runs 40 --shared --moving 0.5 --turning 64 --readers 2 [--respawn]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const box2dDir = path.join(repoRoot, 'src/box2d');

const PH1_EDITS = [
  [
    `for (let d = 0; d < n; d++) {
      const i = list[d];
      if (
        bodyGeneration &&
        seenBodyGeneration &&
        (seenBodyGeneration[i] | 0) !== (Atomics.load(bodyGeneration, i) | 0)
      ) {
        continue;
      }`,
    `const epoch = poseGenEpoch ? (Atomics.load(poseGenEpoch, 0) | 0) : 0;
    const epochSame = !poseGenEpoch || epoch === (seenPoseGenEpoch | 0);
    for (let d = 0; d < n; d++) {
      const i = list[d];
      if (
        !epochSame &&
        bodyGeneration &&
        seenBodyGeneration &&
        (seenBodyGeneration[i] | 0) !== (Atomics.load(bodyGeneration, i) | 0)
      ) {
        continue;
      }`,
  ],
  [
    'poseFrame++;',
    `if (poseGenEpoch) seenPoseGenEpoch = epoch;
    poseFrame++;`,
  ],
];

const RUNS_FROM = `    let skipped = 0;
    for (let d = 0; d < n; d++) {`;
const RUNS_TO = `    let skipped = 0;
    if (epochSame) {
      let d = 0;
      while (d < n) {
        const start = list[d];
        let end = d + 1;
        while (end < n && list[end] === start + (end - d)) end++;
        const len = end - d;
        if (len >= 16) {
          const stop = start + len;
          outX.set(x.subarray(start, stop), start);
          outY.set(y.subarray(start, stop), start);
          outC.set(rotC.subarray(start, stop), start);
          outS.set(rotS.subarray(start, stop), start);
        } else {
          for (let k = d; k < end; k++) {
            const i = list[k];
            outX[i] = x[i];
            outY[i] = y[i];
            outC[i] = rotC[i];
            outS[i] = rotS[i];
          }
        }
        d = end;
      }
    } else for (let d = 0; d < n; d++) {`;

const SLOTS_TO = `    let skipped = 0;
    if (epochSame && denseCount * 4 >= densePositions.length * 3) {
      const has = densePositions;
      const slots = has.length;
      let i = 0;
      while (i < slots) {
        while (i < slots && has[i] < 0) i++;
        const start = i;
        while (i < slots && has[i] >= 0) i++;
        const len = i - start;
        if (len >= 256) {
          outX.set(x.subarray(start, i), start);
          outY.set(y.subarray(start, i), start);
          outC.set(rotC.subarray(start, i), start);
          outS.set(rotS.subarray(start, i), start);
        } else {
          for (let k = start; k < i; k++) {
            outX[k] = x[k];
            outY[k] = y[k];
            outC[k] = rotC[k];
            outS[k] = rotS[k];
          }
        }
      }
    } else for (let d = 0; d < n; d++) {`;
const BIND_FROM = '    denseCount = state.denseCount | 0;\n';
const BIND_TO = '    denseCount = state.denseCount | 0;\n    if (state.densePositions) densePositions = state.densePositions;\n';

export function loadPost(variant, postFile = path.join(box2dDir, 'weedjsPost.js')) {
  let src = fs.readFileSync(postFile, 'utf8');
  if (!src.includes('state.densePositions') && src.split(BIND_FROM).length === 2) src = src.split(BIND_FROM).join(BIND_TO);
  if (variant === 'slots') {
    if (src.split(RUNS_FROM).length !== 2) throw new Error('slots anchor missing');
    src = src.split(RUNS_FROM).join(SLOTS_TO);
  } else if (variant === 'runs') {
    if (src.split(RUNS_FROM).length !== 2) throw new Error('runs anchor missing');
    src = src.split(RUNS_FROM).join(RUNS_TO);
  } else if (variant === 'ph1') {
    for (const [from, to] of PH1_EDITS) {
      if (!src.includes(from)) throw new Error(`ph1 anchor missing: ${from.slice(0, 80)}`);
      src = src.replace(from, to);
    }
  } else if (variant !== 'base') {
    throw new Error(`unknown variant ${variant}`);
  }
  const prev = {
    self: globalThis.self,
    importScripts: globalThis.importScripts,
  };
  globalThis.self = globalThis;
  globalThis.Module = globalThis.Module || {};
  globalThis.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(box2dDir, f), 'utf8');
      vm.runInThisContext(code, { filename: f });
    }
  };
  try {
    vm.runInThisContext(src, { filename: 'weedjsPost.js' });
  } finally {
    if (prev.importScripts === undefined) delete globalThis.importScripts;
    else globalThis.importScripts = prev.importScripts;
  }
  if (typeof globalThis.weedjsPublishPose !== 'function') {
    throw new Error('weedjsPublishPose was not installed');
  }
  return globalThis.weedjsPublishPose;
}

function setup(n, seed, churn = 0, holes = 0, shared = false, runs = 0, occupancy = 0.58, respawn = false, stamps = false) {
  const rng = mulberry32(seed);
  const list = new Int32Array(n);
  // --shared: every column on a SharedArrayBuffer, as the worker's are (Box2D's memory, the pose buffers).
  const f32 = (len) => (shared ? new Float32Array(new SharedArrayBuffer(len * 4)) : new Float32Array(len));
  const x = f32(n);
  const y = f32(n);
  const rotC = f32(n);
  const rotS = f32(n);
  const generation = new Int32Array(new SharedArrayBuffer(n * 4));
  const seen = new Int32Array(n);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < n; i++) {
    list[i] = i;
    x[i] = rng() * 10000;
    y[i] = rng() * 5000;
    rotC[i] = 1;
    rotS[i] = 0;
    const g = (rng() * 4) | 0;
    Atomics.store(generation, i, g);
    seen[i] = g;
  }
  // Despawns and respawns: a body leaves by swap-remove (the last entry takes its place) and comes back at the end.
  const moves = Math.round(n * churn);
  for (let m = 0; m < moves; m++) {
    const pos = (rng() * (n - 1)) | 0;
    const slot = list[pos];
    list[pos] = list[n - 1];
    list[n - 1] = slot;
  }
  // Removed for good: swap-remove, the slot left without a body.
  let count = n;
  const gone = Math.round(n * holes);
  for (let m = 0; m < gone && count > 1; m++) {
    const pos = (rng() * count) | 0;
    list[pos] = list[--count];
  }
  if (runs > 0) {
    // r runs of bodies, gaps between them; the dense list a shuffle of those slots.
    const bodies = Math.round(n * occupancy);
    const run = Math.max(1, Math.floor(bodies / runs));
    const gap = Math.floor((n - run * runs) / runs);
    count = 0;
    for (let r = 0; r < runs; r++) {
      const start = r * (run + gap);
      for (let k = 0; k < run && start + k < n; k++) list[count++] = start + k;
    }
    for (let k = count - 1; k > 0; k--) {
      const j = (rng() * (k + 1)) | 0;
      const t = list[k];
      list[k] = list[j];
      list[j] = t;
    }
  }
  const densePositions = new Int32Array(n).fill(-1);
  for (let d = 0; d < count; d++) densePositions[list[d]] = d;
  const poseSync = new Int32Array(new SharedArrayBuffer(8));
  const mk = () => ({
    x: f32(n),
    y: f32(n),
    rotC: f32(n),
    rotS: f32(n),
  });
  const poseBuffers = [mk(), mk()];
  // --stamps: Box2D's rotation stamps, a word per 64 slots (0: never stamped), and their epoch word (1 to start).
  const rotationStamps = stamps ? new Int32Array(new SharedArrayBuffer(((n + 63) >> 6) * 4)) : null;
  const rotationEpoch = stamps ? new Int32Array(new SharedArrayBuffer(4)) : null;
  if (rotationEpoch) rotationEpoch[0] = 1;
  globalThis.weedjsBindPoseBench({
    rotationStamps,
    rotationEpoch,
    rotationBlockShift: 6,
    poseSync,
    poseBuffers,
    denseList: list,
    denseCount: count,
    densePositions,
    views: { x, y, rotC, rotS },
    bodyGeneration: generation,
    seenBodyGeneration: seen,
    poseFrame: 0,
    poseGenEpoch: epoch,
    seenPoseGenEpoch: 0,
  });
  const bits = new Uint32Array(1);
  const bitsF = new Float32Array(bits.buffer);
  function mix(h, v) {
    bitsF[0] = v;
    return Math.imul(h ^ bits[0], 16777619) >>> 0;
  }
  function checksum() {
    globalThis.weedjsPublishPose();
    const buf = poseBuffers[(poseSync[0] - 1) & 1];
    let h = 2166136261;
    for (let i = 0; i < n; i += 17) {
      h = mix(h, buf.x[i]);
      h = mix(h, buf.y[i]);
      h = mix(h, buf.rotC[i]);
      h = mix(h, buf.rotS[i]);
    }
    return checksumInts([h, poseSync[0]], 2);
  }
  return {
    frame() {
      if (respawn) Atomics.add(epoch, 0, 1);
      globalThis.weedjsPublishPose();
    },
    checksum,
    n,
    list,
    count,
    views: { x, y, rotC, rotS },
    poseBuffers,
    poseSync,
    epoch,
    rotationStamps,
    rotationEpoch,
  };
}

// --readers: each reader waits for a published frame, reads that buffer whole (as pre-render and Pixi read the pose),
// then counts itself done in ack[0]. It stops after `frames` frames.
const READER_SOURCE = `
const { workerData } = require('node:worker_threads');
const { sync, ack, buffers, n, frames } = workerData;
const s = new Int32Array(sync);
const a = new Int32Array(ack);
const views = buffers.map((b) => b.map((sab) => new Float32Array(sab, 0, n)));
let seen = 0;
let sum = 0;
while (seen < frames) {
  Atomics.wait(s, 0, seen);
  seen = Atomics.load(s, 0);
  const [x, y, c, si] = views[(seen - 1) & 1];
  for (let i = 0; i < n; i++) sum += x[i] + y[i] + c[i] + si[i];
  Atomics.add(a, 0, 1);
  Atomics.notify(a, 0);
}
a[1 + (workerData.index | 0)] = sum === sum ? 1 : 2;
`;

/**
 * E-327: Predator-like frames. Before each publish the moving bodies move and the turning ones turn; the publish alone
 * is timed; with readers the next frame waits until every reader read the buffer just published.
 */
async function runFrames(k, { moving, turning, readers, warm, frames, respawn }) {
  const { n, list, count, views, poseBuffers, poseSync, epoch, rotationStamps, rotationEpoch } = k;
  const movers = [];
  if (moving > 0) {
    const stride = Math.max(1, Math.round(1 / moving));
    for (let d = 0; d < count; d += stride) movers.push(list[d]);
  }
  const turners = [];
  if (turning > 0) {
    const stride = Math.max(1, Math.floor(count / turning));
    for (let d = 0; d < count && turners.length < turning; d += stride) turners.push(list[d]);
  }
  const total = warm + frames;
  const ack = new Int32Array(new SharedArrayBuffer(4 * (1 + readers)));
  const workers = [];
  for (let r = 0; r < readers; r++) {
    workers.push(
      new Worker(READER_SOURCE, {
        eval: true,
        workerData: {
          sync: poseSync.buffer,
          ack: ack.buffer,
          buffers: poseBuffers.map((b) => [b.x.buffer, b.y.buffer, b.rotC.buffer, b.rotS.buffer]),
          n,
          frames: total,
          index: r,
        },
      }),
    );
  }
  const done = workers.map((w) => new Promise((resolve, reject) => {
    w.on('exit', resolve);
    w.on('error', reject);
  }));
  const times = new Float64Array(frames);
  for (let f = 1; f <= total; f++) {
    for (let m = 0; m < movers.length; m++) {
      const i = movers[m];
      views.x[i] += 0.5;
      views.y[i] -= 0.25;
    }
    for (let t = 0; t < turners.length; t++) {
      const i = turners[t];
      const angle = f * 0.01 + t;
      views.rotC[i] = Math.cos(angle);
      views.rotS[i] = Math.sin(angle);
      if (rotationStamps) rotationStamps[i >> 6] = rotationEpoch[0];
    }
    if (respawn) Atomics.add(epoch, 0, 1);
    const t0 = performance.now();
    globalThis.weedjsPublishPose();
    const t1 = performance.now();
    if (f > warm) times[f - warm - 1] = t1 - t0;
    if (readers > 0) {
      Atomics.notify(poseSync, 0);
      const want = f * readers;
      for (let got = Atomics.load(ack, 0); got < want; got = Atomics.load(ack, 0)) Atomics.wait(ack, 0, got, 50);
    }
  }
  await Promise.all(done);
  let sum = 0;
  for (let i = 0; i < frames; i++) sum += times[i];
  const sorted = Array.from(times).sort((p, q) => p - q);
  // Every slot of both buffers, bits, and the frames published.
  const words = [];
  for (const b of poseBuffers) {
    for (const col of [b.x, b.y, b.rotC, b.rotS]) words.push(checksumInts(new Uint32Array(col.buffer, col.byteOffset, n)));
  }
  words.push(poseSync[0]);
  const meanMs = sum / frames;
  return {
    checksum: checksumInts(words),
    meanUs: meanMs * 1000,
    medianUs: sorted[frames >> 1] * 1000,
    p90Us: sorted[Math.floor(frames * 0.9)] * 1000,
    opsPerSec: 1000 / meanMs,
    movers: movers.length,
    turners: turners.length,
  };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const n = Number(args.n ?? 16500);
  const seed = Number(args.seed ?? 0x0b2d);
  const churn = Number(args.churn ?? 0);
  const holes = Number(args.holes ?? 0);
  const shared = Boolean(args.shared);
  const runs = Number(args.runs ?? 0);
  const occupancy = Number(args.occupancy ?? 0.58);
  const post = args.post ? path.resolve(String(args.post)) : undefined;
  loadPost(variant, post);
  const respawn = Boolean(args.respawn);
  const moving = Number(args.moving ?? 0);
  const turning = Number(args.turning ?? 0);
  const readers = Number(args.readers ?? 0);
  if (moving > 0 || turning > 0 || readers > 0) {
    if (readers > 0 && !shared) throw new Error('--readers needs --shared (the readers see the columns through SharedArrayBuffers)');
    const k = setup(n, seed, churn, holes, shared, runs, occupancy, respawn, Boolean(args.stamps));
    const warm = Number(args.warm ?? 1500);
    const frames = Number(args.frames ?? 1500);
    const result = await runFrames(k, { moving, turning, readers, warm, frames, respawn });
    const label = `publish ${post ? path.basename(path.dirname(post)) + '/' : ''}${variant}${respawn ? ' respawn' : ''} n ${n}${runs ? ` runs ${runs} occupancy ${occupancy}` : ''} moving ${result.movers} turning ${result.turners} readers ${readers}${args.stamps ? ' stamps' : ''}`;
    const report = { feature: 'publish-pose-frames', variant, post: post ?? null, functions: ['publishPose'], n, seed, runs, occupancy, respawn, moving, turning, readers, warm, frames, ...result };
    if (args.output) writeReport(String(args.output), report);
    else console.log(`checksum ${result.checksum} ${label} mean ${result.meanUs.toFixed(1)} us median ${result.medianUs.toFixed(1)} p90 ${result.p90Us.toFixed(1)} ${result.opsPerSec.toFixed(0)} ops/s`);
    return;
  }
  const k = setup(n, seed, churn, holes, shared, runs, occupancy, respawn);
  const checksum = k.checksum();
  const cases = {
    publish: timeIt(`publishPose ${variant} (n=${n})`, () => k.frame(), { iterations: 40, warmup: 10 }),
  };
  const report = {
    feature: 'publish-pose',
    variant,
    functions: ['publishPose'],
    n,
    seed,
    churn,
    holes,
    checksum,
    note: 'Shipped weedjsPost publishPose. ph1 is an in-memory epoch fast-path. Gens match, so both publish every body.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} publish ${variant}${shared ? ' shared' : ''}${respawn ? ' respawn' : ''} churn ${churn} holes ${holes}${runs ? ` runs ${runs} occupancy ${occupancy}` : ''} ${cases.publish.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
