import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { layoutRegions, spatialPublishRegionList } from '../../src/util/wasmMemoryMap.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';

// E-76 T8: several kernel modules, in several workers at once, on one shared memory (REVIEW_PLAN
// N-62: modules that owned statics or a stack would collide). Every byte starts as a canary. One
// thread runs every job alone first, one at a time: each may change only its own output region.
// Then four workers run all their jobs at the same time, 200 times each: the memory must end byte
// for byte as the solo run left it.

const ROLES = ['spatial0', 'spatial1', 'logic0', 'particle'];
const COUNT = 2048;
const MAX_N = 31;
const CAND = 24;
const SCALE_N = 1003;
const IDS_N = 4099;
const ITERATIONS = 200;
const binCount = (w) => 17 + w * 13;

const MODULES = [
  { name: 'spatialPublish', file: '../../src/workers/spatialPublish.wasm', exports: ['publish_batch'] },
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
  const { regions: spatial, listStride } = spatialPublishRegionList(COUNT, MAX_N, ROLES.length);
  const layout = layoutRegions([
    ...spatial,
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
  const cand = new Uint16Array(b, R.cand.byte, COUNT * stride);
  for (let e = 0; e < COUNT; e++) {
    pos[e * 4] = rnd() * 600;
    pos[e * 4 + 1] = rnd() * 600;
    pos[e * 4 + 2] = rnd() * 8;
    pos[e * 4 + 3] = 0;
    range[e] = 30 + rnd() * 60;
    cand[e * stride] = CAND;
    for (let i = 0; i < CAND; i++) cand[e * stride + 1 + i] = (rnd() * COUNT) | 0;
  }
  // Worker w publishes the entities e with e % 8 == w or e % 8 == w + 4; e % 8 == 3 and 7 stay
  // unlisted, so their rows must keep their canaries.
  const listOf = [];
  const lists = [];
  for (let w = 0; w < ROLES.length; w++) {
    const ids = [];
    for (let e = 0; e < COUNT; e++) if ((e % 8 === w || e % 8 === w + 4) && e % 4 !== 3) ids.push(e);
    new Uint16Array(b, R.lists.byte + w * listStride, ids.length).set(ids);
    listOf.push(ids);
    lists.push(ids.length);
  }
  const scaleIn = new Float32Array(b, R.scaleIn.byte, SCALE_N);
  for (let i = 0; i < SCALE_N; i++) scaleIn[i] = rnd() * 200 - 100;
  const ids = new Uint16Array(b, R.ids.byte, IDS_N);
  for (let i = 0; i < IDS_N; i++) ids[i] = (rnd() * 65536) | 0;

  // Each job with the bytes it may write: its worker's entities' rows, its scale output, its bins.
  const only = (ranges) => {
    const mask = new Uint8Array(bytes.length);
    for (const [from, to] of ranges) mask.fill(1, from, to);
    return mask;
  };
  const jobs = ROLES.map((_, w) => {
    const rowRanges = listOf[w].map((e) => [R.rows.byte + e * stride * 2, R.rows.byte + (e + 1) * stride * 2]);
    const out = (name) => [[R[name].byte, R[name].byte + R[name].bytes]];
    return [
      { module: 'spatialPublish', fn: 'publish_batch', args: [lists[w], MAX_N, R.pos.byte, R.range.byte, R.cand.byte, R.rows.byte, R.lists.byte + w * listStride], writes: only(rowRanges) },
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

  // Solo: this thread runs every job once, one at a time, on a copy of the memory.
  const pages = memory.buffer.byteLength / 65536;
  const solo = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const soloBytes = new Uint8Array(solo.buffer);
  soloBytes.set(new Uint8Array(memory.buffer));
  const kernels = {};
  for (const m of MODULES) kernels[m.name] = await loadWasmKernel(m.name, m.url, solo, m.exports);
  for (let w = 0; w < jobs.length; w++) {
    for (const job of jobs[w]) {
      const prior = soloBytes.slice();
      kernels[job.module][job.fn](...job.args);
      const outside = firstDifference(prior, soloBytes, job.writes);
      assert.equal(outside, -1, `${ROLES[w]} ${job.fn} wrote outside its region, at byte ${outside}`);
    }
  }
  const expected = soloBytes.slice();
  const rows = new Uint16Array(solo.buffer, R.rows.byte, 2048 * stride);
  let published = 0;
  for (let e = 0; e < 2048; e++) if (e % 4 !== 3) published += rows[e * stride];
  assert.ok(published > 0, 'neighbours were published');
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
