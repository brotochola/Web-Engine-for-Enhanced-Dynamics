#!/usr/bin/env node
/**
 * Kernel (N-300): the shipped sweep (src/wasm/engine.wasm sweep_light_f32, as pre-render calls it) of every light of a
 * visPolyStressScene frame with a compound solid's polar bins in reach, against the same sweeps without them: what the
 * polar merge (clip_polar: the rays, and since N-300 the sweep's vertices kept among them) adds to a light.
 * visibilitySweepWasmMicrobench.mjs leaves the polar path out (the JS bins are module state no shared input fills); here
 * the bins are written straight into the kernel's memory: radius everywhere but `arcs` arcs of `arcBins` bins each, at
 * 0.4 to 0.9 of the radius, owners 0 to arcs - 1, the same for every light (relative to it).
 *
 *   plain   every light's sweep, polar 0
 *   polar   every light's sweep, polar 1 (the merge)
 *
 * `--occluders` sets the frame's boxes (visPolyStressScene has 700; more crowd each light: 3000 is about 50 a light).
 * One op is the frame. Checksum: the polygons' vertex count and float bits (FNV-1a) of the polar case.
 *
 *   node tests/bench/visibilityPolarMicrobench.mjs [--occluders 3000] [--lights 120] [--arcs 6] [--arc-bins 24]
 *     [--reps 7] [--output path]
 */
import { POLAR_BINS } from '../../src/render/visibility/angularSweep.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { mulberry32 } from './benchMath.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { SWEEP_SLOTS, createSweepKernel, visPolyFrame } from '../helpers/visibilitySweepKernel.mjs';

const SHIPPED_URL = new URL('../../src/wasm/engine.wasm', import.meta.url);
const SLOT_MAX_VERTS = SWEEP_SLOTS.indexOf('maxVerts');

export async function run({ occluders = 3000, lights = 120, arcs = 6, arcBins = 24, reps = 7 } = {}) {
  const scenes = visPolyFrame({ lights, occluders });
  const k = await createSweepKernel({
    sets: scenes.map((sc) => ({ occluders: Math.max(1, sc.occCount), poolVerts: Math.max(4, sc.poolVerts) })),
    maxVerts: 5000,
    ownerSeenCap: 64,
  });
  scenes.forEach((sc, i) => {
    k.load(i, sc);
    k.sets[i].table[SLOT_MAX_VERTS] = 5000;
  });
  const raw = await loadWasmKernel('visibilitySweep', SHIPPED_URL, k.memory, ['sweep_light_f32']);
  const radius = scenes[0].radius;
  const rng = mulberry32(0x300);
  k.polarDist.fill(radius);
  k.polarOwner.fill(-1);
  for (let a = 0; a < arcs; a++) {
    const b0 = Math.floor(rng() * POLAR_BINS);
    const d = radius * (0.4 + 0.5 * rng());
    for (let j = 0; j < arcBins; j++) {
      const b = (b0 + j) % POLAR_BINS;
      k.polarDist[b] = Math.fround(d + j * 0.25);
      k.polarOwner[b] = a;
    }
  }
  let stamp = 0;
  const frame = (polar) => {
    let n = 0;
    k.setOwnerStamp(++stamp);
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      k.consts[3] = sc.lx;
      k.consts[4] = sc.ly;
      k.consts[5] = sc.radius;
      n += raw.sweep_light_f32(k.sets[i].tableByte, sc.occCount, polar);
    }
    return n;
  };
  // The kernel compiled by short calls first (one light), as the game's frames compile it.
  warmNormalCompile(() => {
    k.consts[3] = scenes[0].lx;
    k.consts[4] = scenes[0].ly;
    k.consts[5] = scenes[0].radius;
    raw.sweep_light_f32(k.sets[0].tableByte, scenes[0].occCount, 1);
  }, 2000);
  const cases = {};
  for (const [name, polar] of [['plain', 0], ['polar', 1]]) {
    let vertices = 0;
    const t = timeIt(`${name}`, () => {
      vertices = frame(polar);
    }, { reps, silent: true });
    cases[name] = { ms: t.ms / t.iterations, vertices };
  }
  // The polar case's polygons, hashed, for a check that both trees agree where they should.
  let h = 0x811c9dc5;
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    k.consts[3] = sc.lx;
    k.consts[4] = sc.ly;
    k.consts[5] = sc.radius;
    const n = raw.sweep_light_f32(k.sets[i].tableByte, sc.occCount, 1);
    h = Math.imul(h ^ n, 16777619) >>> 0;
    for (let v = 0; v < n; v++) {
      f[0] = k.outX[v];
      h = Math.imul(h ^ u[0], 16777619) >>> 0;
      f[0] = k.outY[v];
      h = Math.imul(h ^ u[0], 16777619) >>> 0;
    }
  }
  const perLight = scenes.reduce((s, sc) => s + sc.occCount, 0) / scenes.length;
  return { feature: 'visibility-polar', lights: scenes.length, occluders, boxesPerLight: perLight, arcs, arcBins, cases, check: h };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const report = await run({
    occluders: Number(args.occluders ?? 3000),
    lights: Number(args.lights ?? 120),
    arcs: Number(args.arcs ?? 6),
    arcBins: Number(args['arc-bins'] ?? 24),
    reps: Number(args.reps ?? 7),
  });
  const { plain, polar } = report.cases;
  console.log(`${report.lights} lights, ${report.boxesPerLight.toFixed(1)} boxes a light`);
  console.log(`plain ${plain.ms.toFixed(3)} ms a frame (${plain.vertices} vertices)`);
  console.log(`polar ${polar.ms.toFixed(3)} ms a frame (${polar.vertices} vertices), the merge ${(polar.ms - plain.ms).toFixed(3)} ms, check ${report.check}`);
  if (args.output) writeReport(String(args.output), report);
}
