// Y-band prerender sort: each band is a non-overlapping sort-key range.
// Concatenation replaces the k-way merge. Pixi would not sort.
//
//   node tests/bench/painterYBandMicrobench.mjs --output tests/results/prerender-sort-gonogo/yband.json

import {
  floatBitsToOrd,
  createPainterState,
  orderPainterSlots,
} from '../../src/util/sortIndexByKey.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const N = 300000;
const Y_SCALE = 128;

const scratchF = new Float32Array(1);
const scratchU = new Uint32Array(scratchF.buffer);

function putKey(u32, index, y, inner) {
  scratchF[0] = Math.round(y) * Y_SCALE + inner;
  u32[index] = scratchU[0];
}

function checksum(order, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s = (Math.imul(s, 16777619) ^ order[i]) >>> 0;
  return s;
}

/** Keys already grouped by band. Band b owns y in [b * span, (b+1) * span). */
function buildBandedKeys(n, k) {
  const keys = new Uint32Array(n);
  const span = 64;
  const gap = 2;
  const counts = new Int32Array(k);
  const base = (n / k) | 0;
  for (let b = 0; b < k; b++) counts[b] = b === k - 1 ? n - base * (k - 1) : base;
  let i = 0;
  for (let b = 0; b < k; b++) {
    for (let j = 0; j < counts[b]; j++, i++) {
      const y = b * (span + gap) + (j % span);
      const inner = (j % 255) - 127;
      putKey(keys, i, y, inner);
    }
  }
  return { keys, counts };
}

function prefixesOf(counts) {
  const prefix = new Int32Array(counts.length);
  let acc = 0;
  for (let b = 0; b < counts.length; b++) {
    prefix[b] = acc;
    acc += counts[b];
  }
  return prefix;
}

function concat(orders, counts, prefix, out) {
  let o = 0;
  for (let b = 0; b < orders.length; b++) {
    const n = counts[b];
    const src = orders[b];
    const base = prefix[b];
    for (let i = 0; i < n; i++) out[o++] = base + src[i];
  }
}

function assertBands(k) {
  const { keys, counts } = buildBandedKeys(N, k);
  const prefix = prefixesOf(counts);
  const full = createPainterState(N);
  const fullOrder = orderPainterSlots(full, null, N, keys);
  const expect = new Uint32Array(fullOrder.subarray(0, N));
  const states = [];
  const orders = [];
  for (let b = 0; b < k; b++) {
    const len = counts[b];
    const state = createPainterState(len);
    const view = keys.subarray(prefix[b], prefix[b] + len);
    orders.push(orderPainterSlots(state, null, len, view));
    states.push(state);
  }
  const merged = new Uint32Array(N);
  concat(orders, counts, prefix, merged);
  if (checksum(merged, N) !== checksum(expect, N)) {
    throw new Error(`k=${k} concat is not the global order`);
  }
  for (let i = 1; i < N; i++) {
    const prev = floatBitsToOrd(keys[merged[i - 1]]);
    const cur = floatBitsToOrd(keys[merged[i]]);
    if (prev > cur) throw new Error(`k=${k} concat not sorted at ${i}`);
  }
  return { counts: Array.from(counts) };
}

function flipInside(keys, base, len, salt) {
  const flips = Math.max(1, (len / 10) | 0);
  const span = 64;
  for (let j = 0; j < flips; j++) {
    const local = (j * 17 + salt) % len;
    const y = (salt + j) % span;
    const inner = ((j % 255) - 127) | 0;
    putKey(keys, base + local, y, inner);
  }
}

function benchK(k) {
  const { keys, counts } = buildBandedKeys(N, k);
  const prefix = prefixesOf(counts);
  const states = [];
  const orders = [];
  for (let b = 0; b < k; b++) {
    const len = counts[b];
    const state = createPainterState(len);
    const view = keys.subarray(prefix[b], prefix[b] + len);
    orders.push(orderPainterSlots(state, null, len, view));
    states.push(state);
  }
  const out = new Uint32Array(N);
  const len0 = counts[0];
  const band = timeIt(`y-band reinsert k=${k} n=${len0}`, (iters) => {
    for (let n = 0; n < iters; n++) {
      flipInside(keys, prefix[0], len0, n);
      const view = keys.subarray(prefix[0], prefix[0] + len0);
      orderPainterSlots(states[0], null, len0, view);
    }
  }, { iterations: 4, warmup: 1 });
  const copy = timeIt(`concat k=${k} N=${N}`, (iters) => {
    for (let n = 0; n < iters; n++) concat(orders, counts, prefix, out);
  }, { iterations: 20, warmup: 4 });
  return {
    k,
    band: len0,
    bandMs: band.ms / band.iterations,
    concatMs: copy.ms / copy.iterations,
  };
}

const args = parseArgs();
const check2 = assertBands(2);
const check4 = assertBands(4);
const rows = [benchK(2), benchK(4)];
const pixiStep = 21.924;
const pixiSort = 5.165;
const preStep = 10.727;
const projected = rows.map((row) => {
  const pre = preStep + row.bandMs + row.concatMs;
  const pixi = pixiStep - pixiSort;
  return {
    ...row,
    pixiStepNow: pixiStep,
    pixiSortNow: pixiSort,
    pixiStepIfNoSort: pixi,
    pixiDeltaPct: ((pixi - pixiStep) / pixiStep) * 100,
    preStepNow: preStep,
    preStepIfBand: pre,
    preDeltaPct: ((pre - preStep) / preStep) * 100,
  };
});
const payload = {
  hypothesis: 'Y-band sort plus concat, no merge. Pixi stops sorting. Cost model on the PainterMove headed run.',
  n: N,
  check2,
  check4,
  headed: { pixiStep, pixiSort, preStep, queue: 300000 },
  projected,
};
console.log(JSON.stringify(payload, null, 2));
if (args.output) writeReport(args.output, payload);
