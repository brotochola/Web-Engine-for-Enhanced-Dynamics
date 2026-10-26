import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { generateSymmetricalCirclePattern } from '../../src/util/utils.js';
import { layoutRegions, spatialPatternTableBytes, spatialPublishRegionList } from '../../src/util/wasmMemoryMap.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';

// E-76 T8 and L1: every shipped kernel module, plus two test modules, in several workers at once
// on one shared memory (REVIEW_PLAN N-62: modules that owned statics or a stack would collide).
// Every byte starts as a canary. One thread first runs each worker's jobs in its order, as many
// times as the workers will: on the first pass each job may change only its own region. Then four
// workers run all their jobs at the same time, the same number of times: the memory must end byte
// for byte as the solo run left it.

const ROLES = ['spatial0', 'spatial1', 'logic0', 'particle'];
const COUNT = 2048;
const MAX_N = 31;
const SCALE_N = 1003;
const IDS_N = 4099;
const ITERATIONS = 200;
const binCount = (w) => 17 + w * 13;
// The gather's grid: 600 × 600 world, 64-unit cells, up to 64 entities a cell.
const CELL = 64;
const GRID_W = 10;
const GRID_H = 10;
const PER_CELL = 64;
const CELL_BYTES = 4 + PER_CELL * 2;
const MAX_CELL_RADIUS = 12;

const MODULES = [
  { name: 'spatialPublish', file: '../../src/wasm/engine.wasm', exports: ['publish_batch'] },
  { name: 'spatialGather', file: '../../src/wasm/engine.wasm', exports: ['gather_batch'] },
  { name: 'coexistScale', file: '../fixtures/wasm/coexistScale.wasm', exports: ['scale_f32'] },
  { name: 'coexistHistogram', file: '../fixtures/wasm/coexistHistogram.wasm', exports: ['histogram_u16'] },
].map((m) => ({ name: m.name, exports: m.exports, url: new URL(m.file, import.meta.url).href }));

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildMemory() {
  const spatial = spatialPublishRegionList(COUNT, MAX_N, ROLES.length, {
    gridBytes: GRID_W * GRID_H * CELL_BYTES,
    patternBytes: spatialPatternTableBytes(MAX_CELL_RADIUS),
  });
  const layout = layoutRegions([
    ...spatial.regions,
    { name: 'scaleIn', owner: 'test', bytes: SCALE_N * 4 },
    ...ROLES.map((role, w) => ({ name: `scaleOut${w}`, owner: role, bytes: SCALE_N * 4 })),
    { name: 'ids', owner: 'test', bytes: IDS_N * 2 },
    ...ROLES.map((role, w) => ({ name: `bins${w}`, owner: role, bytes: binCount(w) * 4 })),
    { name: 'tail', owner: 'none', bytes: 64 },
  ]);
  const R = layout.regions;
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const bytes = new Uint8Array(memory.buffer);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 167 + 13) & 0xff;

  const b = memory.buffer;
  const rnd = lcg(7);
  const stride = 1 + MAX_N;
  const pos = new Float32Array(b, R.pos.byte, COUNT * 4);
  const range = new Float32Array(b, R.range.byte, COUNT);
  for (let e = 0; e < COUNT; e++) {
    pos[e * 4] = rnd() * 600;
    pos[e * 4 + 1] = rnd() * 600;
    pos[e * 4 + 2] = rnd() * 8;
    pos[e * 4 + 3] = 0;
    range[e] = 30 + rnd() * 60;
  }
  // The grid: each entity in its home cell, as rebuildOwnedRows bins it.
  const gridCounts = new Uint8Array(b, R.grid.byte, GRID_W * GRID_H * CELL_BYTES);
  const gridIds = new Uint16Array(b, R.grid.byte, (GRID_W * GRID_H * CELL_BYTES) >> 1);
  for (let c = 0; c < GRID_W * GRID_H; c++) gridCounts[c * CELL_BYTES] = 0;
  for (let e = 0; e < COUNT; e++) {
    const cell = ((pos[e * 4 + 1] / CELL) | 0) * GRID_W + ((pos[e * 4] / CELL) | 0);
    const n = gridCounts[cell * CELL_BYTES];
    if (n < PER_CELL) {
      gridIds[(cell * CELL_BYTES) / 2 + 2 + n] = e;
      gridCounts[cell * CELL_BYTES] = n + 1;
    }
  }
  // The circle patterns, as bindSpatialGather lays out its table.
  const patterns = [];
  for (let r = 0; r <= MAX_CELL_RADIUS; r++) patterns.push(generateSymmetricalCirclePattern(r, CELL));
  const pairs = patterns.reduce((s, p) => s + (p.length >> 1), 0);
  const patternIndexByte = R.patterns.byte + Math.ceil((pairs * 8) / 64) * 64;
  const table = new Int32Array(b, R.patterns.byte, pairs * 2);
  const index = new Int32Array(b, patternIndexByte, (MAX_CELL_RADIUS + 1) * 2);
  for (let r = 0, at = 0; r <= MAX_CELL_RADIUS; at += patterns[r].length, r++) {
    index[r * 2] = at >> 1;
    index[r * 2 + 1] = patterns[r].length >> 1;
    table.set(patterns[r], at);
  }
  // Worker w gathers and publishes the entities e with e % 8 == w or e % 8 == w + 4; e % 8 == 3
  // and 7 stay unlisted, so their candidate and neighbour rows must keep their canaries.
  const listOf = [];
  for (let w = 0; w < ROLES.length; w++) {
    const ids = [];
    for (let e = 0; e < COUNT; e++) if ((e % 8 === w || e % 8 === w + 4) && e % 4 !== 3) ids.push(e);
    new Uint16Array(b, R.lists.byte + w * spatial.listStride, ids.length).set(ids);
    new Uint16Array(b, R.rebuilds.byte + w * spatial.rebuildStride, ids.length).set(ids);
    listOf.push(ids);
  }
  const scaleIn = new Float32Array(b, R.scaleIn.byte, SCALE_N);
  for (let i = 0; i < SCALE_N; i++) scaleIn[i] = rnd() * 200 - 100;
  const ids = new Uint16Array(b, R.ids.byte, IDS_N);
  for (let i = 0; i < IDS_N; i++) ids[i] = (rnd() * 65536) | 0;

  // Each job with the bytes it may write.
  const only = (ranges) => {
    const mask = new Uint8Array(bytes.length);
    for (const [from, to] of ranges) mask.fill(1, from, to);
    return mask;
  };
  const slice = (name, w, strideBytes) => [[R[name].byte + w * strideBytes, R[name].byte + (w + 1) * strideBytes]];
  const jobs = ROLES.map((_, w) => {
    const rowsOf = (base) => listOf[w].map((e) => [base + e * stride * 2, base + (e + 1) * stride * 2]);
    const out = (name) => [[R[name].byte, R[name].byte + R[name].bytes]];
    const markerByte = R.markers.byte + w * spatial.markerStride;
    const truncatedByte = R.truncated.byte + w * spatial.truncatedStride;
    return [
      {
        module: 'spatialGather',
        fn: 'gather_batch',
        args: [
          listOf[w].length, R.rebuilds.byte + w * spatial.rebuildStride, R.pos.byte, R.range.byte, R.cand.byte, MAX_N,
          R.grid.byte, CELL_BYTES, CELL_BYTES / 2, 2, GRID_W, GRID_H, 1 / CELL, 0.04, MAX_CELL_RADIUS,
          R.patterns.byte, patternIndexByte, markerByte, 0, truncatedByte,
        ],
        // The dedup stamp: a new frame on every pass, as the worker's frame counter advances.
        stampArg: 18,
        writes: only([...rowsOf(R.cand.byte), ...slice('markers', w, spatial.markerStride), ...slice('truncated', w, spatial.truncatedStride)]),
      },
      { module: 'spatialPublish', fn: 'publish_batch', args: [listOf[w].length, MAX_N, R.pos.byte, R.range.byte, R.cand.byte, R.rows.byte, R.lists.byte + w * spatial.listStride], writes: only(rowsOf(R.rows.byte)) },
      { module: 'coexistScale', fn: 'scale_f32', args: [R.scaleIn.byte, R[`scaleOut${w}`].byte, SCALE_N, 1.5 + w, -w], writes: only(out(`scaleOut${w}`)) },
      { module: 'coexistHistogram', fn: 'histogram_u16', args: [R.ids.byte, IDS_N, R[`bins${w}`].byte, binCount(w)], writes: only(out(`bins${w}`)) },
    ];
  });
  return { memory, R, jobs, stride };
}

function firstDifference(a, b, mask = null) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && (!mask || !mask[i])) return i;
  return -1;
}

function runWorker(memory, gate, jobs) {
  const worker = new Worker(new URL('../helpers/wasmCoexistWorker.mjs', import.meta.url), {
    workerData: { memory, gate, modules: MODULES, jobs, iterations: ITERATIONS },
  });
  const ready = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const done = ready.then(
    () =>
      new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      }),
  );
  return { worker, ready, done };
}

test('kernel modules in four workers at once write only their own regions', async () => {
  const { memory, R, jobs, stride } = buildMemory();

  // Solo: this thread runs each worker's jobs, pass after pass, on a copy of the memory.
  const pages = memory.buffer.byteLength / 65536;
  const solo = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const soloBytes = new Uint8Array(solo.buffer);
  soloBytes.set(new Uint8Array(memory.buffer));
  const kernels = {};
  for (const m of MODULES) kernels[m.name] = await loadWasmKernel(m.name, m.url, solo, m.exports);
  for (let w = 0; w < jobs.length; w++) {
    for (let i = 0; i < ITERATIONS; i++) {
      for (const job of jobs[w]) {
        if (job.stampArg !== undefined) job.args[job.stampArg] = i + 1;
        const prior = i === 0 ? soloBytes.slice() : null;
        kernels[job.module][job.fn](...job.args);
        if (prior) {
          const outside = firstDifference(prior, soloBytes, job.writes);
          assert.equal(outside, -1, `${ROLES[w]} ${job.fn} wrote outside its region, at byte ${outside}`);
        }
      }
    }
  }
  const expected = soloBytes.slice();
  const cand = new Uint16Array(solo.buffer, R.cand.byte, COUNT * stride);
  const rows = new Uint16Array(solo.buffer, R.rows.byte, COUNT * stride);
  let gathered = 0;
  let published = 0;
  for (let e = 0; e < COUNT; e++) {
    if (e % 4 === 3) continue;
    gathered += cand[e * stride];
    published += rows[e * stride];
  }
  assert.ok(gathered > 0, 'candidates were gathered');
  assert.ok(published > 0 && published <= gathered, 'neighbours were published from them');
  for (let w = 0; w < ROLES.length; w++) {
    const bins = new Uint32Array(solo.buffer, R[`bins${w}`].byte, binCount(w));
    assert.equal(bins.reduce((s, v) => s + v, 0), IDS_N, `bins of worker ${w} count every id`);
  }

  // Together: four workers, every module in each, all running at once.
  const gate = new SharedArrayBuffer(4);
  const runs = jobs.map((list) => runWorker(memory, gate, list.map(({ writes, ...job }) => job)));
  try {
    await Promise.all(runs.map((r) => r.ready));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await Promise.all(runs.map((r) => r.done));
  } finally {
    await Promise.all(runs.map((r) => r.worker.terminate()));
  }
  const after = new Uint8Array(memory.buffer);
  const diff = firstDifference(after, expected);
  assert.equal(diff, -1, `the concurrent run differs from the solo run at byte ${diff}`);
});
