#!/usr/bin/env node
/**
 * Q4 (E-76): what one JS -> WASM call costs, by argument count and type. Decides how coarse a
 * kernel's calls must be (per frame, per batch, per light, per entity).
 *
 * The test module (wasm/test/callCost.c) does almost nothing per call; a JS function doing the same
 * work, called from the same loop, is the baseline, so wasm - js is the boundary. Every side runs
 * in one loop shape, alternating in one process, 9 rounds; a sample is at least 3 ms. Results are
 * nanoseconds per call (median of the rounds).
 *
 * Browser-safe: `run()` is what chromeKernel.mjs calls in Chrome (V8 there is not Node's).
 *   node tests/bench/wasmCallCostMicrobench.mjs [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/wasmCallCostMicrobench.mjs
 */

function sides(ex) {
  const memI32 = 64; // byte offset of a word the load reads (inside the null guard)
  return {
    js4d: { fn: (a, b, c, d) => a + b + c + d, kind: 'js', args: 4 },
    nop0: { fn: ex.nop0, kind: 'void', args: 0 },
    sum4i: { fn: ex.sum4i, kind: 'i32', args: 4 },
    sum8i: { fn: ex.sum8i, kind: 'i32', args: 8 },
    sum4d: { fn: ex.sum4d, kind: 'f64', args: 4 },
    sum8d: { fn: ex.sum8d, kind: 'f64', args: 8 },
    load1: { fn: () => ex.load1(memI32), kind: 'i32', args: 1 },
  };
}

/**
 * One loop literal per side: closures of one literal share their feedback, so two sides on one
 * literal make its call site polymorphic (the first draft put the JS baseline and sum4d on one).
 */
function makeLoop(side) {
  const f = side.fn;
  if (side.kind === 'js') return (n) => { let acc = 0; for (let i = 0; i < n; i++) { const x = i * 0.5; acc += f(x, x + 1.5, x + 2.5, x + 3.5); } return acc; };
  if (side.kind === 'void') return (n) => { for (let i = 0; i < n; i++) f(); return n; };
  if (side.kind === 'i32' && side.args === 1) return (n) => { let acc = 0; for (let i = 0; i < n; i++) acc = (acc + f()) | 0; return acc; };
  if (side.kind === 'i32' && side.args === 4) return (n) => { let acc = 0; for (let i = 0; i < n; i++) acc = (acc + f(i, i + 1, i + 2, i + 3)) | 0; return acc; };
  if (side.kind === 'i32') return (n) => { let acc = 0; for (let i = 0; i < n; i++) acc = (acc + f(i, i + 1, i + 2, i + 3, i + 4, i + 5, i + 6, i + 7)) | 0; return acc; };
  if (side.args === 4) return (n) => { let acc = 0; for (let i = 0; i < n; i++) { const x = i * 0.5; acc += f(x, x + 1.5, x + 2.5, x + 3.5); } return acc; };
  return (n) => { let acc = 0; for (let i = 0; i < n; i++) { const x = i * 0.5; acc += f(x, x + 1.5, x + 2.5, x + 3.5, x + 4.5, x + 5.5, x + 6.5, x + 7.5); } return acc; };
}

function median(v) {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

export async function measure(bytes, { rounds = 9, minMs = 3 } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  const all = sides(instance.exports);
  const names = Object.keys(all);
  const loops = Object.fromEntries(names.map((k) => [k, makeLoop(all[k])]));
  let sink = 0;
  // Warm every loop and target to the optimizing tiers through short calls.
  for (let w = 0; w < 2000; w++) for (const k of names) sink += loops[k](100);
  const counts = {};
  for (const k of names) {
    let n = 1000;
    for (;;) {
      const t0 = performance.now();
      sink += loops[k](n);
      if (performance.now() - t0 >= minMs) break;
      n *= 2;
    }
    counts[k] = n;
  }
  const ns = Object.fromEntries(names.map((k) => [k, []]));
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? names : [...names].reverse();
    for (const k of order) {
      const t0 = performance.now();
      sink += loops[k](counts[k]);
      ns[k].push(((performance.now() - t0) * 1e6) / counts[k]);
    }
  }
  const result = { nsPerCall: {}, boundaryNs: {}, sink: Number.isFinite(sink) ? 'finite' : String(sink) };
  for (const k of names) result.nsPerCall[k] = Number(median(ns[k]).toFixed(2));
  for (const k of names.slice(1)) result.boundaryNs[k] = Number((result.nsPerCall[k] - result.nsPerCall.js4d).toFixed(2));
  return result;
}

/** chromeKernel.mjs entry. */
export async function run(args = {}) {
  const url = new URL('../fixtures/wasm/callCost.wasm', import.meta.url);
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return measure(bytes, args);
}

if (typeof process !== 'undefined' && process.versions?.node) {
  const { isCli, parseArgs, writeReport } = await import('./microbenchHelpers.mjs');
  if (isCli(import.meta.url)) {
    const { readFileSync } = await import('node:fs');
    const { machineState } = await import('./wasmKernelHelpers.mjs');
    const args = parseArgs();
    const result = await measure(readFileSync(new URL('../fixtures/wasm/callCost.wasm', import.meta.url)), { rounds: Number(args.rounds ?? 9) });
    const rounds = Number(args.rounds ?? 9);
    const cases = Object.fromEntries(Object.entries(result.nsPerCall).map(([k, v]) => [k, { opsPerSec: 1e9 / v, nsPerCall: v }]));
    const report = { feature: 'wasm-call-cost', n: rounds, seed: 0, checksum: 0, machine: machineState(), ...result, cases };
    console.log(JSON.stringify(report, null, 2));
    if (args.output) writeReport(String(args.output), report);
  }
}
