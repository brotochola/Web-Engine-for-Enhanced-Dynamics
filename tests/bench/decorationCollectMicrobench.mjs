#!/usr/bin/env node
/**
 * Kernel: pre-render's decoration collect (PreRenderWorker.collectVisibleDecorations) on a real worker: each visible
 * decoration's sort key, and its row through collectRenderable into the main collector with the pose the emit reads.
 * Half the decorations are world-owned, half attached to one of PARENTS entities (stand-in Transform columns, as the
 * E-179c test gives the particle worker). Two cases, one process:
 *
 *   collect  no layer y-sorts; attached ones spread over the parents and the visible list in no order, as Predator's
 *            grass is against the camera.
 *   ysort    the entities layer y-sorts, so each key counts: the parents have sprites (a quarter anchored at their
 *            centre, an eighth with a zIndex), and each one's decorations are next to each other in the list, as
 *            addDecoration spawns them.
 *
 * The checksum is the collected poses, which no key change moves (the keys' values are the tests' to hold:
 * decorationSortOffset.test.js); `keys` is their own checksum, for information.
 *
 *   node tests/bench/decorationCollectMicrobench.mjs [--n 40000] [--check] [--output path]
 *   node tests/bench/runKernelsVsRev.mjs --vs <rev> --only decorationCollect,decorationCollectYSort
 */
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { zSortBand } from '../../src/util/sortIndexByKey.js';
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
 * Sprites for the parents: feet-anchored, a quarter anchored at their centre on a 64 x 96 frame, an eighth with zIndex
 * 1; the frame each last drew is known (entityLastTextureId), as it is for an entity drawn before.
 */
function bindParentSprites(pre, parents) {
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(parents)), parents);
  const sr = SpriteRenderer;
  for (let p = 0; p < parents; p++) {
    sr.active[p] = 1;
    sr.renderVisible[p] = 1;
    sr.spritesheetId[p] = 1;
    sr.scaleX[p] = 1;
    sr.scaleY[p] = 1;
    sr.anchorX[p] = 0.5;
    sr.anchorY[p] = p % 4 === 0 ? 0.5 : 1;
    sr.spriteRotC[p] = 1;
    sr.inheritTransformRotation[p] = 1;
    sr.zIndex[p] = p % 8 === 0 ? 1 : 0;
  }
  pre.entityLastTextureId = new Uint16Array(parents);
  pre.frameWidth = Uint16Array.of(64);
  pre.frameHeight = Uint16Array.of(96);
  pre._spriteSortArrays = null;
  pre._zBand = zSortBand(WORLD_H);
}

/**
 * A pre-render worker with `n` visible decorations, half of them attached, and an empty main collector of `n` rows.
 * `frame()` runs one collect from an empty collector and returns how many rows it wrote.
 * @param {{ n?: number, parents?: number, attachedShare?: number, seed?: number, ySort?: boolean }} [opts]
 */
export async function setupDecorationCollect(opts = {}) {
  const n = opts.n ?? DECOS;
  const parents = opts.parents ?? PARENTS;
  const attached = Math.round(n * (opts.attachedShare ?? 0.5));
  const ySort = Boolean(opts.ySort);
  const rng = mulberry32(opts.seed ?? 0xdec0c0);

  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: { ySorting: ySort }, lighting: {} }, true);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');

  DecorationComponent.initializeArrays(new SharedArrayBuffer(DecorationComponent.getBufferSize(n)), n);
  bindParents(parents, rng);
  if (ySort) bindParentSprites(pre, parents);
  const dc = DecorationComponent;
  for (let d = 0; d < n; d++) {
    dc.active[d] = 1;
    dc.innerZ[d] = Math.floor(rng() * 17) - 8;
    if (d < attached) {
      // y-sort: each parent's decorations in a run, as addDecoration spawns them; else spread over the parents.
      dc.parentEntityIndex[d] = ySort ? Math.floor((d * parents) / attached) : d % parents;
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

  // The particle worker's visible list: in spawn order under y-sort, else shuffled.
  const SlotArray = PoolSlotArray(n);
  const visible = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  const order = Array.from({ length: n }, (_, k) => k);
  if (!ySort) {
    for (let k = n - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      const t = order[k];
      order[k] = order[j];
      order[j] = t;
    }
  }
  visible[0] = n;
  visible.set(order, 1);

  pre.maxDecorations = n;
  pre.visibleDecorationsData = visible;
  pre.renderQueueEnabled = true;
  pre._decorationZoomAlpha = 1;
  pre._customLayerCollectors = null;
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
  /** The poses the collect wrote. */
  const checksum = () => {
    const rows = pre._renderableCount;
    return (checksumFloats(pre._collectPx, rows) ^ checksumFloats(pre._collectPy, rows)) >>> 0;
  };
  const keys = () => checksumFloats(pre._renderableY, pre._renderableCount);
  return { pre, n, attached, visible, frame, checksum, keys };
}

/** One case: its collect timed after short ones (a normal compile, not OSR), and what it wrote. */
async function timeCase(name, opts) {
  const s = await setupDecorationCollect(opts);
  const rows = s.frame();
  if (rows !== s.n) throw new Error(`${name}: collected ${rows} of ${s.n} decorations`);
  const checksum = s.checksum();
  const keys = s.keys();
  const visible = s.visible;
  visible[0] = 64;
  warmNormalCompile(s.frame);
  visible[0] = s.n;
  const timed = timeIt(`decoration ${name} (${s.n} visible, ${s.attached} attached)`, s.frame, { iterations: 20, warmup: 5 });
  if (s.frame() !== rows || s.checksum() !== checksum || s.keys() !== keys) throw new Error(`${name}: the timed collects wrote other rows`);
  return { s, checksum, keys, timed };
}

async function main() {
  const args = parseArgs();
  const n = Number(args.n ?? DECOS);
  if (args.check) {
    for (const [name, ySort] of [['collect', false], ['ysort', true]]) {
      const s = await setupDecorationCollect({ n, ySort });
      const rows = s.frame();
      console.log(`${name}: checksum ${s.checksum()} keys ${s.keys()} rows ${rows} attached ${s.attached}`);
    }
    return;
  }
  const plain = await timeCase('collect', { n });
  const ysort = await timeCase('ysort', { n, ySort: true });
  const report = {
    feature: 'decoration-collect',
    functions: ['PreRenderWorker.collectVisibleDecorations', 'PreRenderWorker.collectRenderable', 'PreRenderWorker._writeRenderable'],
    decorations: n,
    attached: plain.s.attached,
    checksum: (plain.checksum ^ ysort.checksum) >>> 0,
    keys: { collect: plain.keys, ysort: ysort.keys },
    cases: { collect: plain.timed, ysort: ysort.timed },
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    for (const [name, c] of Object.entries(report.cases)) {
      console.log(`${name}: ${c.opsPerSec.toFixed(1)} ops/s (${(1000 / c.opsPerSec).toFixed(3)} ms a collect)`);
    }
    console.log(`checksum ${report.checksum} keys ${JSON.stringify(report.keys)}`);
  }
}

if (isCli(import.meta.url)) await main();
