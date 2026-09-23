// Kernel: reinsert when 10% of Y keys jitter ±0.2 px.
// Raw pose.y * 128 changes bits. Rounded keys do not, so reinsert returns 0.
//
//   node tests/bench/spriteSortKeyMicrobench.mjs
//   node tests/bench/spriteSortKeyMicrobench.mjs --output tests/results/ysort-quantize/kernel.json

import { reinsertChangedSlots, createPainterState, spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const Y_SORT_K = 128;
const N = 300000;

function checksum(order, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s = (Math.imul(s, 16777619) ^ order[i]) >>> 0;
  return s;
}

function run() {
  const args = parseArgs();
  const rng = mulberry32(0x71507);
  const y = new Float32Array(N);
  const jitter = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    y[i] = (i % 400) * 22 + ((i / 400) | 0);
    jitter[i] = i % 10 === 0 ? (rng() < 0.5 ? -0.2 : 0.2) : 0;
  }

  const raw = new Float32Array(N);
  const quant = new Float32Array(N);
  const rawU = new Uint32Array(raw.buffer);
  const quantU = new Uint32Array(quant.buffer);
  for (let i = 0; i < N; i++) {
    raw[i] = y[i] * Y_SORT_K;
    quant[i] = spriteYSortKey(y[i], Y_SORT_K);
  }

  const rawState = createPainterState(N);
  const quantState = createPainterState(N);
  for (let i = 0; i < N; i++) {
    rawState.order[i] = i;
    quantState.order[i] = i;
    rawState.prevKey[i] = rawU[i];
    quantState.prevKey[i] = quantU[i];
  }
  rawState.ready = true;
  rawState.n = N;
  quantState.ready = true;
  quantState.n = N;
  const rawOrder0 = checksum(rawState.order, N);
  const quantOrder0 = checksum(quantState.order, N);

  for (let i = 0; i < N; i++) {
    if (jitter[i] === 0) continue;
    raw[i] = (y[i] + jitter[i]) * Y_SORT_K;
    quant[i] = spriteYSortKey(y[i] + jitter[i], Y_SORT_K);
  }

  const quantChanged = reinsertChangedSlots(
    quantState.order, N, quantU, quantState.prevKey, quantState.slotMoved,
    quantState.moved, quantState.merge, quantState.scratch, quantState.hist,
  );
  const rawChanged = reinsertChangedSlots(
    rawState.order, N, rawU, rawState.prevKey, rawState.slotMoved,
    rawState.moved, rawState.merge, rawState.scratch, rawState.hist,
  );
  if (quantChanged !== 0) throw new Error(`quantized reinsert moved ${quantChanged} slots`);
  if (checksum(quantState.order, N) !== quantOrder0) throw new Error('quantized order changed');
  if (!(rawChanged > 0)) throw new Error('raw reinsert did not move');
  if (checksum(rawState.order, N) === rawOrder0) throw new Error('raw order did not change');

  // Alternate two key buffers so every op sees a real frame change.
  // Quantized buffers match, so reinsert returns 0. Raw buffers differ on 10%.
  const rawBase = new Float32Array(N);
  const quantBase = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    rawBase[i] = y[i] * Y_SORT_K;
    quantBase[i] = spriteYSortKey(y[i], Y_SORT_K);
  }

  function bench(label, calm, hot) {
    const state = createPainterState(N);
    const calmU = new Uint32Array(calm.buffer);
    const hotU = new Uint32Array(hot.buffer);
    for (let i = 0; i < N; i++) {
      state.order[i] = i;
      state.prevKey[i] = calmU[i];
    }
    let useHot = 1;
    return timeIt(label, (iters) => {
      for (let n = 0; n < iters; n++) {
        const keys = useHot ? hotU : calmU;
        useHot ^= 1;
        reinsertChangedSlots(
          state.order, N, keys, state.prevKey, state.slotMoved,
          state.moved, state.merge, state.scratch, state.hist,
        );
      }
    }, { iterations: 1, reps: 5 });
  }

  const rawTimed = bench('raw', rawBase, raw);
  const quantTimed = bench('quantized', quantBase, quant);

  const ratio = quantTimed.opsPerSec / rawTimed.opsPerSec;
  const payload = {
    n: N,
    rawChanged,
    quantChanged,
    raw: rawTimed,
    quantized: quantTimed,
    opsRatio: ratio,
  };
  console.log(`ops ratio quantized/raw ${ratio.toFixed(3)}`);
  if (args.output) writeReport(String(args.output), payload);
  return payload;
}

run();
