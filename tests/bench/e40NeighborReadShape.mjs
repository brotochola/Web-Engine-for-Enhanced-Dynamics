#!/usr/bin/env node
/**
 * E-15 sitting 2. The 2026-10-18 kernel scanned every entity in id order.
 * Predator does not. One row is already contiguous; the stride is the gap
 * before the next entity. This times the reads the frame actually does.
 *
 *   node tests/bench/e40NeighborReadShape.mjs
 *
 * Bar, named in EXECUTION_PLAN before this file existed: shape "body" must
 * be at least 0.15 ms/pass cheaper packed (3 % of logic0 at 4.85 ms).
 */
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const ENTITIES = 17556;
const STRIDE = 1025;
const COUNT = 32;
const TICK_INTERVAL = 4;
const LIGHTS = 64;
const SEED = 0xe15a4019;

function build() {
  const strided = new Uint16Array(ENTITIES * STRIDE);
  const packed = new Uint16Array(ENTITIES * COUNT);
  const offsets = new Uint32Array(ENTITIES);
  const counts = new Uint32Array(ENTITIES);
  const x = new Float32Array(ENTITIES);
  const y = new Float32Array(ENTITIES);
  let p = 0;
  for (let e = 0; e < ENTITIES; e++) {
    strided[e * STRIDE] = COUNT;
    offsets[e] = p;
    counts[e] = COUNT;
    x[e] = e * 0.25;
    y[e] = e * 0.125;
    for (let k = 0; k < COUNT; k++) {
      const id = (e * 17 + k * 3) & 0xffff;
      strided[e * STRIDE + 1 + k] = id;
      packed[p++] = id;
    }
  }
  return { strided, packed, offsets, counts, x, y };
}

function logicIds() {
  const phase = [];
  for (let id = 0; id < ENTITIES; id++) {
    if ((id % TICK_INTERVAL) === 0) phase.push(id);
  }
  const mine = [];
  for (let i = 0; i < phase.length; i += 2) mine.push(phase[i]);
  return mine;
}

function shuffle(ids) {
  const out = ids.slice();
  const rand = mulberry32(SEED);
  for (let i = out.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function lightIds() {
  const ids = new Array(LIGHTS);
  const step = (ENTITIES / LIGHTS) | 0;
  for (let i = 0; i < LIGHTS; i++) ids[i] = i * step;
  return ids;
}

function lists() {
  const logic = logicIds();
  return {
    dense: null,
    logicOrder: logic,
    logicShuffled: shuffle(logic),
    body: logic,
    bodyShuffled: shuffle(logic),
    lights: lightIds(),
  };
}

function sumStrided(strided, ids) {
  let sum = 0;
  if (ids) {
    for (let i = 0; i < ids.length; i++) {
      const base = ids[i] * STRIDE;
      const n = strided[base];
      for (let k = 0; k < n; k++) sum += strided[base + 1 + k];
    }
  } else {
    for (let e = 0; e < ENTITIES; e++) {
      const base = e * STRIDE;
      const n = strided[base];
      for (let k = 0; k < n; k++) sum += strided[base + 1 + k];
    }
  }
  return sum;
}

function sumPacked(packed, offsets, counts, ids) {
  let sum = 0;
  if (ids) {
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i];
      const base = offsets[e];
      const n = counts[e];
      for (let k = 0; k < n; k++) sum += packed[base + k];
    }
  } else {
    for (let e = 0; e < ENTITIES; e++) {
      const base = offsets[e];
      const n = counts[e];
      for (let k = 0; k < n; k++) sum += packed[base + k];
    }
  }
  return sum;
}

function bodyStrided(strided, x, y, ids) {
  let sum = 0;
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < ids.length; i++) {
    const base = ids[i] * STRIDE;
    const n = strided[base];
    for (let k = 0; k < n; k++) {
      const id = strided[base + 1 + k];
      sum += id;
      ax += x[id];
      ay += y[id];
    }
  }
  return (sum + (ax + ay)) | 0;
}

function bodyPacked(packed, offsets, counts, x, y, ids) {
  let sum = 0;
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < ids.length; i++) {
    const e = ids[i];
    const base = offsets[e];
    const n = counts[e];
    for (let k = 0; k < n; k++) {
      const id = packed[base + k];
      sum += id;
      ax += x[id];
      ay += y[id];
    }
  }
  return (sum + (ax + ay)) | 0;
}

function runCase(shape, layout) {
  const data = build();
  const ids = lists()[shape];
  let sink = 0;
  let fn;
  let checksum;
  if (shape === 'body' || shape === 'bodyShuffled') {
    fn = layout === 'strided'
      ? () => { sink = bodyStrided(data.strided, data.x, data.y, ids); }
      : () => { sink = bodyPacked(data.packed, data.offsets, data.counts, data.x, data.y, ids); };
    checksum = layout === 'strided'
      ? bodyStrided(data.strided, data.x, data.y, ids) >>> 0
      : bodyPacked(data.packed, data.offsets, data.counts, data.x, data.y, ids) >>> 0;
  } else if (layout === 'strided') {
    fn = () => { sink = sumStrided(data.strided, ids); };
    checksum = sumStrided(data.strided, ids) >>> 0;
  } else {
    fn = () => { sink = sumPacked(data.packed, data.offsets, data.counts, ids); };
    checksum = sumPacked(data.packed, data.offsets, data.counts, ids) >>> 0;
  }
  const result = timeIt(`e40 ${shape} ${layout}`, fn, { iterations: 4, warmup: 1 });
  return {
    checksum,
    sink,
    ids: ids ? ids.length : ENTITIES,
    msPerPass: result.ms / result.iterations,
    opsPerSec: result.opsPerSec,
    sampleMs: result.ms,
    iterations: result.iterations,
  };
}

async function main() {
  const args = parseArgs();
  const { Worker } = await import('node:worker_threads');
  const shapes = ['dense', 'logicOrder', 'logicShuffled', 'body', 'bodyShuffled', 'lights'];
  const cases = {};
  for (const shape of shapes) {
    cases[shape] = {};
    for (const layout of ['strided', 'packed']) {
      cases[shape][layout] = await new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), {
          workerData: { role: 'case', shape, layout },
        });
        w.once('message', resolve);
        w.once('error', reject);
      });
    }
    if (cases[shape].strided.checksum !== cases[shape].packed.checksum) {
      throw new Error(
        `${shape} checksum ${cases[shape].strided.checksum} != ${cases[shape].packed.checksum}`,
      );
    }
  }
  const summary = {};
  for (const shape of shapes) {
    const s = cases[shape].strided.msPerPass;
    const p = cases[shape].packed.msPerPass;
    summary[shape] = {
      ids: cases[shape].strided.ids,
      stridedMs: s,
      packedMs: p,
      deltaMs: s - p,
    };
  }
  const report = {
    feature: 'e15-live-read-shape',
    barMs: 0.15,
    entities: ENTITIES,
    stride: STRIDE,
    neighborsPerEntity: COUNT,
    tickInterval: TICK_INTERVAL,
    lights: LIGHTS,
    seed: SEED,
    note: 'body delta under 0.15 ms closes E-15. No wasm edit.',
    summary,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  const printed = {};
  for (const shape of shapes) {
    printed[shape] = {
      ids: summary[shape].ids,
      stridedMs: Number(summary[shape].stridedMs.toFixed(4)),
      packedMs: Number(summary[shape].packedMs.toFixed(4)),
      deltaMs: Number(summary[shape].deltaMs.toFixed(4)),
    };
  }
  console.log(JSON.stringify(printed, null, 2));
}

const { isMainThread, workerData, parentPort } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'case') {
  parentPort.postMessage(runCase(workerData.shape, workerData.layout));
} else if (isCli(import.meta.url)) await main();
