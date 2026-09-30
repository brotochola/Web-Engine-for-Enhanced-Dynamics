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
import { GPU_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { stampLightRange, takeClosest } from '../../src/render/gpuShadowCasters.js';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

const TAKE = { base: takeClosest };

export function setupStamp(fx, opts = {}) {
  const { x, y, active, shadowActive, shadowH, lightActive, visualRange } = fx.arrays;
  const n = fx.meta.n;
  const sf = GPU_CASTER_FLOATS;
  const casters = [];
  for (let i = 0; i < n; i++) if (active[i] && shadowActive[i] && shadowH[i] > 0) casters.push(i);
  const sunN = casters.length;
  const sun = new Float32Array(sunN * sf);
  let cx = 0;
  let cy = 0;
  for (let c = 0; c < sunN; c++) {
    const i = casters[c];
    sun[c * sf] = x[i];
    sun[c * sf + 1] = y[i];
    sun[c * sf + 2] = 1;
    sun[c * sf + 3] = 1;
    cx += x[i];
    cy += y[i];
  }
  cx /= sunN || 1;
  cy /= sunN || 1;
  const lightsAll = [];
  for (let i = 0; i < n; i++) {
    if (!active[i] || !lightActive[i]) continue;
    const range = visualRange[i] > 0 ? visualRange[i] : 400;
    lightsAll.push({ id: i, x: x[i], y: y[i], intensity: 1, rangeSq: range * range, maxShadows: 0, d: (x[i] - cx) ** 2 + (y[i] - cy) ** 2 });
  }
  lightsAll.sort((a, b) => a.d - b.d || a.id - b.id);
  const lights = lightsAll.slice(0, opts.maxLights ?? fx.meta.lighting?.maxShadowCastingLights ?? 48);
  const maxPL = opts.maxPerLight ?? fx.meta.lighting?.maxShadowsPerLight ?? 512;
  const maxPE = opts.maxPerEntity ?? fx.meta.lighting?.maxShadowsPerEntity ?? 3;
  const stampCap = 30000;
  const spec = {
    sun,
    sunN,
    sunFloats: sf,
    lights,
    lightBegin: 0,
    lightEnd: lights.length,
    lightStride: 1,
    maxPerLight: maxPL,
    maxPerEntity: maxPE,
    used: new Uint8Array(sunN),
    tmpIdx: new Uint32Array(sunN),
    dist: new Float32Array(sunN),
    order: new Uint32Array(sunN),
    keepIdx: new Uint32Array(sunN),
    gridCounts: new Int32Array(128 * 128),
    gridStarts: new Int32Array(128 * 128 + 1),
    gridItems: new Uint32Array(sunN),
    stamp: new Float32Array(stampCap * sf),
    stampFloats: sf,
    stampCap,
    stampBase: 0,
    stampLightIdx: new Uint16Array(stampCap),
    lightVec: new Float32Array(4),
  };
  // Per-light candidate sets (every caster within range), for the takeClosest case.
  const candidates = lights.map((L) => {
    const ids = [];
    const d = [];
    for (let c = 0; c < sunN; c++) {
      const dx = sun[c * sf] - L.x;
      const dy = sun[c * sf + 1] - L.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= L.rangeSq) {
        ids.push(c);
        d.push(d2);
      }
    }
    return { idx: Uint32Array.from(ids), dist: Float32Array.from(d) };
  });
  return { spec, sunN, lights, candidates, maxPL };
}

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
