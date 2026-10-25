#!/usr/bin/env node
/**
 * Kernel (E-76 W23, E-114): pre-render's shadow-caster stamp in WASM (wasm/shadowStamp.c,
 * src/render/shadowStamp.wasm) against the shipped stampLightRange, on the Predator fixture as shadowStampMicrobench sets it
 * up: the 48 lights nearest the caster centroid, maxShadowsPerLight 512, maxShadowsPerEntity 3, casters
 * packed as GPU_CASTER_FLOATS rows.
 *
 *   js          stampLightRange (src/render/gpuShadowCasters.js), the whole call
 *   wasm        stamp_light_range, one call per frame, the lights copied into a table of five doubles first
 *               (x, y, intensity, rangeSq, maxShadows), as a product wrapper would each frame
 *   wasm-f32    stamp_light_range_f32 (tests/fixtures/wasm/shadowStampF32.wasm, from wasm/test/shadowStampF32.c):
 *               the same call with each candidate's distance and range test in float32
 *   wasm-f32x4  stamp_light_range_f32x4: that float32 test four casters a step
 *
 * The sun rows and the stamp output are GPU-queue regions of the render-queue memory in the product, and
 * the scratch would be regions of it too; here every array lives in one shared WebAssembly.Memory, so
 * both sides read and write the same bytes. One variant per process, through runKernelVariants.mjs, which
 * rejects a variant whose checksum differs: the stamp rows written, their light indices and the cursor.
 *
 * A float32 variant may keep another caster where two distances are tied within float rounding
 * (tests/bench/shadowStampTolerance.mjs states the tolerance). Its process runs the shipped kernel first: when
 * the variant writes the same bytes, its checksum is theirs; when the two differ only by ties (on an uncapped
 * stamp, compared pair by pair), it reports the shipped kernel's checksum and the flips under `tolerance`;
 * otherwise its own checksum, which runKernelVariants rejects. Nothing is quantised: every row is a copy, so no
 * value can be off, only a pair.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/shadowStampWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/shadowStampWasmMicrobench.mjs --variants wasm,wasm-f32,wasm-f32x4 --rounds 5
 *   node tests/bench/shadowStampWasmMicrobench.mjs --variant wasm [--max-per-entity 0] [--output path]
 *   node tests/bench/shadowStampWasmMicrobench.mjs --variant wasm-f32 --check   (the checksum only, no timing)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';
import { createStampKernel } from './shadowStampKernel.mjs';
import { compareStamps } from './shadowStampTolerance.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../src/render/shadowStamp.wasm'));
const F32_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/shadowStampF32.wasm'));
/** The variants: the JS (null), or a module's export. */
export const STAMP_VARIANTS = {
  js: null,
  wasm: { url: KERNEL_URL, name: 'shadowStamp', fn: 'stamp_light_range' },
  'wasm-f32': { url: F32_URL, name: 'shadowStampF32', fn: 'stamp_light_range_f32' },
  'wasm-f32x4': { url: F32_URL, name: 'shadowStampF32', fn: 'stamp_light_range_f32x4' },
};

/** The fixture's spec in one shared memory (shadowStampKernel.mjs), and each variant's export on it. */
async function setupKernel(opts) {
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const k = await createStampKernel(fx, opts, KERNEL_URL);
  /** A variant's export, instantiated on this memory (null for the JS). */
  const kernelOf = async (variant) => {
    const v = STAMP_VARIANTS[variant];
    if (!v) return null;
    if (v.url === KERNEL_URL) return k.stampRange;
    return (await loadWasmKernel(v.name, v.url, k.memory, [v.fn]))[v.fn];
  };
  return { ...k, kernelOf };
}

/** What runKernelVariants compares: the cursor, the rows written and their light indices. */
function stampChecksum(spec, written) {
  let h = Math.imul(2166136261 ^ written, 16777619) >>> 0;
  h = Math.imul(h ^ checksumFloats(spec.stamp, written * spec.stampFloats), 16777619) >>> 0;
  return Math.imul(h ^ checksumInts(spec.stampLightIdx, written), 16777619) >>> 0;
}

/** The last call's output, copied. */
function snapshot(spec, cursor) {
  return { cursor, stamp: spec.stamp.slice(0, cursor * spec.stampFloats), lightIdx: spec.stampLightIdx.slice(0, cursor) };
}

/**
 * A float32 variant's checksum: the shipped kernel's when the variant writes its bytes or differs from them
 * only by ties (an uncapped stamp, compared pair by pair); else the variant's own.
 */
function toleranceChecksum(k, run) {
  const spec = k.spec;
  const refWritten = k.stampWasm();
  const refChecksum = stampChecksum(spec, refWritten);
  const ref = snapshot(spec, refWritten);
  const written = run();
  const own = stampChecksum(spec, written);
  if (own === refChecksum) return { written, checksum: own, tolerance: { identical: true } };
  if (refWritten >= spec.stampCap || written >= spec.stampCap) {
    return { written, checksum: own, tolerance: { identical: false, ok: false, problems: ['the stamp is capped: its pairs cannot be compared'] } };
  }
  const { problems, ...cmp } = compareStamps(spec, GPU_CASTER_LIGHT_FLOAT, ref, snapshot(spec, written));
  return { written, checksum: cmp.ok ? refChecksum : own, tolerance: { ...cmp, problems: problems.slice(0, 8) } };
}

async function main() {
  const args = parseArgs();
  // The shipped path by default (the engine catalog runs it with no flags); js is the reference.
  const variant = String(args.variant || 'wasm');
  if (!(variant in STAMP_VARIANTS)) throw new Error(`unknown variant ${variant} (${Object.keys(STAMP_VARIANTS).join(', ')})`);
  const opts = {};
  if (args['max-per-entity'] !== undefined) opts.maxPerEntity = Number(args['max-per-entity']);
  const k = await setupKernel(opts);
  const fn = await k.kernelOf(variant);
  const run = fn ? () => k.stampWith(fn) : () => stampLightRange(k.spec);

  let written;
  let checksum;
  let tolerance = null;
  if (fn && fn !== k.stampRange) {
    ({ written, checksum, tolerance } = toleranceChecksum(k, run));
  } else {
    written = run();
    checksum = stampChecksum(k.spec, written);
  }
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} written ${written}${tolerance ? ` tolerance ${JSON.stringify(tolerance)}` : ''}`);
    return;
  }

  let tier = null;
  if (fn) tier = await warmWasm(fn, run, { calls: 300 });
  else warmNormalCompile(run, 300);
  const cases = {
    stamp: timeIt(`stamp ${variant} (${k.lights.length} lights, ${k.sunN} casters, ${k.spec.maxPerEntity} per entity)`, run, { iterations: 20, warmup: 20 }),
  };
  const report = {
    feature: 'shadow-stamp-wasm',
    variant,
    functions: ['stampLightRange', `${STAMP_VARIANTS[variant]?.name ?? 'shadowStamp'}.${STAMP_VARIANTS[variant]?.fn ?? 'stamp_light_range'}`],
    n: k.sunN,
    lights: k.lights.length,
    maxPerEntity: k.spec.maxPerEntity,
    stampWritten: written,
    checksum,
    tolerance,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} written ${written}${tier ? ` tier ${tier}` : ''} stamp ${cases.stamp.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
