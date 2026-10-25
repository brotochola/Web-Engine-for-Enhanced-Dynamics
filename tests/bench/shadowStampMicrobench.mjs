#!/usr/bin/env node
/**
 * Kernel: pre-render shadow stamping with the Predator fixture.
 *   - stamp: shipped stampLightRange (grid gather + takeClosest + append) for
 *     the 48 lights nearest the caster centroid, maxShadowsPerLight 512,
 *     maxShadowsPerEntity 3, casters packed as GPU_CASTER_FLOATS rows.
 *   - takeClosest: the exported selection alone on each light's candidates.
 *
 *   node tests/bench/shadowStampMicrobench.mjs
 *   node tests/bench/shadowStampMicrobench.mjs --output out.json
 */
import { stampLightRange, takeClosest } from '../reference/shadowStamp.mjs';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';
import { setupStamp } from './shadowStampKernel.mjs';

const TAKE = { base: takeClosest };

export { setupStamp } from './shadowStampKernel.mjs';

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const take = TAKE[variant];
  if (!take) throw new Error(`unknown variant ${variant}`);
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const s = setupStamp(fx);

  const written = stampLightRange(s.spec);
  const stampChecksum = checksumFloats(s.spec.stamp, written * s.spec.stampFloats);

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
  const mStats = s.candidates.map((c) => c.idx.length).sort((a, b) => a - b);
  const report = {
    feature: 'shadow-stamp',
    functions: ['stampLightRange', 'takeClosest'],
    variant,
    n: s.sunN,
    lights: s.lights.length,
    seed: 0,
    maxPerLight: s.maxPL,
    candidatesPerLight: { min: mStats[0], median: mStats[mStats.length >> 1], max: mStats[mStats.length - 1] },
    stampWritten: written,
    stampChecksum,
    checksum: takeChecksum,
    note: 'Casters and lights from tests/fixtures/predator-frame.bin. checksum = takeClosest kept ids in order.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify({ written, stampChecksum, takeChecksum, m: report.candidatesPerLight }));
}

if (isCli(import.meta.url)) await main();
