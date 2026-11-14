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
 *   node tests/bench/publishPoseMicrobench.mjs --variant base|runs [--n 16500] [--churn 0.1]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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

export function loadPost(variant) {
  let src = fs.readFileSync(path.join(box2dDir, 'weedjsPost.js'), 'utf8');
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

function setup(n, seed, churn = 0, holes = 0, shared = false, runs = 0, occupancy = 0.58, respawn = false) {
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
  globalThis.weedjsBindPoseBench({
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
  };
}

function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const n = Number(args.n ?? 16500);
  const seed = Number(args.seed ?? 0x0b2d);
  const churn = Number(args.churn ?? 0);
  const holes = Number(args.holes ?? 0);
  const shared = Boolean(args.shared);
  const runs = Number(args.runs ?? 0);
  const occupancy = Number(args.occupancy ?? 0.58);
  loadPost(variant);
  const respawn = Boolean(args.respawn);
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

if (isCli(import.meta.url)) main();
