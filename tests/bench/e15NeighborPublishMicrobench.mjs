#!/usr/bin/env node
/**
 * E-15 write side. The read kernel was 3.57× for the packed layout. This times
 * the publish: strided rows written with no join, against a count pass, a
 * prefix sum, and a packed scatter. Same ids, Predator entity count, stride
 * 1025, 32 neighbors. One thread. The prefix sum is the join two spatial
 * workers would have to agree on.
 *
 *   node tests/bench/e15NeighborPublishMicrobench.mjs
 */
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const ENTITIES = 17556;
const STRIDE = 1025;
const COUNT = 32;

function buildIds() {
  const ids = new Uint16Array(ENTITIES * COUNT);
  for (let e = 0; e < ENTITIES; e++) {
    for (let k = 0; k < COUNT; k++) ids[e * COUNT + k] = (e * 17 + k * 3) & 0xffff;
  }
  return ids;
}

function publishStrided(ids, strided) {
  for (let e = 0; e < ENTITIES; e++) {
    const base = e * STRIDE;
    const src = e * COUNT;
    for (let k = 0; k < COUNT; k++) strided[base + 1 + k] = ids[src + k];
    strided[base] = COUNT;
  }
  return strided[0];
}

function publishPacked(ids, counts, offsets, packed) {
  for (let e = 0; e < ENTITIES; e++) counts[e] = COUNT;
  let p = 0;
  for (let e = 0; e < ENTITIES; e++) {
    offsets[e] = p;
    p += counts[e];
  }
  for (let e = 0; e < ENTITIES; e++) {
    const dst = offsets[e];
    const src = e * COUNT;
    for (let k = 0; k < COUNT; k++) packed[dst + k] = ids[src + k];
  }
  return packed[0];
}

function checksumStrided(strided) {
  let sum = 0;
  for (let e = 0; e < ENTITIES; e++) {
    const base = e * STRIDE;
    const n = strided[base];
    for (let k = 0; k < n; k++) sum = (sum + strided[base + 1 + k]) >>> 0;
  }
  return sum;
}

function checksumPacked(packed, offsets, counts) {
  let sum = 0;
  for (let e = 0; e < ENTITIES; e++) {
    const base = offsets[e];
    const n = counts[e];
    for (let k = 0; k < n; k++) sum = (sum + packed[base + k]) >>> 0;
  }
  return sum;
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
    feature: 'e15-neighbor-publish',
    entities: ENTITIES,
    stride: STRIDE,
    neighborsPerEntity: COUNT,
    checksum: cases.strided.checksum,
    cases,
    packedOverStrided: cases.packed.msPerPass / cases.strided.msPerPass,
  };
  if (args.output) writeReport(String(args.output), report);
  console.log(JSON.stringify({
    checksum: report.checksum,
    stridedMs: Number(cases.strided.msPerPass.toFixed(4)),
    packedMs: Number(cases.packed.msPerPass.toFixed(4)),
    packedOverStrided: report.packedOverStrided,
  }, null, 2));
}

function runCase(mode) {
  const ids = buildIds();
  let checksum = 0;
  let fn;
  if (mode === 'strided') {
    const strided = new Uint16Array(ENTITIES * STRIDE);
    fn = () => publishStrided(ids, strided);
    fn();
    checksum = checksumStrided(strided);
  } else {
    const counts = new Uint32Array(ENTITIES);
    const offsets = new Uint32Array(ENTITIES);
    const packed = new Uint16Array(ENTITIES * COUNT);
    fn = () => publishPacked(ids, counts, offsets, packed);
    fn();
    checksum = checksumPacked(packed, offsets, counts);
  }
  const result = timeIt(`e15 publish ${mode}`, fn, { iterations: 8, warmup: 2 });
  return {
    checksum,
    msPerPass: result.ms / result.iterations,
    opsPerSec: result.opsPerSec,
    sampleMs: result.ms,
    iterations: result.iterations,
  };
}

const { isMainThread, workerData, parentPort } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'case') {
  parentPort.postMessage(runCase(workerData.mode));
} else if (isCli(import.meta.url)) await main();
