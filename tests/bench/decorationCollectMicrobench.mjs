#!/usr/bin/env node
/**
 * Kernel: pre-render's decoration collect (PreRenderWorker.collectVisibleDecorations) on a real worker: each visible
 * decoration's sort key, and its row through collectRenderable into the main collector with the pose the emit reads.
 * Half the decorations are world-owned, half attached to one of PARENTS entities (stand-in Transform columns, as the
 * E-179c test gives the particle worker), and the visible list is in no order, as Predator's grass is.
 *
 * Every decoration keeps its columns' defaults beyond these, so a revision that reads one more column in the key's
 * loop writes the same keys: the checksum (the keys and the collected poses) holds across both sides.
 *
 *   node tests/bench/decorationCollectMicrobench.mjs [--n 40000] [--check] [--output path]
 *   node tests/bench/runKernelsVsRev.mjs --vs <rev> --only decorationCollect
 */
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker } from './workerHarness.mjs';

const DECOS = 40000;
const PARENTS = 400;
const WORLD_W = 10000;
const WORLD_H = 5000;

/** Stand-in Transform columns for `parents` entities (no physics, no scene): what the collect reads of a parent. */
function bindParents(parents, rng) {
  for (const [key, Ctor] of [['active', Uint8Array], ['x', Float32Array], ['y', Float32Array], ['rotC', Float32Array], ['rotS', Float32Array]]) {
    Transform[key] = new Ctor(parents);
  }
  for (let p = 0; p < parents; p++) {
    Transform.active[p] = 1;
    Transform.x[p] = rng() * WORLD_W;
    Transform.y[p] = rng() * WORLD_H;
    Transform.rotC[p] = 1;
  }
}

/**
 * A pre-render worker with `n` visible decorations, half of them attached, and an empty main collector of `n` rows.
 * `frame()` runs one collect from an empty collector and returns how many rows it wrote.
 * @param {{ n?: number, parents?: number, attachedShare?: number, seed?: number }} [opts]
 */
export async function setupDecorationCollect(opts = {}) {
  const n = opts.n ?? DECOS;
  const parents = opts.parents ?? PARENTS;
  const attached = Math.round(n * (opts.attachedShare ?? 0.5));
  const rng = mulberry32(opts.seed ?? 0xdec0c0);

  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');

  DecorationComponent.initializeArrays(new SharedArrayBuffer(DecorationComponent.getBufferSize(n)), n);
  bindParents(parents, rng);
  const dc = DecorationComponent;
  for (let d = 0; d < n; d++) {
    dc.active[d] = 1;
    dc.innerZ[d] = Math.floor(rng() * 17) - 8;
    if (d < attached) {
      dc.parentEntityIndex[d] = d % parents;
      dc.localX[d] = (rng() - 0.5) * 200;
      dc.localY[d] = -rng() * 300;
      dc.inheritParentRotation[d] = 1;
    } else {
      dc.x[d] = rng() * WORLD_W;
      dc.y[d] = rng() * WORLD_H;
    }
    const a = (rng() - 0.5) * 0.05;
    dc.rotC[d] = Math.cos(a);
    dc.rotS[d] = Math.sin(a);
  }

  // The particle worker's visible list, every decoration in a shuffled order.
  const SlotArray = PoolSlotArray(n);
  const visible = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  const order = Array.from({ length: n }, (_, k) => k);
  for (let k = n - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    const t = order[k];
    order[k] = order[j];
    order[j] = t;
  }
  visible[0] = n;
  visible.set(order, 1);

  pre.maxDecorations = n;
  pre.visibleDecorationsData = visible;
  pre.renderQueueEnabled = true;
  pre._decorationZoomAlpha = 1;
  pre.renderQueueMaxItems = n;
  pre._renderableY = new Float32Array(n);
  pre._renderableType = new Uint8Array(n);
  pre._renderableIndex = new Int32Array(n);
  pre._collectPx = new Float32Array(n);
  pre._collectPy = new Float32Array(n);
  pre._collectRotC = new Float32Array(n);
  pre._collectRotS = new Float32Array(n);
  pre._renderableCount = 0;

  const frame = () => {
    pre._renderableCount = 0;
    pre.visibleDecorationsCount = 0;
    pre.collectVisibleDecorations();
    return pre._renderableCount;
  };
  /** The keys and the poses the collect wrote. */
  const checksum = () => {
    const rows = pre._renderableCount;
    return (checksumFloats(pre._renderableY, rows) ^ checksumFloats(pre._collectPx, rows) ^ checksumFloats(pre._collectPy, rows)) >>> 0;
  };
  return { pre, n, attached, visible, frame, checksum };
}

async function main() {
  const args = parseArgs();
  const s = await setupDecorationCollect({ n: Number(args.n ?? DECOS) });
  const rows = s.frame();
  if (rows !== s.n) throw new Error(`collected ${rows} of ${s.n} decorations`);
  const checksum = s.checksum();
  if (args.check) {
    console.log(`checksum ${checksum} rows ${rows} attached ${s.attached}`);
    return;
  }
  // Normal compiles, not OSR: short collects over the first 64 visible decorations.
  const visible = s.visible;
  visible[0] = 64;
  warmNormalCompile(s.frame);
  visible[0] = s.n;
  const cases = {
    collect: timeIt(`decoration collect (${s.n} visible, ${s.attached} attached)`, s.frame, { iterations: 20, warmup: 5 }),
  };
  if (s.frame() !== rows || s.checksum() !== checksum) throw new Error('the timed collects wrote other rows');
  const report = {
    feature: 'decoration-collect',
    functions: ['PreRenderWorker.collectVisibleDecorations', 'PreRenderWorker.collectRenderable', 'PreRenderWorker._writeRenderable'],
    decorations: s.n,
    attached: s.attached,
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} ${cases.collect.opsPerSec.toFixed(1)} ops/s (${(1000 / cases.collect.opsPerSec).toFixed(3)} ms a collect)`);
}

if (isCli(import.meta.url)) await main();
