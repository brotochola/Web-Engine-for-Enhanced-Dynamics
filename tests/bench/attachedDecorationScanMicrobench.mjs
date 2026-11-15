#!/usr/bin/env node
/**
 * Kernel (E-334): the particle worker's per-frame attached-decoration step, refreshActiveDecorationSnapshot then
 * resolveAttachedDecorations as update() calls them, on a real particle worker (setupSwayKernel's boot and pool) holding
 * Predator's 20 000 grass decorations, none of them attached. The pool's list header has its counters (a 64-byte lock
 * buffer, as sceneSharedBuffers allocates), so a frame whose list did not change keeps the snapshot as it is.
 *
 * Case `none`: every decoration world-owned (Predator). Case `few`: the first 64 grass decorations despawned and 64
 * attached ones spawned in their place under 16 stand-in parents (half of them on screen, swaying), so the pass has
 * work and a revision that skips it, or resolves the wrong ones, writes another checksum.
 *
 * The checksum is every decoration's x, y, rotC and rotS and the snapshot's count.
 *
 *   node tests/bench/attachedDecorationScanMicrobench.mjs [--n 20000] [--check] [--output path]
 *   node tests/bench/runKernelsVsRev.mjs --vs <rev> --only attachedScanNone,attachedScanFew
 */
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { SWAY_LOOP } from '../../src/util/decorationSway.js';
import { setupSwayKernel } from './decorationSwayWasmMicrobench.mjs';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const DECOS = 20000;
const ATTACHED = 64;
const PARENTS = 16;
const DT = 1000 / 60;

/**
 * The worker with `n` grass decorations, `attached` of them replaced by decorations hung from stand-in parents.
 * `frame()` runs the snapshot refresh and the attached pass once.
 * @param {{ n?: number, attached?: number, seed?: number }} [opts]
 */
export async function setupAttachedScan(opts = {}) {
  const n = opts.n ?? DECOS;
  const attached = opts.attached ?? 0;
  const { worker } = await setupSwayKernel({ n, listCounters: true });
  const rng = mulberry32(opts.seed ?? 0x5ca9);
  const D = DecorationComponent;
  // A second worker boot in this process starts on the first one's epoch (the same count of spawns): copy afresh.
  worker._decoSnapshotEpoch = -1;
  worker.refreshActiveDecorationSnapshot();

  for (const [key, Ctor] of [['active', Uint8Array], ['x', Float32Array], ['y', Float32Array], ['rotC', Float32Array], ['rotS', Float32Array]]) {
    Transform[key] = new Ctor(PARENTS);
  }
  for (let p = 0; p < PARENTS; p++) {
    Transform.active[p] = 1;
    Transform.x[p] = rng() * 10000;
    Transform.y[p] = rng() * 5000;
    const a = (rng() - 0.5) * 2;
    Transform.rotC[p] = Math.cos(a);
    Transform.rotS[p] = Math.sin(a);
  }
  if (attached > 0) {
    const snap = worker._activeDecorationSnapshot;
    const victims = Array.from(snap.subarray(0, attached));
    for (const i of victims) DecorationPool.despawn(i);
    for (let k = 0; k < attached; k++) {
      const i = DecorationPool.spawn({
        parent: k % PARENTS,
        localX: (rng() - 0.5) * 60,
        localY: -rng() * 80,
        scaleX: 0.5,
        scaleY: 0.5,
        rotation: (rng() - 0.5) * 0.6,
        sway: true,
        swayAmplitude: 0.1,
        swayFrequency: 1,
      });
      if (i < 0) throw new Error('the decoration pool filled up');
      D.sway[i] = SWAY_LOOP;
      D.isItOnScreen[i] = k % 2;
    }
  }
  worker.refreshActiveDecorationSnapshot();
  if (worker._activeDecorationSnapshotCount !== n) throw new Error(`the snapshot holds ${worker._activeDecorationSnapshotCount} of ${n}`);

  const frame = () => {
    worker.refreshActiveDecorationSnapshot();
    worker.resolveAttachedDecorations(DT);
  };
  const checksum = () =>
    (checksumFloats(D.x, n) ^ checksumFloats(D.y, n) ^ checksumFloats(D.rotC, n) ^ checksumFloats(D.rotS, n)
      ^ worker._activeDecorationSnapshotCount) >>> 0;
  return { worker, n, attached, frame, checksum };
}

/** One case, timed after short passes over the first 64 decorations (normal compiles, not OSR). */
async function timeCase(label, opts) {
  const s = await setupAttachedScan(opts);
  s.frame();
  const checksum = s.checksum();
  const { worker } = s;
  const count = worker._activeDecorationSnapshotCount;
  worker._activeDecorationSnapshotCount = 64;
  warmNormalCompile(s.frame);
  worker._activeDecorationSnapshotCount = count;
  const timed = timeIt(`${label} (${s.n} decorations, ${s.attached} attached)`, s.frame, { iterations: 200, warmup: 5 });
  s.frame();
  if (s.checksum() !== checksum) throw new Error(`${label}: the timed passes wrote other values`);
  return { s, checksum, timed };
}

async function main() {
  const args = parseArgs();
  const n = Number(args.n ?? DECOS);
  if (args.check) {
    for (const attached of [0, ATTACHED]) {
      const s = await setupAttachedScan({ n, attached });
      for (let f = 0; f < 3; f++) s.frame();
      console.log(`${attached ? 'few' : 'none'}: checksum ${s.checksum()} decorations ${s.n} attached ${s.attached}`);
    }
    return;
  }
  const none = await timeCase('attached scan, none attached', { n });
  const few = await timeCase('attached scan, few attached', { n, attached: ATTACHED });
  const report = {
    feature: 'attached-decoration-scan',
    functions: ['ParticleWorker.refreshActiveDecorationSnapshot', 'ParticleWorker.resolveAttachedDecorations'],
    decorations: n,
    attached: ATTACHED,
    checksum: (none.checksum ^ few.checksum) >>> 0,
    cases: { none: none.timed, few: few.timed },
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    for (const [name, c] of Object.entries(report.cases)) {
      console.log(`${name}: ${c.opsPerSec.toFixed(1)} ops/s (${(1000 / c.opsPerSec).toFixed(4)} ms a frame)`);
    }
    console.log(`checksum ${report.checksum}`);
  }
}

if (isCli(import.meta.url)) await main();
