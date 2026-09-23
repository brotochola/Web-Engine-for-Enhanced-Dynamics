// Kernel for the prerender painter go/no-go. Does not ship a merge.
// Each shard sorts its contiguous queue window with orderPainterSlots.
// A k-pointer merge must match one sort of the whole queue.
//
//   node tests/bench/painterShardMergeMicrobench.mjs --output tests/results/prerender-sort-gonogo/kernel.json

import {
  floatBitsToOrd,
  createPainterState,
  orderPainterSlots,
} from '../../src/util/sortIndexByKey.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const N = 300000;
const BLOCK = 256;

function checksum(order, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s = (Math.imul(s, 16777619) ^ order[i]) >>> 0;
  return s;
}

function buildKeys(n, seed) {
  const rng = mulberry32(seed);
  const floats = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = rng() * 4000 - 500;
    const inner = ((rng() * 254) | 0) - 127;
    floats[i] = Math.round(y) * 128 + inner;
  }
  return new Uint32Array(floats.buffer);
}

function shardOf(index, k) {
  return (Math.floor(index / BLOCK) % k) | 0;
}

function sliceLayout(n, k) {
  const counts = new Int32Array(k);
  for (let i = 0; i < n; i++) counts[shardOf(i, k)]++;
  const prefix = new Int32Array(k);
  let acc = 0;
  for (let s = 0; s < k; s++) {
    prefix[s] = acc;
    acc += counts[s];
  }
  return { counts, prefix };
}

/** Pack global slots into k contiguous windows, the way a shard writes its prefix. */
function packWindows(keys, k) {
  const n = keys.length;
  const { counts, prefix } = sliceLayout(n, k);
  const packed = new Uint32Array(n);
  const cursor = new Int32Array(prefix);
  for (let i = 0; i < n; i++) {
    const s = shardOf(i, k);
    packed[cursor[s]++] = keys[i];
  }
  return { packed, counts, prefix };
}

function kWayMerge(orders, counts, prefixes, keys, out) {
  const k = orders.length;
  const cur = new Int32Array(k);
  const headOrd = new Uint32Array(k);
  const alive = new Uint8Array(k);
  let total = 0;
  for (let s = 0; s < k; s++) {
    total += counts[s];
    if (counts[s] > 0) {
      alive[s] = 1;
      headOrd[s] = floatBitsToOrd(keys[prefixes[s] + orders[s][0]]);
    }
  }
  for (let o = 0; o < total; o++) {
    let best = -1;
    let bestOrd = 0;
    for (let s = 0; s < k; s++) {
      if (!alive[s]) continue;
      const ord = headOrd[s];
      if (best < 0 || ord < bestOrd || (ord === bestOrd && s < best)) {
        best = s;
        bestOrd = ord;
      }
    }
    const local = orders[best][cur[best]++];
    out[o] = prefixes[best] + local;
    if (cur[best] >= counts[best]) alive[best] = 0;
    else headOrd[best] = floatBitsToOrd(keys[prefixes[best] + orders[best][cur[best]]]);
  }
  return total;
}

function assertMerge(k) {
  const globalKeys = buildKeys(N, 11 + k);
  const { packed, counts, prefix } = packWindows(globalKeys, k);
  const full = createPainterState(N);
  const fullOrder = orderPainterSlots(full, null, N, packed);
  const fullCopy = new Uint32Array(fullOrder.subarray(0, N));

  const states = [];
  const orders = [];
  for (let s = 0; s < k; s++) {
    const len = counts[s];
    const state = createPainterState(len);
    const view = packed.subarray(prefix[s], prefix[s] + len);
    orders.push(orderPainterSlots(state, null, len, view));
    states.push(state);
  }
  const merged = new Uint32Array(N);
  kWayMerge(orders, counts, prefix, packed, merged);
  if (checksum(merged, N) !== checksum(fullCopy, N)) {
    throw new Error(`k=${k} merge checksum mismatch`);
  }
  for (let i = 0; i < N; i++) {
    if (merged[i] !== fullCopy[i]) {
      throw new Error(`k=${k} mismatch at ${i}: ${merged[i]} vs ${fullCopy[i]}`);
    }
  }
  // 10% of each window changes Y, including a negative key on the shard edge.
  for (let s = 0; s < k; s++) {
    const len = counts[s];
    const base = prefix[s];
    const flips = Math.max(1, (len / 10) | 0);
    for (let j = 0; j < flips; j++) {
      const local = (j * 17) % len;
      const y = j === 0 ? -40 : 1000 + j;
      const bits = new Float32Array([Math.round(y) * 128 + (j - 3)]);
      packed[base + local] = new Uint32Array(bits.buffer)[0];
    }
  }
  const fullAfterState = createPainterState(N);
  const fullAfterOrder = orderPainterSlots(fullAfterState, null, N, packed);
  const fullAfter = new Uint32Array(fullAfterOrder.subarray(0, N));
  const statesAfter = [];
  const ordersAfter = [];
  for (let s = 0; s < k; s++) {
    const len = counts[s];
    const state = createPainterState(len);
    const view = packed.subarray(prefix[s], prefix[s] + len);
    ordersAfter.push(orderPainterSlots(state, null, len, view));
    statesAfter.push(state);
  }
  kWayMerge(ordersAfter, counts, prefix, packed, merged);
  if (checksum(merged, N) !== checksum(fullAfter, N)) {
    throw new Error(`k=${k} moved-key merge checksum mismatch`);
  }
  return { counts: Array.from(counts), prefix: Array.from(prefix) };
}

const scratchF = new Float32Array(1);
const scratchU = new Uint32Array(scratchF.buffer);

function putKey(packed, index, y, inner) {
  scratchF[0] = Math.round(y) * 128 + inner;
  packed[index] = scratchU[0];
}

function flipSlice(packed, base, len, salt) {
  const flips = Math.max(1, (len / 10) | 0);
  for (let j = 0; j < flips; j++) {
    const local = (j * 17 + salt) % len;
    const y = ((salt + j) & 1) === 0 ? -40 - j : 1000 + j;
    putKey(packed, base + local, y, j - 3);
  }
}

function benchK(k) {
  const globalKeys = buildKeys(N, 99 + k);
  const { packed, counts, prefix } = packWindows(globalKeys, k);
  const states = [];
  const orders = [];
  for (let s = 0; s < k; s++) {
    const len = counts[s];
    const state = createPainterState(len);
    const view = packed.subarray(prefix[s], prefix[s] + len);
    orders.push(orderPainterSlots(state, null, len, view));
    states.push(state);
  }
  const merged = new Uint32Array(N);
  const local = timeIt(`local-sort k=${k} n=${counts[0]}`, (iters) => {
    for (let n = 0; n < iters; n++) {
      flipSlice(packed, prefix[0], counts[0], n);
      const view = packed.subarray(prefix[0], prefix[0] + counts[0]);
      orderPainterSlots(states[0], null, counts[0], view);
    }
  }, { iterations: 4, warmup: 1 });
  const merge = timeIt(`k-way k=${k} N=${N}`, (iters) => {
    for (let n = 0; n < iters; n++) {
      kWayMerge(orders, counts, prefix, packed, merged);
    }
  }, { iterations: 8, warmup: 2 });
  return {
    k,
    slice: counts[0],
    localMs: local.ms / local.iterations,
    localOps: local.opsPerSec,
    mergeMs: merge.ms / merge.iterations,
    mergeOps: merge.opsPerSec,
  };
}

const args = parseArgs();
const layout2 = assertMerge(2);
const layout4 = assertMerge(4);
const rows = [benchK(2), benchK(4)];
const payload = {
  hypothesis: 'Local painter plus k-way merge matches one sort. Per-frame ms is the cost a prerender publisher would add.',
  n: N,
  block: BLOCK,
  layout2,
  layout4,
  rows,
};
console.log(JSON.stringify(payload, null, 2));
if (args.output) writeReport(args.output, payload);
