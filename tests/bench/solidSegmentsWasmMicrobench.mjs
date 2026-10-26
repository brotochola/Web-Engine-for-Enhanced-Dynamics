#!/usr/bin/env node
/**
 * Kernel (E-76 W1): the compound-solid polar raster in WASM (wasm/test/solidSegments.c, a test module) against
 * the shipped collectSolidSegments, on compoundVisPolyStressScene?ringSegments=64's frames.
 *
 *   js      collectSolidSegments (src/render/visibility/angularSweep.js) as pre-render calls it: per visible light
 *           clearPolarBins(radius), then one call per compound island in reach, the island's entity as owner
 *   f64     collect_solid_f64: the JS's arithmetic with an fdlibm atan2 (bit for bit the JS in Node)
 *   pseudo  collect_solid_pseudo: no atan2, each end's bin from its octant and a tan table
 *   fast    collect_solid_fast: pseudo with a division-free range accept and stamp filter
 *   f64x2   collect_solid_f64x2: fast, two bins per f64x2 with the JS's raySegT lane by lane
 *   f32x4   collect_solid_f32x4: fast, a float filter over four bins per vector, the JS's raySegT on what passes
 *
 * A WASM side clears the bins in its memory the way clearPolarBins clears the module's (a fill of each view and
 * the active flag), then makes one call per (light, island), the solid's seg and chain copied into the memory
 * once (the scene's islands keep their polygons). Each island has its own copy, as it has its own cache entry in
 * pre-render. The frames, the memory and the gate are tests/helpers/solidSegmentsKernel.mjs's: 40 rings of 64
 * segments and 24 lights of influence radius 1500 at t = 0, 0.5, ..., 3.5 s, about 884 calls, 51.7 k spans and
 * 76 k bin stamps a frame. The timed op is one frame; a sample is whole cycles of the eight.
 *
 * Checksum (tolerance-aware): the helper's gate compares a variant's bins with the JS's over the eight frames
 * (distances within a relative 1e-5, at most FLIP_LIMIT bins stamped by one side only and each next to a
 * rastered end, owners equal outside near-ties, hit > 0 and the active flag equal). A passing variant reports
 * the hash of the JS's bins, owners and hit flags, so every valid variant agrees with `js`; a failing one the hash
 * of its own, so runKernelVariants rejects it. --check prints it with the gate's counts and does not time.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/solidSegmentsWasmMicrobench.mjs --variants js,fast --rounds 5
 *   node tests/bench/solidSegmentsWasmMicrobench.mjs --variant f64x2 [--check] [--output path]   (base = js)
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/solidSegmentsWasmMicrobench.mjs [--args '{"rounds":9}']
 *
 * Browser-safe at the top level: `run()` is what chromeKernel.mjs calls in Chrome (every side in one page,
 * alternating, args { rounds, minMs, variants: "js,f64,..." }); the Node CLI loads its Node-only helpers when it
 * runs.
 */
import { POLAR_BINS, segmentDistSq } from '../../src/render/visibility/angularSweep.js';
import { normalizeAngleSigned } from '../../src/util/utils.js';
import {
  FLIP_LIMIT,
  FRAME_TIMES,
  SCENE_SEED,
  TOLERANCE,
  WASM_VARIANTS,
  sceneGate,
} from '../helpers/solidSegmentsKernel.mjs';
import { clearPolarBins, collectSolidSegments } from '../reference/visibilitySweepJs.mjs';

export const VARIANTS = ['js', ...Object.keys(WASM_VARIANTS)];

const TWO_PI = Math.PI * 2;
const BIN_SCALE = POLAR_BINS / TWO_PI;

/** Flat columns of one frame's calls, for the timed loops. */
function flatten(frame, k) {
  const total = frame.reduce((n, f) => n + f.calls.length, 0);
  const F = {
    lights: frame.length, start: new Int32Array(frame.length + 1), lx: new Float64Array(frame.length),
    ly: new Float64Array(frame.length), radius: new Float64Array(frame.length), r2: new Float64Array(frame.length),
    solid: [], seg: new Int32Array(total), chain: new Int32Array(total), n: new Int32Array(total),
    wx: new Float64Array(total), wy: new Float64Array(total), c: new Float64Array(total), s: new Float64Array(total),
    owner: new Int32Array(total),
  };
  let q = 0;
  frame.forEach(({ light, calls }, l) => {
    F.start[l] = q;
    F.lx[l] = light.lx;
    F.ly[l] = light.ly;
    F.radius[l] = light.radius;
    F.r2[l] = light.radius * light.radius;
    for (const call of calls) {
      const p = k.place(call.solid);
      F.solid.push(call.solid);
      F.seg[q] = p.segByte;
      F.chain[q] = p.chainByte;
      F.n[q] = p.n;
      F.wx[q] = call.wx;
      F.wy[q] = call.wy;
      F.c[q] = call.c;
      F.s[q] = call.s;
      F.owner[q] = call.owner;
      q++;
    }
  });
  F.start[frame.length] = q;
  return F;
}

/** One frame through the shipped JS, as pre-render calls it. */
function jsFrame(F) {
  let sink = 0;
  for (let l = 0; l < F.lights; l++) {
    clearPolarBins(F.radius[l]);
    const lx = F.lx[l];
    const ly = F.ly[l];
    const r2 = F.r2[l];
    for (let q = F.start[l]; q < F.start[l + 1]; q++) {
      sink += collectSolidSegments(F.solid[q], F.wx[q], F.wy[q], F.c[q], F.s[q], 0, 0, lx, ly, r2, F.owner[q]);
    }
  }
  return sink;
}

// One loop literal per WASM side: closures of one literal share their feedback, so in Chrome (every side in one
// page) a shared loop would make the export call site polymorphic.
const WASM_FRAME_BODY = `
  let sink = 0;
  for (let l = 0; l < F.lights; l++) {
    const r = F.radius[l] > 0 ? F.radius[l] : 0;
    dist.fill(r);
    owner.fill(-1);
    active[0] = 0;
    const lx = F.lx[l];
    const ly = F.ly[l];
    const r2 = F.r2[l];
    for (let q = F.start[l]; q < F.start[l + 1]; q++) {
      sink += fn(ctx, F.seg[q], F.chain[q], F.n[q], F.wx[q], F.wy[q], F.c[q], F.s[q], 0, 0, lx, ly, r2, F.owner[q]);
    }
  }
  return sink;`;

function makeWasmFrame(k, fn) {
  // eslint-disable-next-line no-new-func
  const loop = new Function('fn', 'ctx', 'dist', 'owner', 'active', 'F', WASM_FRAME_BODY);
  return (F) => loop(fn, k.ctxByte, k.dist, k.owner, k.active, F);
}

/** The work in the frames, by the JS's filter: calls, rastered spans and bin stamps a frame. */
function workCounts(frames) {
  let calls = 0;
  let spans = 0;
  let stamps = 0;
  for (const frame of frames) {
    for (const { light, calls: list } of frame) {
      const { lx, ly, radius } = light;
      const r2 = radius * radius;
      calls += list.length;
      for (const { solid, wx, wy, c, s } of list) {
        for (let i = 0; i < solid.segCount; i++) {
          const o = i * 4;
          const x0 = wx + c * solid.seg[o] - s * solid.seg[o + 1];
          const y0 = wy + s * solid.seg[o] + c * solid.seg[o + 1];
          const x1 = wx + c * solid.seg[o + 2] - s * solid.seg[o + 3];
          const y1 = wy + s * solid.seg[o + 2] + c * solid.seg[o + 3];
          if ((x1 - x0) * (ly - y0) - (y1 - y0) * (lx - x0) >= 0) continue;
          if (segmentDistSq(lx, ly, x0, y0, x1, y1) > r2) continue;
          let open = normalizeAngleSigned(Math.atan2(y0 - ly, x0 - lx));
          let close = normalizeAngleSigned(Math.atan2(y1 - ly, x1 - lx));
          let span = close - open;
          if (span < 0) span += TWO_PI;
          if (span > Math.PI) {
            [open, close] = [close, open];
            span = TWO_PI - span;
          }
          if (!(span > 1e-4)) continue;
          spans++;
          const b0 = Math.min(POLAR_BINS - 1, ((open + Math.PI) * BIN_SCALE) | 0);
          const b1 = Math.min(POLAR_BINS - 1, ((close + Math.PI) * BIN_SCALE) | 0);
          stamps += (open <= close ? b1 : b1 + POLAR_BINS) - b0 + 1;
        }
      }
    }
  }
  const n = frames.length;
  return { callsPerFrame: calls / n, spansPerFrame: spans / n, stampsPerFrame: stamps / n, binsPerSpan: stamps / spans };
}

/** The gate, each side's frame op (op(i) times frame i mod 8) and short calls for a normal compile. */
export async function setupSolidSegmentsBench(opts = {}) {
  const gate = await sceneGate(opts);
  const { k, frames } = gate;
  const flat = frames.map((f) => flatten(f, k));
  const ops = { js: (i) => jsFrame(flat[i % flat.length]) };
  for (const v of Object.keys(WASM_VARIANTS)) {
    const frame = makeWasmFrame(k, k.fns[v]);
    ops[v] = (i) => frame(flat[i % flat.length]);
  }
  // One light and one island, over and over.
  const first = frames[0].find((f) => f.calls.length > 0);
  const shortFor = (variant) => {
    const { light, calls } = first;
    const call = calls[0];
    const r2 = light.radius * light.radius;
    if (variant === 'js') {
      return () => {
        clearPolarBins(light.radius);
        collectSolidSegments(call.solid, call.wx, call.wy, call.c, call.s, 0, 0, light.lx, light.ly, r2, call.owner);
      };
    }
    const fn = k.fns[variant];
    const p = k.place(call.solid);
    return () => {
      k.clear(light.radius);
      fn(k.ctxByte, p.segByte, p.chainByte, p.n, call.wx, call.wy, call.c, call.s, 0, 0, light.lx, light.ly, r2, call.owner);
    };
  };
  return { ...gate, flat, ops, shortFor, work: workCounts(frames) };
}

function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** chromeKernel.mjs entry: every side in one page, alternating; ops/s are frames per second. */
export async function run(args = {}) {
  const rounds = Number(args.rounds ?? 9);
  const minMs = Number(args.minMs ?? 30);
  const sides = String(args.variants ?? VARIANTS.join(',')).split(',');
  const bench = await setupSolidSegmentsBench();
  const gate = Object.fromEntries(sides.map((v) => [v, bench.verify(v)]));
  for (const v of sides) {
    const short = bench.shortFor(v);
    for (let i = 0; i < 3000; i++) short();
  }
  let sink = 0;
  const counts = {};
  for (const v of sides) {
    // Whole cycles of the eight frames, so every sample times the same work.
    let n = FRAME_TIMES.length;
    for (;;) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) sink += bench.ops[v](i);
      if (performance.now() - t0 >= minMs) break;
      n *= 2;
    }
    counts[v] = n;
  }
  const samples = Object.fromEntries(sides.map((v) => [v, []]));
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? sides : [...sides].reverse();
    for (const v of order) {
      const t0 = performance.now();
      for (let i = 0; i < counts[v]; i++) sink += bench.ops[v](i);
      samples[v].push((counts[v] * 1000) / (performance.now() - t0));
    }
  }
  const cases = {};
  for (const v of sides) {
    const ops = median(samples[v]);
    cases[v] = {
      opsPerSec: ops, msPerFrame: 1000 / ops, samples: samples[v], checksum: gate[v].checksum, pass: gate[v].pass,
      vsJs: sides.includes('js') ? (ops / median(samples.js) - 1) * 100 : null, stats: gate[v].stats,
    };
  }
  return {
    feature: 'solid-segments-wasm', rounds, minMs, work: bench.work, refChecksum: bench.refHash, cases,
    sink: Number.isFinite(sink) ? 'finite' : String(sink),
  };
}

async function main() {
  const { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } = await import('./microbenchHelpers.mjs');
  if (!isCli(import.meta.url)) return;
  const { machineState, warmWasm } = await import('./wasmKernelHelpers.mjs');
  const args = parseArgs();
  // `base` (runKernelVariants' usual first side) is the shipped JS.
  const variant = args.variant === 'base' ? 'js' : String(args.variant || 'js');
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant} (${VARIANTS.join(', ')})`);
  const bench = await setupSolidSegmentsBench();
  const gate = bench.verify(variant);
  if (args.check) {
    console.log(`checksum ${gate.checksum} variant ${variant} ${gate.pass ? 'pass' : 'FAIL'} ${JSON.stringify(gate.stats)}`);
    console.log(`work ${JSON.stringify(bench.work)}`);
    return;
  }
  const op = bench.ops[variant];
  let i = 0;
  const frame = () => op(i++);
  let tier = null;
  if (variant === 'js') warmNormalCompile(bench.shortFor('js'));
  else tier = await warmWasm(bench.k.fns[variant], bench.shortFor(variant));
  // The frame loop itself: a few whole frames so its own code is not OSR either.
  for (let w = 0; w < 4 * FRAME_TIMES.length; w++) frame();
  // A sample is whole cycles of the eight frames, so every sample times the same work.
  const cases = {
    frame: timeIt(`solid segments ${variant} (${bench.work.callsPerFrame} calls a frame)`, frame, {
      iterations: FRAME_TIMES.length, warmup: FRAME_TIMES.length,
    }),
  };
  const report = {
    feature: 'solid-segments-wasm',
    variant,
    functions: ['collectSolidSegments', variant === 'js' ? null : `solidSegments.${WASM_VARIANTS[variant]}`].filter(Boolean),
    n: bench.work.callsPerFrame,
    seed: SCENE_SEED,
    frames: FRAME_TIMES.length,
    work: bench.work,
    checksum: gate.checksum,
    gate: { pass: gate.pass, tolerance: TOLERANCE, flipLimit: FLIP_LIMIT, stats: gate.stats },
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${gate.checksum} ${gate.pass ? 'pass' : 'FAIL'}${tier ? ` tier ${tier}` : ''} frame ${cases.frame.opsPerSec.toFixed(1)} ops/s`);
}

if (typeof process !== 'undefined' && process.versions?.node) await main();
