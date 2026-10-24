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

import { GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { stampLightRange } from '../../src/render/gpuShadowCasters.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES } from '../../src/util/wasmMemoryMap.js';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';
import { setupStamp } from './shadowStampMicrobench.mjs';
import { compareStamps } from './shadowStampTolerance.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { STAMP_SLOTS } from '../../src/render/shadowStampClient.js';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../src/render/shadowStamp.wasm'));
const F32_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/shadowStampF32.wasm'));
/** The variants: the JS (null), or a module's export. */
export const STAMP_VARIANTS = {
  js: null,
  wasm: { url: KERNEL_URL, name: 'shadowStamp', fn: 'stamp_light_range' },
  'wasm-f32': { url: F32_URL, name: 'shadowStampF32', fn: 'stamp_light_range_f32' },
  'wasm-f32x4': { url: F32_URL, name: 'shadowStampF32', fn: 'stamp_light_range_f32x4' },
};
const LIGHT_DOUBLES = 5;
/** shadowStamp.c's table, slot for slot. */
const SLOTS = STAMP_SLOTS;
const SLOT = Object.fromEntries(SLOTS.map((name, k) => [name, k]));

/** The fixture's spec with every array moved into one shared memory. */
async function setupKernel(opts) {
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const s = setupStamp(fx, opts);
  const spec = s.spec;
  const maxPE = spec.maxPerEntity | 0;
  const arrays = ['sun', 'used', 'tmpIdx', 'dist', 'order', 'keepIdx', 'gridCounts', 'gridStarts', 'gridItems', 'stamp', 'stampLightIdx'];
  const regions = [{ name: 'guard', owner: 'nobody', bytes: NULL_GUARD_BYTES }];
  for (const a of arrays) regions.push({ name: a, owner: 'pre-render', bytes: spec[a].byteLength });
  regions.push(
    { name: 'lightVec', owner: 'pre-render', bytes: 16 },
    { name: 'lights', owner: 'pre-render', bytes: spec.lights.length * LIGHT_DOUBLES * 8 },
    { name: 'nearDist', owner: 'pre-render', bytes: Math.max(1, s.sunN * maxPE) * 4 },
    { name: 'nearSlot', owner: 'pre-render', bytes: Math.max(1, s.sunN * maxPE) * 4 },
    { name: 'nearCount', owner: 'pre-render', bytes: Math.max(1, s.sunN) },
    { name: 'table', owner: 'pre-render', bytes: SLOTS.length * 4 },
  );
  const layout = layoutRegions(regions);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  for (const a of arrays) {
    const view = new spec[a].constructor(buffer, R[a].byte, spec[a].length);
    view.set(spec[a]);
    spec[a] = view;
  }
  spec.lightVec = new Float32Array(buffer, R.lightVec.byte, 4);
  const lights = new Float64Array(buffer, R.lights.byte, spec.lights.length * LIGHT_DOUBLES);
  const t = new Uint32Array(buffer, R.table.byte, SLOTS.length);
  const put = (slot, v) => { t[SLOT[slot]] = v; };
  put('sun', spec.sun.byteOffset);
  put('sunN', spec.sunN);
  put('sunFloats', spec.sunFloats);
  put('lights', R.lights.byte);
  put('lightBegin', spec.lightBegin);
  put('lightEnd', spec.lightEnd);
  put('lightStride', spec.lightStride);
  put('maxPL', spec.maxPerLight);
  put('maxPE', maxPE);
  put('tmpIdx', spec.tmpIdx.byteOffset);
  put('dist', spec.dist.byteOffset);
  put('order', spec.order.byteOffset);
  put('keep', spec.keepIdx.byteOffset);
  put('tmpCap', spec.tmpIdx.length);
  put('gridCounts', spec.gridCounts.byteOffset);
  put('gridStarts', spec.gridStarts.byteOffset);
  put('gridItems', spec.gridItems.byteOffset);
  put('gridCountsCap', spec.gridCounts.length);
  put('gridItemsCap', spec.gridItems.length);
  put('stamp', spec.stamp.byteOffset);
  put('stampFloats', spec.stampFloats);
  put('stampCap', spec.stampCap);
  put('stampBase', spec.stampBase);
  put('stampLightIdx', spec.stampLightIdx.byteOffset);
  put('lightFloat', GPU_CASTER_LIGHT_FLOAT);
  put('nearDist', R.nearDist.byte);
  put('nearSlot', R.nearSlot.byte);
  put('nearCount', R.nearCount.byte);

  const { stamp_light_range: stampRange } = await loadWasmKernel('shadowStamp', KERNEL_URL, memory, ['stamp_light_range']);
  /** The product wrapper: the light objects into the table, then one call of `fn` (a variant's export). */
  const stampWith = (fn) => {
    const L = spec.lights;
    const n = spec.lightEnd | 0;
    for (let i = 0, at = 0; i < n; i++, at += LIGHT_DOUBLES) {
      const light = L[i];
      if (!light) {
        lights[at + 3] = NaN;
        continue;
      }
      lights[at] = light.x;
      lights[at + 1] = light.y;
      lights[at + 2] = light.intensity;
      lights[at + 3] = light.rangeSq;
      lights[at + 4] = light.maxShadows;
    }
    return fn(R.table.byte);
  };
  const stampWasm = () => stampWith(stampRange);
  /** A variant's export, instantiated on this memory (null for the JS). */
  const kernelOf = async (variant) => {
    const v = STAMP_VARIANTS[variant];
    if (!v) return null;
    if (v.url === KERNEL_URL) return stampRange;
    return (await loadWasmKernel(v.name, v.url, memory, [v.fn]))[v.fn];
  };
  return { ...s, spec, stampWasm, stampWith, stampRange, kernelOf };
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
  const variant = String(args.variant || 'js');
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
