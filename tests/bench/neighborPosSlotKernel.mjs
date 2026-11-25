#!/usr/bin/env node
/**
 * Kernel (E-346): a tick's scan of its neighbours' positions, from where. Today game code reads Transform.x[id] and
 * Transform.y[id]: two cache lines a neighbour, both rewritten by physics (another core) every frame. The spatial worker's
 * position slots hold x, y, half extent and a pad together ([x, y, half, 0] an entity, rewritten by spatial, another core
 * too): one line.
 *
 *   transform  x[id], y[id]
 *   pos        pos[id * 4], pos[id * 4 + 1]
 *   posType    pos, and the neighbour's type from the slot's pad (a scan that asks what each neighbour is)
 *   transformType  x[id], y[id] and Transform.entityType[id], as such a scan reads it today
 *
 * Two other threads rewrite the columns and the slots before each frame (not timed). One op is a frame: every scanner
 * (an eighth of the entities) walks its `--neighbors` ids and keeps the nearest. Neighbours in the world have unrelated ids:
 * the ids are random (--near: within 64 of the scanner's, the best case).
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/neighborPosSlotKernel.mjs --variants transform,pos --rounds 5
 *   node tests/bench/neighborPosSlotKernel.mjs [--variant pos] [--n 24000] [--neighbors 16] [--near] [--output path]
 */
import { Worker, isMainThread, workerData } from 'node:worker_threads';

import { isCli, mulberry32, parseArgs, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

if (!isMainThread) {
  const { sab, n, ctl, role } = workerData;
  const c = new Int32Array(ctl);
  const x = new Float32Array(sab, 0, n);
  const y = new Float32Array(sab, n * 4, n);
  const pos = new Float32Array(sab, n * 8, n * 4);
  for (let f = 1; ; f++) {
    Atomics.wait(c, 0, f - 1);
    if (Atomics.load(c, 3) !== 0) break;
    if (role === 1) {
      for (let i = 0; i < n; i++) {
        x[i] = x[i] + 0.25 - ((f & 1) ? 0.5 : 0);
        y[i] = y[i] - 0.25 + ((f & 1) ? 0.5 : 0);
      }
    } else {
      // The type stays in the pad: the slot's other words are rewritten.
      while (Atomics.load(c, 1) < f) Atomics.wait(c, 1, f - 1);
      for (let i = 0; i < n; i++) {
        pos[i * 4] = x[i];
        pos[i * 4 + 1] = y[i];
        pos[i * 4 + 2] = 4;
      }
    }
    Atomics.store(c, role, f);
    Atomics.notify(c, role);
  }
}

function scanTransform(ids, from, count, self, x, y) {
  const sx = x[self];
  const sy = y[self];
  let best = -1;
  let bestD = 1e30;
  for (let k = from; k < from + count; k++) {
    const j = ids[k];
    const dx = x[j] - sx;
    const dy = y[j] - sy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

function scanPos(ids, from, count, self, pos) {
  const sx = pos[self * 4];
  const sy = pos[self * 4 + 1];
  let best = -1;
  let bestD = 1e30;
  for (let k = from; k < from + count; k++) {
    const j = ids[k];
    const at = j << 2;
    const dx = pos[at] - sx;
    const dy = pos[at + 1] - sy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

function scanTransformType(ids, from, count, self, x, y, type) {
  const sx = x[self];
  const sy = y[self];
  let best = -1;
  let bestD = 1e30;
  for (let k = from; k < from + count; k++) {
    const j = ids[k];
    if (type[j] !== 1) continue;
    const dx = x[j] - sx;
    const dy = y[j] - sy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

function scanPosType(ids, from, count, self, pos) {
  const sx = pos[self * 4];
  const sy = pos[self * 4 + 1];
  let best = -1;
  let bestD = 1e30;
  for (let k = from; k < from + count; k++) {
    const j = ids[k];
    const at = j << 2;
    if (pos[at + 3] !== 1) continue;
    const dx = pos[at] - sx;
    const dy = pos[at + 1] - sy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant ?? 'transform');
  if (!['transform', 'pos', 'transformType', 'posType'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const n = Number(args.n ?? 24000);
  const neighbors = Number(args.neighbors ?? 16);
  const near = Boolean(args.near);
  const sab = new SharedArrayBuffer(n * 8 + n * 16);
  const x = new Float32Array(sab, 0, n);
  const y = new Float32Array(sab, n * 4, n);
  const pos = new Float32Array(sab, n * 8, n * 4);
  const type = new Uint8Array(new SharedArrayBuffer(n));
  const rng = mulberry32(0x346);
  for (let i = 0; i < n; i++) {
    x[i] = Math.round(rng() * 4000);
    y[i] = Math.round(rng() * 4000);
    type[i] = (i % 4) === 1 ? 1 : 2;
    pos.set([x[i], y[i], 4, type[i]], i * 4);
  }
  const scanners = n >> 3;
  const ids = new Uint32Array(scanners * neighbors);
  for (let s = 0; s < scanners; s++) {
    for (let k = 0; k < neighbors; k++) {
      const self = s * 8;
      ids[s * neighbors + k] = near ? Math.max(0, Math.min(n - 1, self - 32 + ((rng() * 64) | 0))) : (rng() * n) | 0;
    }
  }
  const run = (from, to) => {
    let h = 0;
    for (let s = from; s < to; s++) {
      const at = s * neighbors;
      const self = s * 8;
      const best = variant === 'transform' ? scanTransform(ids, at, neighbors, self, x, y)
        : variant === 'pos' ? scanPos(ids, at, neighbors, self, pos)
          : variant === 'transformType' ? scanTransformType(ids, at, neighbors, self, x, y, type) : scanPosType(ids, at, neighbors, self, pos);
      h = (Math.imul(h, 31) + best) | 0;
    }
    return h >>> 0;
  };
  warmNormalCompile(() => run(0, 32));
  const ctl = new SharedArrayBuffer(16);
  const c = new Int32Array(ctl);
  const peers = [1, 2].map((role) => new Worker(new URL(import.meta.url), { workerData: { sab, n, ctl, role } }));
  const samples = [];
  let checksum = 2166136261;
  for (let f = 1; f <= 1200; f++) {
    Atomics.store(c, 0, f);
    Atomics.notify(c, 0);
    for (const role of [1, 2]) while (Atomics.load(c, role) !== f) Atomics.wait(c, role, f - 1);
    const t0 = performance.now();
    const h = run(0, scanners);
    const t = performance.now() - t0;
    if (f > 200) samples.push(t);
    if (f <= 8) checksum = Math.imul(checksum ^ h, 16777619) >>> 0;
  }
  Atomics.store(c, 3, 1);
  Atomics.add(c, 0, 1);
  Atomics.notify(c, 0);
  await Promise.all(peers.map((p) => p.terminate()));
  const meanMs = samples.reduce((s, v) => s + v, 0) / samples.length;
  const reads = scanners * neighbors;
  const report = { feature: 'neighbor-pos-slot', variant, n, neighbors, near, checksum, cases: { frame: { opsPerSec: 1000 / meanMs, nsPerNeighbor: (1e6 * meanMs) / reads } } };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`${variant}${near ? ' near' : ''}: ${((1e6 * meanMs) / reads).toFixed(2)} ns a neighbour, ${meanMs.toFixed(3)} ms a frame (${reads} reads, checksum ${checksum})`);
}

if (isMainThread && isCli(import.meta.url)) await main();
