#!/usr/bin/env node
/**
 * Kernel (E-76 W23 screen): pre-render's shadow-caster stamp in WASM (wasm/test/shadowStamp.c, a test
 * module) against the shipped stampLightRange, on the Predator fixture as shadowStampMicrobench sets it
 * up: the 48 lights nearest the caster centroid, maxShadowsPerLight 512, maxShadowsPerEntity 3, casters
 * packed as GPU_CASTER_FLOATS rows.
 *
 *   js    stampLightRange (src/render/gpuShadowCasters.js), the whole call
 *   wasm  stamp_light_range, one call per frame, the lights copied into a table of five doubles first
 *         (x, y, intensity, rangeSq, maxShadows), as a product wrapper would each frame
 *
 * The sun rows and the stamp output are GPU-queue regions of the render-queue memory in the product, and
 * the scratch would be regions of it too; here every array lives in one shared WebAssembly.Memory, so
 * both sides read and write the same bytes. One variant per process, through runKernelVariants.mjs, which
 * rejects a variant whose checksum differs: the stamp rows written, their light indices and the cursor.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/shadowStampWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/shadowStampWasmMicrobench.mjs --variant wasm [--max-per-entity 0] [--output path]
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
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/shadowStamp.wasm'));
const LIGHT_DOUBLES = 5;
/** shadowStamp.c's table, slot for slot. */
const SLOTS = [
  'sun', 'sunN', 'sunFloats', 'lights', 'lightBegin', 'lightEnd', 'lightStride', 'maxPL', 'maxPE',
  'tmpIdx', 'dist', 'order', 'keep', 'tmpCap',
  'gridCounts', 'gridStarts', 'gridItems', 'gridCountsCap', 'gridItemsCap',
  'stamp', 'stampFloats', 'stampCap', 'stampBase', 'stampLightIdx', 'lightFloat',
  'nearDist', 'nearSlot', 'nearCount', 'pairDist',
];
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
    { name: 'pairDist', owner: 'pre-render', bytes: Math.max(1, s.sunN) * 4 },
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
  put('pairDist', R.pairDist.byte);

  const { stamp_light_range: stampRange } = await loadWasmKernel('shadowStamp', KERNEL_URL, memory, ['stamp_light_range']);
  /** The product wrapper: the light objects into the table, then one call. */
  const stampWasm = () => {
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
    return stampRange(R.table.byte);
  };
  return { ...s, spec, stampWasm, stampRange };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const opts = {};
  if (args['max-per-entity'] !== undefined) opts.maxPerEntity = Number(args['max-per-entity']);
  const k = await setupKernel(opts);
  const run = variant === 'wasm' ? () => k.stampWasm() : () => stampLightRange(k.spec);

  const written = run();
  let checksum = Math.imul(2166136261 ^ written, 16777619) >>> 0;
  checksum = Math.imul(checksum ^ checksumFloats(k.spec.stamp, written * k.spec.stampFloats), 16777619) >>> 0;
  checksum = Math.imul(checksum ^ checksumInts(k.spec.stampLightIdx, written), 16777619) >>> 0;

  let tier = null;
  if (variant === 'wasm') tier = await warmWasm(k.stampRange, () => k.stampWasm(), { calls: 300 });
  else warmNormalCompile(run, 300);
  const cases = {
    stamp: timeIt(`stamp ${variant} (${k.lights.length} lights, ${k.sunN} casters, ${k.spec.maxPerEntity} per entity)`, run, { iterations: 20, warmup: 20 }),
  };
  const report = {
    feature: 'shadow-stamp-wasm',
    variant,
    functions: ['stampLightRange', 'shadowStamp.stamp_light_range'],
    n: k.sunN,
    lights: k.lights.length,
    maxPerEntity: k.spec.maxPerEntity,
    stampWritten: written,
    checksum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} written ${written}${tier ? ` tier ${tier}` : ''} stamp ${cases.stamp.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
