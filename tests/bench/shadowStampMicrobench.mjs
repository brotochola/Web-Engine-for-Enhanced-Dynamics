#!/usr/bin/env node
/**
 * Kernel: pre-render shadow stamping.
 *   - stamp: the JS reference stampLightRange (tests/reference/shadowStamp.mjs: grid gather + takeClosest + append)
 *     on the Predator fixture, for the 48 lights nearest the caster centroid, maxShadowsPerLight 512,
 *     maxShadowsPerEntity 3, casters packed as GPU_CASTER_FLOATS rows.
 *   - takeClosest: the reference's selection alone on each of those lights' candidates.
 * The shipped kernel (stamp_light_range in src/wasm/engine.wasm, one call per frame through the product's light writer,
 * timed in TurboFan):
 *   - stampWasm: the Predator fixture as above (lim 512: most lights keep every candidate, a few select).
 *   - lampWasm: lampShadowStressScene's frame (setupLampStamp: 128 lamps over 6000 walkers by default),
 *     maxShadowsPerLight 15, maxShadowsPerEntity 0: each lamp keeps 15 of ~570 candidates (m >> lim), sorted.
 *   - lampWasmPerEntity: the same frame with maxShadowsPerEntity 3 (the kept casters go to their nearest lights).
 *   - lampWasm512: the same frame with maxShadowsPerLight 512 (m around lim: about half the lamps select).
 * Each kernel case checks first that the kernel writes the JS reference's rows on its frame (same checksum).
 *
 *   node tests/bench/shadowStampMicrobench.mjs [--lamps 128] [--walkers 6000]
 *   node tests/bench/shadowStampMicrobench.mjs --output out.json
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { stampLightRange, takeClosest } from '../reference/shadowStamp.mjs';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';
import { createStampKernelFor, setupLampStamp, setupStamp, stampChecksum } from './shadowStampKernel.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const TAKE = { base: takeClosest };
const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../src/wasm/engine.wasm'));

export { setupStamp } from './shadowStampKernel.mjs';

/** Candidates per light of a setup: min, median, max. */
function candidateStats(s) {
  const m = s.candidates.map((c) => c.idx.length).sort((a, b) => a - b);
  return { min: m[0], median: m[m.length >> 1], max: m[m.length - 1] };
}

/**
 * One kernel case: the setup in one shared memory with the shipped kernel, the kernel's rows checked against the JS
 * reference's, then timed after the kernel reached TurboFan.
 */
async function kernelCase(name, label, setup) {
  const k = await createStampKernelFor(setup, KERNEL_URL);
  const rows = new Uint8Array(k.spec.stamp.buffer, k.spec.stamp.byteOffset, k.spec.stamp.byteLength);
  rows.fill(0);
  const jsWritten = stampLightRange(k.spec);
  const jsChecksum = stampChecksum(k.spec, jsWritten);
  rows.fill(0);
  const written = k.stampWasm();
  const checksum = stampChecksum(k.spec, written);
  if (written !== jsWritten || checksum !== jsChecksum) {
    throw new Error(`${name}: the kernel wrote ${written} rows (checksum ${checksum}), the JS reference ${jsWritten} (${jsChecksum})`);
  }
  const tier = await warmWasm(k.stampRange, k.stampWasm, { calls: 300 });
  const timed = timeIt(`${name} ${label}`, k.stampWasm, { iterations: 20, warmup: 20 });
  return {
    ...timed,
    lights: k.lights.length,
    casters: k.sunN,
    maxPerLight: k.spec.maxPerLight,
    maxPerEntity: k.spec.maxPerEntity,
    candidatesPerLight: candidateStats(setup),
    written,
    checksum,
    wasmTier: tier,
  };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const take = TAKE[variant];
  if (!take) throw new Error(`unknown variant ${variant}`);
  const lamps = Number(args.lamps ?? 128);
  const walkers = Number(args.walkers ?? 6000);
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const s = setupStamp(fx);

  const written = stampLightRange(s.spec);
  const stampChecksumJs = checksumFloats(s.spec.stamp, written * s.spec.stampFloats);

  const maxM = Math.max(...s.candidates.map((c) => c.idx.length));
  const tmpIdx = new Uint32Array(maxM);
  const tmpDist = new Float32Array(maxM);
  const order = new Uint32Array(maxM);
  const out = new Uint32Array(maxM);
  let takeChecksum = 2166136261;
  const takeAll = () => {
    let kept = 0;
    for (let l = 0; l < s.candidates.length; l++) {
      const c = s.candidates[l];
      const m = c.idx.length;
      tmpIdx.set(c.idx);
      tmpDist.set(c.dist);
      kept += take(tmpIdx, tmpDist, order, m, s.maxPL, out);
    }
    return kept;
  };
  for (let l = 0; l < s.candidates.length; l++) {
    const c = s.candidates[l];
    tmpIdx.set(c.idx);
    tmpDist.set(c.dist);
    const k = take(tmpIdx, tmpDist, order, c.idx.length, s.maxPL, out);
    takeChecksum = (Math.imul(takeChecksum ^ checksumInts(out, k), 16777619) >>> 0);
  }

  const cases = {
    stamp: timeIt(`stampLightRange (${s.lights.length} lights, ${s.sunN} casters)`, () => stampLightRange(s.spec), {
      iterations: 20,
      warmup: 20,
    }),
    takeClosest: timeIt(`takeClosest ${variant} (${s.candidates.length} lights, max m ${maxM})`, () => takeAll(), {
      iterations: 20,
      warmup: 20,
    }),
  };
  const lampOpts = { lamps, walkers };
  cases.stampWasm = await kernelCase('stampWasm', `(Predator fixture, ${s.lights.length} lights, 512 per light, 3 per entity)`, setupStamp(fx));
  cases.lampWasm = await kernelCase('lampWasm', `(${lamps} lamps, ${walkers} walkers, 15 per light)`, setupLampStamp(lampOpts));
  cases.lampWasmPerEntity = await kernelCase('lampWasmPerEntity', `(${lamps} lamps, ${walkers} walkers, 15 per light, 3 per entity)`,
    setupLampStamp({ ...lampOpts, maxPerEntity: 3 }));
  cases.lampWasm512 = await kernelCase('lampWasm512', `(${lamps} lamps, ${walkers} walkers, 512 per light)`,
    setupLampStamp({ ...lampOpts, maxPerLight: 512 }));
  const report = {
    feature: 'shadow-stamp',
    functions: ['stampLightRange', 'takeClosest', 'shadowStamp.stamp_light_range'],
    variant,
    n: s.sunN,
    lights: s.lights.length,
    seed: 0,
    maxPerLight: s.maxPL,
    candidatesPerLight: candidateStats(s),
    lamps,
    walkers,
    stampWritten: written,
    stampChecksum: stampChecksumJs,
    checksum: takeChecksum,
    note: 'stamp and takeClosest: the JS reference on tests/fixtures/predator-frame.bin; checksum = takeClosest kept ids '
      + 'in order. The *Wasm cases: the shipped kernel, each with its own checksum (rows, light indices, cursor), checked '
      + 'against the JS reference before timing.',
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    console.log(JSON.stringify({
      written,
      stampChecksum: stampChecksumJs,
      takeChecksum,
      m: report.candidatesPerLight,
      kernel: Object.fromEntries(['stampWasm', 'lampWasm', 'lampWasmPerEntity', 'lampWasm512'].map((n) => [n, {
        opsPerSec: Math.round(cases[n].opsPerSec), checksum: cases[n].checksum, m: cases[n].candidatesPerLight,
      }])),
    }));
  }
}

if (isCli(import.meta.url)) await main();
