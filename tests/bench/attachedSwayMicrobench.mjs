#!/usr/bin/env node
/**
 * Kernel (E-196): the attached decorations' pass, ParticleWorker.resolveAttachedDecorations, on a real particle worker
 * (setupSwayKernel's boot and pool). Every decoration hangs from one of PARENTS entities (stand-in Transform columns,
 * as the E-179c test gives the worker) and sways as proceduralTreeScene's leaves do: SWAY_LOOP, 0.16 to 0.2 rad, a
 * base rotation of up to 0.8 rad, so most angles take Math.cos and Math.sin besides the sway's Math.sin. A third of
 * the parents stand in the view, and their decorations carry the on-screen flag the screen test would leave them.
 * The pass places every decoration (the screen test reads where) and sways it.
 *
 * The checksum is every decoration's x and y and the on-screen ones' rotC and rotS: a revision that leaves the
 * off-screen ones unswayed writes the same.
 *
 * Case `walls` (DX-DECOSKEW): the same pass over a house's wall pieces as Conurbano-weed hangs them: no sway, no base
 * rotation, unturned parents, half of them sheared (skewY, a wall at a heading; hung unturned, as spawn does) where
 * DecorationComponent has the shear columns; on a rev without them none is, which is the baseline a sheared piece is
 * weighed against. Its checksum is the positions.
 *
 *   node tests/bench/attachedSwayMicrobench.mjs [--n 40000] [--check] [--output path]
 *   node tests/bench/runKernelsVsRev.mjs --vs <rev> --only attachedSway
 */
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import * as decorationSway from '../../src/util/decorationSway.js';
import { setupSwayKernel } from './decorationSwayWasmMicrobench.mjs';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const DECOS = 40000;
const PARENTS = 400;
const DT = 1000 / 60;
const WORLD_W = 10000;
const WORLD_H = 5000;
const ON_SCREEN = 1 / 3;

/**
 * The worker with `n` decorations attached to `parents` stand-in entities, `onScreen` of the world's width in view.
 * `frame()` runs the pass once.
 * @param {{ n?: number, parents?: number, onScreen?: number, seed?: number }} [opts]
 */
export async function setupAttachedSway(opts = {}) {
  const n = opts.n ?? DECOS;
  const parents = opts.parents ?? PARENTS;
  const { worker } = await setupSwayKernel({ n });
  const rng = mulberry32(opts.seed ?? 0xa77ac4);

  for (const [key, Ctor] of [['active', Uint8Array], ['x', Float32Array], ['y', Float32Array], ['rotC', Float32Array], ['rotS', Float32Array]]) {
    Transform[key] = new Ctor(parents);
  }
  const inView = new Uint8Array(parents);
  const viewRight = WORLD_W * (opts.onScreen ?? ON_SCREEN);
  for (let p = 0; p < parents; p++) {
    Transform.active[p] = 1;
    Transform.x[p] = rng() * WORLD_W;
    Transform.y[p] = rng() * WORLD_H;
    Transform.rotC[p] = 1;
    inView[p] = Transform.x[p] < viewRight ? 1 : 0;
  }

  const D = DecorationComponent;
  const shown = [];
  for (let i = 0; i < n; i++) {
    const p = i % parents;
    const rotation = (rng() - 0.5) * 1.6;
    D.parentEntityIndex[i] = p;
    D.localX[i] = (rng() - 0.5) * 120;
    D.localY[i] = -rng() * 240;
    D.inheritParentRotation[i] = 1;
    D.baseRotC[i] = Math.cos(rotation);
    D.baseRotS[i] = Math.sin(rotation);
    D.sway[i] = decorationSway.SWAY_LOOP;
    D.swayAmplitude[i] = 0.16 + Math.abs(rotation) * 0.05;
    D.swayFrequency[i] = 0.85 + (i % 8) * 0.15;
    D.swayPhase[i] = 0;
    D.isItOnScreen[i] = inView[p];
    if (inView[p]) shown.push(i);
  }
  const onScreen = Int32Array.from(shown);
  const facing = new Float32Array(onScreen.length * 2);
  if (opts.walls) {
    // Wall pieces: unturned and still, every other one sheared where the columns exist.
    const shear = Boolean(D.ARRAY_SCHEMA.skewX);
    for (let i = 0; i < n; i++) {
      D.sway[i] = 0;
      const ky = shear && i % 2 === 0 ? ((i % 13) - 6) * 0.25 : 0;
      D.baseRotC[i] = ky === 0 ? 1 : decorationSway.skewMarkerC(0, ky);
      D.baseRotS[i] = 0;
      // As spawn hangs them: a sheared piece unturned by its parent.
      D.inheritParentRotation[i] = ky === 0 ? 1 : 0;
      if (shear) D.skewY[i] = ky;
    }
  }

  const frame = () => worker.resolveAttachedDecorations(DT);
  const checksum = () => {
    for (let k = 0; k < onScreen.length; k++) {
      facing[2 * k] = D.rotC[onScreen[k]];
      facing[2 * k + 1] = D.rotS[onScreen[k]];
    }
    if (opts.walls) return (checksumFloats(D.x, n) ^ checksumFloats(D.y, n)) >>> 0;
    return (checksumFloats(D.x, n) ^ checksumFloats(D.y, n) ^ checksumFloats(facing)) >>> 0;
  };
  return { worker, n, parents, onScreen: onScreen.length, frame, checksum };
}

/** One case, timed after short passes over the first 64 decorations (normal compiles, not OSR). */
async function timeCase(label, opts) {
  const s = await setupAttachedSway(opts);
  s.frame();
  const checksum = s.checksum();
  const { worker } = s;
  const count = worker._activeDecorationSnapshotCount;
  worker._activeDecorationSnapshotCount = 64;
  warmNormalCompile(s.frame);
  worker._activeDecorationSnapshotCount = count;
  const timed = timeIt(`${label} (${s.n} decorations, ${s.onScreen} on screen)`, s.frame, { iterations: 20, warmup: 5 });
  s.frame();
  if (s.checksum() !== checksum) throw new Error(`${label}: the timed passes wrote other values`);
  return { s, checksum, timed };
}

async function main() {
  const args = parseArgs();
  const n = Number(args.n ?? DECOS);
  if (args.check) {
    for (const walls of [false, true]) {
      const s = await setupAttachedSway({ n, walls });
      s.frame();
      console.log(`${walls ? 'walls' : 'resolve'}: checksum ${s.checksum()} decorations ${s.n} on screen ${s.onScreen}`);
    }
    return;
  }
  const resolve = await timeCase('attached sway', { n });
  const walls = await timeCase('attached walls', { n, walls: true });
  const report = {
    feature: 'attached-decoration-sway',
    functions: ['ParticleWorker.resolveAttachedDecorations'],
    decorations: resolve.s.n,
    parents: resolve.s.parents,
    onScreen: resolve.s.onScreen,
    checksum: (resolve.checksum ^ walls.checksum) >>> 0,
    cases: { resolve: resolve.timed, walls: walls.timed },
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    for (const [name, c] of Object.entries(report.cases)) {
      console.log(`${name}: ${c.opsPerSec.toFixed(1)} ops/s (${(1000 / c.opsPerSec).toFixed(3)} ms a pass)`);
    }
    console.log(`checksum ${report.checksum}`);
  }
}

if (isCli(import.meta.url)) await main();
