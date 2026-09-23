// Kernel: precompute floatBitsToOrd once per reinsert, vs computing it
// inside the radix passes and the merge. Same permutation checksum.
// Also a glow-sized note: full radix vs reinsert at n=256 and n=8000.
//
//   node tests/bench/painterOrdinalMicrobench.mjs --output tests/results/ysort-quantize/ordinal.json

import {
  floatBitsToOrd,
  reinsertChangedSlots,
  radixSortIndicesBySortKey,
  createPainterState,
} from '../../src/util/sortIndexByKey.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const N = 300000;

function checksum(order, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s = (Math.imul(s, 16777619) ^ order[i]) >>> 0;
  return s;
}

function radixByOrd(idx, n, ord, scratch, hist) {
  if ((n | 0) < 2) return;
  let src = idx;
  let dst = scratch;
  for (let shift = 0; shift < 32; shift += 8) {
    hist.fill(0);
    for (let i = 0; i < n; i++) hist[(ord[src[i]] >>> shift) & 255]++;
    let sum = 0;
    for (let bin = 0; bin < 256; bin++) {
      const c = hist[bin];
      hist[bin] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const id = src[i];
      dst[hist[(ord[id] >>> shift) & 255]++] = id;
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
}

function reinsertOrd(order, n, keysU32, ord, prevKey, slotMoved, movedList, merge, scratch, hist) {
  for (let i = 0; i < n; i++) ord[i] = floatBitsToOrd(keysU32[i]);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const slot = order[i];
    const key = keysU32[slot];
    if (key !== prevKey[slot]) {
      prevKey[slot] = key;
      slotMoved[slot] = 1;
      movedList[m++] = slot;
    }
  }
  if (m === 0) return 0;
  radixByOrd(movedList, m, ord, scratch, hist);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const slot = order[i];
    if (slotMoved[slot]) continue;
    order[w++] = slot;
  }
  if (w + m !== n) {
    for (let j = 0; j < m; j++) slotMoved[movedList[j]] = 0;
    return -1;
  }
  let a = 0;
  let b = 0;
  let o = 0;
  while (a < w && b < m) {
    const ka = ord[order[a]];
    const kb = ord[movedList[b]];
    if (ka <= kb) merge[o++] = order[a++];
    else merge[o++] = movedList[b++];
  }
  while (a < w) merge[o++] = order[a++];
  while (b < m) merge[o++] = movedList[b++];
  for (let i = 0; i < n; i++) order[i] = merge[i];
  for (let j = 0; j < m; j++) slotMoved[movedList[j]] = 0;
  return m;
}

function makeKeys(n, rng) {
  const calm = new Float32Array(n);
  const hot = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = (i % 400) * 22 + ((i / 400) | 0);
    calm[i] = y * 128;
    hot[i] = (i % 10 === 0 ? y + (rng() < 0.5 ? -0.2 : 0.2) : y) * 128;
  }
  return { calm, hot };
}

function fresh(n, calmU) {
  const state = createPainterState(n);
  for (let i = 0; i < n; i++) {
    state.order[i] = i;
    state.prevKey[i] = calmU[i];
  }
  return state;
}

function run() {
  const args = parseArgs();
  const rng = mulberry32(0x04d1);
  const { calm, hot } = makeKeys(N, rng);
  const calmU = new Uint32Array(calm.buffer);
  const hotU = new Uint32Array(hot.buffer);

  const a = fresh(N, calmU);
  const b = fresh(N, calmU);
  const ord = new Uint32Array(N);
  reinsertChangedSlots(a.order, N, hotU, a.prevKey, a.slotMoved, a.moved, a.merge, a.scratch, a.hist);
  reinsertOrd(b.order, N, hotU, ord, b.prevKey, b.slotMoved, b.moved, b.merge, b.scratch, b.hist);
  const sumA = checksum(a.order, N);
  const sumB = checksum(b.order, N);
  if (sumA !== sumB) throw new Error(`checksum ${sumA} vs ${sumB}`);

  function timeReinsert(label, useOrd) {
    const state = fresh(N, calmU);
    const localOrd = new Uint32Array(N);
    let useHot = 1;
    return timeIt(label, (iters) => {
      for (let n = 0; n < iters; n++) {
        const keys = useHot ? hotU : calmU;
        useHot ^= 1;
        if (useOrd) {
          reinsertOrd(
            state.order, N, keys, localOrd, state.prevKey, state.slotMoved,
            state.moved, state.merge, state.scratch, state.hist,
          );
        } else {
          reinsertChangedSlots(
            state.order, N, keys, state.prevKey, state.slotMoved,
            state.moved, state.merge, state.scratch, state.hist,
          );
        }
      }
    }, { iterations: 1, reps: 5 });
  }

  const current = timeReinsert('current', false);
  const ordinal = timeReinsert('ordinal', true);
  const ratio = ordinal.opsPerSec / current.opsPerSec;

  function glow(n) {
    const g = makeKeys(n, rng);
    const gCalm = new Uint32Array(g.calm.buffer);
    const gHot = new Uint32Array(g.hot.buffer);
    const radixState = fresh(n, gCalm);
    const reState = fresh(n, gCalm);
    let useHot = 1;
    const radix = timeIt(`glow-radix-${n}`, (iters) => {
      for (let i = 0; i < iters; i++) {
        const keys = useHot ? gHot : gCalm;
        useHot ^= 1;
        for (let s = 0; s < n; s++) radixState.order[s] = s;
        radixSortIndicesBySortKey(radixState.order, n, keys, radixState.scratch, radixState.hist);
      }
    }, { iterations: 4, reps: 5 });
    useHot = 1;
    const re = timeIt(`glow-reinsert-${n}`, (iters) => {
      for (let i = 0; i < iters; i++) {
        const keys = useHot ? gHot : gCalm;
        useHot ^= 1;
        reinsertChangedSlots(
          reState.order, n, keys, reState.prevKey, reState.slotMoved,
          reState.moved, reState.merge, reState.scratch, reState.hist,
        );
      }
    }, { iterations: 4, reps: 5 });
    return {
      n,
      radixOps: radix.opsPerSec,
      reinsertOps: re.opsPerSec,
      radixVsReinsert: radix.opsPerSec / re.opsPerSec,
    };
  }

  const payload = {
    n: N,
    checksum: sumA,
    current,
    ordinal,
    opsRatio: ratio,
    glow: [glow(256), glow(8000)],
  };
  console.log(`ordinal/current ops ${ratio.toFixed(3)}`);
  for (const g of payload.glow) {
    console.log(`glow n=${g.n} radix/reinsert ops ${g.radixVsReinsert.toFixed(3)}`);
  }
  if (args.output) writeReport(String(args.output), payload);
}

run();
