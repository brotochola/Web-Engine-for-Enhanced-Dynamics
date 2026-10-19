#!/usr/bin/env node
/**
 * E-15 kernel. Strided neighbor rows against a packed row plus an offset index,
 * in one sitting, at Predator's maxNeighbors (1024, stride 1025, 17 556 entities).
 *
 * Both sides hold the same neighbor ids. The strided buffer is the shipped
 * layout: count at entity * stride, then `count` ids. The packed side is an
 * offset table, a count table, and one contiguous id array. Uniform count of
 * 32 is a stated load, not a measured Predator mean. The point of 32 is that
 * a row still starts 2050 bytes after the previous one, so the stride is the
 * thing being timed, not a full 1024-wide payload.
 *
 *   node tests/bench/e15NeighborLayoutMicrobench.mjs
 */
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const ENTITIES = 17556;
const STRIDE = 1025;
const COUNT = 32;

function build() {
  const strided = new Uint16Array(ENTITIES * STRIDE);
  const packed = new Uint16Array(ENTITIES * COUNT);
  const offsets = new Uint32Array(ENTITIES);
  const counts = new Uint32Array(ENTITIES);
  let p = 0;
  for (let e = 0; e < ENTITIES; e++) {
    strided[e * STRIDE] = COUNT;
    offsets[e] = p;
    counts[e] = COUNT;
    for (let k = 0; k < COUNT; k++) {
      const id = (e * 17 + k * 3) & 0xffff;
      strided[e * STRIDE + 1 + k] = id;
      packed[p++] = id;
    }
  }
  return { strided, packed, offsets, counts };
}

function readStrided(strided) {
  let sum = 0;
  for (let e = 0; e < ENTITIES; e++) {
    const base = e * STRIDE;
    const n = strided[base];
    for (let k = 0; k < n; k++) sum += strided[base + 1 + k];
  }
  return sum;
}

function readPacked(packed, offsets, counts) {
  let sum = 0;
  for (let e = 0; e < ENTITIES; e++) {
    const base = offsets[e];
    const n = counts[e];
    for (let k = 0; k < n; k++) sum += packed[base + k];
  }
  return sum;
}

function runCase(mode) {
  const data = build();
  const fn = mode === 'strided'
    ? () => readStrided(data.strided)
    : () => readPacked(data.packed, data.offsets, data.counts);
  const checksum = fn() >>> 0;
  const result = timeIt(`e15 ${mode}`, fn, { iterations: 8, warmup: 2 });
  return {
    checksum,
    msPerPass: result.ms / result.iterations,
    opsPerSec: result.opsPerSec,
    sampleMs: result.ms,
    iterations: result.iterations,
  };
}

async function main() {
  const args = parseArgs();
  const { Worker } = await import('node:worker_threads');
  const cases = {};
  for (const mode of ['strided', 'packed']) {
    cases[mode] = await new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { role: 'case', mode } });
      w.once('message', resolve);
      w.once('error', reject);
    });
  }
  if (cases.strided.checksum !== cases.packed.checksum) {
    throw new Error(`checksum ${cases.strided.checksum} != ${cases.packed.checksum}`);
  }
  const report = {
    feature: 'e15-neighbor-layout',
    entities: ENTITIES,
    stride: STRIDE,
    neighborsPerEntity: COUNT,
    stridedBytes: ENTITIES * STRIDE * 2,
    packedPayloadBytes: ENTITIES * COUNT * 2,
    indexBytes: ENTITIES * 4 * 2,
    seed: 'uniform count 32, id = (entity * 17 + k * 3) & 0xffff',
    checksum: cases.strided.checksum,
    cases,
    packedOverStrided: cases.strided.msPerPass > 0 ? cases.packed.msPerPass / cases.strided.msPerPass : null,
  };
  if (args.output) writeReport(String(args.output), report);
  console.log(JSON.stringify({
    checksum: report.checksum,
    stridedMs: Number(cases.strided.msPerPass.toFixed(4)),
    packedMs: Number(cases.packed.msPerPass.toFixed(4)),
    packedOverStrided: report.packedOverStrided,
    stridedBytes: report.stridedBytes,
    packedPayloadBytes: report.packedPayloadBytes,
    indexBytes: report.indexBytes,
  }, null, 2));
}

const { isMainThread, workerData, parentPort } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'case') {
  parentPort.postMessage(runCase(workerData.mode));
} else if (isCli(import.meta.url)) await main();
