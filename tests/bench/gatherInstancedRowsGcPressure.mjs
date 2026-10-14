// H-02, second question: does removing the subarray relieve GC pressure?
//
// The CPU answer is NEUTRAL. At 45 568 queued rows the gather is memory-bound, so
// removing a short-lived TypedArray view per row saves ~5.8 % of SPRITE_PACK_MS
// rather than the kernel's 2.94x - the kernel's working set was small enough for
// the allocation to be the cost.
//
// But the allocation is still an allocation, and GC time does not appear in
// STEP_MS: it lands between frames, on a different thread, and is invisible to
// every number in the sitting. This measures it directly by counting GC events
// with a PerformanceObserver, which is the only instrument that sees it.
//
// Method: identical buffers and indices for both variants, the same number of
// gathers, counting only `gc` entries with kind scavenge or incremental. The
// arrays are allocated once up front so the ONLY thing that can differ between
// the two runs is what gatherInstancedRows itself allocates.

import { PerformanceObserver, constants } from 'node:perf_hooks';

import {
  gatherInstancedRows,
  GPU_SPRITE_FLOATS,
  GPU_CASTER_FLOATS,
  GPU_CASTER_LIGHT_FLOAT,
} from '../../src/render/gpuQueueLayout.js';

const NO_PARENT = 0xffff;

/** The pre-H-02 implementation: one subarray view per row. */
function gatherSubarray(src, dst, indices, n, srcFp, dstFp, shadowQ) {
  const sn = n | 0;
  const sfp = srcFp | 0;
  const dfp = dstFp | 0;
  if (!src || !dst || sn <= 0) return 0;
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    const from = i * sfp;
    const to = k * dfp;
    const spriteN = sfp < GPU_SPRITE_FLOATS ? sfp : GPU_SPRITE_FLOATS;
    dst.set(src.subarray(from, from + spriteN), to);
    if (shadowQ && dfp >= GPU_CASTER_FLOATS) {
      const shAt = GPU_SPRITE_FLOATS;
      dst[to + shAt] = shadowQ.shadowH ? shadowQ.shadowH[i] : 0;
      dst[to + shAt + 1] = shadowQ.shadowOffX ? shadowQ.shadowOffX[i] : 0;
      dst[to + shAt + 2] = shadowQ.shadowOffY ? shadowQ.shadowOffY[i] : 0;
      const lightAt = GPU_CASTER_LIGHT_FLOAT;
      dst[to + lightAt] = 0;
      dst[to + lightAt + 1] = 0;
      dst[to + lightAt + 2] = 0;
      dst[to + lightAt + 3] = 0;
    }
  }
  return sn;
}

const ROWS = 45568; // the measured queue depth of spritePackStressScene
const SRC_FP = GPU_SPRITE_FLOATS;
const DST_FP = GPU_CASTER_FLOATS;
const POOL = 65535;

const src = new Float32Array(POOL * SRC_FP);
for (let i = 0; i < src.length; i++) src[i] = (i % 97) * 0.01;
const dst = new Float32Array(ROWS * DST_FP);
const indices = new Uint32Array(ROWS);
for (let k = 0; k < ROWS; k++) indices[k] = (k * 7919) % POOL;
const shadowQ = {
  shadowH: new Float32Array(POOL).fill(0.25),
  shadowOffX: new Float32Array(POOL).fill(-1.5),
  shadowOffY: new Float32Array(POOL).fill(2.5),
};

// Count GC events for the duration of `fn`.
function countGc(fn) {
  let events = 0;
  let gcMs = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (
        e.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR ||
        e.detail?.kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL ||
        e.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR
      ) {
        events++;
        gcMs += e.duration;
      }
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  fn();
  obs.disconnect();
  return { events, gcMs };
}

function measure(label, fn, rounds) {
  fn(); // warm, and let the first allocations settle
  global.gc?.();
  const t0 = process.hrtime.bigint();
  const r = countGc(() => {
    for (let r2 = 0; r2 < rounds; r2++) fn();
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    label,
    events: r.events,
    gcMs: r.gcMs,
    ms,
    perGatherUs: (ms * 1000) / rounds,
    rowsPerSec: (rounds * ROWS) / (ms / 1000),
  };
}

const ROUNDS = 40; // ~1.8 M rows: enough for scavenges to be countable

console.log(`\nH-02 GC pressure - ${ROWS.toLocaleString()} rows x ${ROUNDS} rounds\n`);

const results = [];
// Interleave so any drift in heap state hits both variants equally.
for (let rep = 0; rep < 3; rep++) {
  results.push(
    measure('A subarray', () => gatherSubarray(src, dst, indices, ROWS, SRC_FP, DST_FP, shadowQ), ROUNDS),
    measure('B looped  ', () => gatherInstancedRows(src, dst, indices, ROWS, SRC_FP, DST_FP, shadowQ), ROUNDS),
  );
}

for (const r of results) {
  console.log(
    `  ${r.label}  GC events ${String(r.events).padStart(3)}   GC ${r.gcMs.toFixed(1).padStart(6)} ms   ` +
      `gather ${r.perGatherUs.toFixed(0).padStart(5)} µs/frame   ${(r.rowsPerSec / 1e6).toFixed(2)} M rows/s`,
  );
}

const a = results.filter((r) => r.label.startsWith('A'));
const b = results.filter((r) => r.label.startsWith('B'));
const sum = (xs, f) => xs.reduce((p, c) => p + f(c), 0);
console.log('');
console.log(`  A subarray: ${sum(a, (r) => r.events)} GC events total`);
console.log(`  B looped  : ${sum(b, (r) => r.events)} GC events total`);
const ea = sum(a, (r) => r.events);
const eb = sum(b, (r) => r.events);
console.log(
  ea > 0
    ? `  -> the subarray version triggers ${ea - eb} more GC events (${(((ea - eb) / ea) * 100).toFixed(0)}% fewer with the loop)`
    : '  -> neither variant triggered a GC event; the allocation is young-gen and was collected in-place',
);
console.log('');
console.log('  Per frame this is', ea === eb ? 'no difference' : `${Math.abs(ea - eb) / results.length} events per ${ROUNDS} frames`);