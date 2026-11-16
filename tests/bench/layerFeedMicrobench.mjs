#!/usr/bin/env node
/**
 * Kernel (E-354): the layer feed lists' add and remove (src/util/layerFeed.js syncParticleFeed and syncColliderFeed), as
 * particle births and deaths and body spawns and despawns call them, on lists Layer.initializeFromConfig allocates: a
 * LiquidFun density layer's particle feed and a compute layer's body feed, each --cap long (default 8192). One op is a
 * churn pass: every one of --live members (default 6000, the list that full) leaves in a shuffled order and joins
 * again, a quarter of the joins with a second layer bit (the density layer and a compute layer that also packs
 * particles), as a steady stream of short-lived particles keeps the lists near full. The membership and the leave order
 * are fixed by the seed, so every revision runs the same calls.
 *
 * The checksum is the lists' contents in their order after the passes, and their counts: a revision that keeps the
 * order the swap-remove gives writes the same.
 *
 *   node tests/bench/layerFeedMicrobench.mjs [--cap 8192] [--live 6000] [--check] [--output path]
 *   node tests/bench/runKernelsVsRev.mjs --vs <rev> --only layerFeedParticles,layerFeedBodies
 */
import { Layer } from '../../src/core/layer.js';
import { Collider } from '../../src/components/collider.js';
import { LAYER_DENSITY_SOURCE } from '../../src/util/configDefaults.js';
import { syncColliderFeed, syncParticleFeed } from '../../src/util/layerFeed.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const CAP = 8192;
const LIVE = 6000;
const BUILT_IN = { decals: {}, castedShadows: {}, entities: {}, lighting: {} };

/**
 * The layers and `live` members joined. `pass()` churns every member once; `checksum()` reads the lists.
 * @param {{ kind: 'particles'|'bodies', cap?: number, live?: number, seed?: number }} opts
 */
export function setupLayerFeed(opts) {
  const cap = opts.cap ?? CAP;
  const live = Math.min(opts.live ?? LIVE, cap);
  const particles = opts.kind === 'particles';
  Layer.reset();
  if (!particles) Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(live * 4)), live * 4);
  const layers = particles
    ? {
      oil: { shader: { fragment: 'f', densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN, maxParticles: cap } },
      heat: { shader: { fragment: 'f', compute: 's', maxBodies: 8, maxParticles: cap } },
    }
    : {
      sim: { shader: { fragment: 'f', compute: 's', maxBodies: cap } },
      fire: { shader: { fragment: 'f', compute: 's', maxBodies: cap } },
    };
  Layer.initializeFromConfig(layers, BUILT_IN, true);
  const ids = Object.keys(layers).map((name) => Layer.getId(name));
  const one = 1 << ids[0];
  const both = one | (1 << ids[1]);
  const sync = particles ? syncParticleFeed : syncColliderFeed;
  const lists = particles ? Layer._particleFeedIndices : Layer._feedIndices;
  const counts = particles ? Layer._particleFeedCount : Layer._feedCount;

  // Members: pool indices spread over four times the list (a pool larger than the feed), each with its mask.
  const rng = mulberry32(opts.seed ?? (particles ? 0x1fee : 0xb0d1));
  const member = new Int32Array(live);
  const mask = new Int32Array(live);
  const taken = new Uint8Array(live * 4);
  for (let k = 0; k < live; k++) {
    let i;
    do i = (rng() * live * 4) | 0; while (taken[i]);
    taken[i] = 1;
    member[k] = i;
    mask[k] = rng() < 0.25 ? both : one;
    sync(i, 0, mask[k]);
  }
  // The leave order: a shuffle of the members.
  const order = Int32Array.from({ length: live }, (_, k) => k);
  for (let k = live - 1; k > 0; k--) {
    const j = (rng() * (k + 1)) | 0;
    const t = order[k];
    order[k] = order[j];
    order[j] = t;
  }

  /** Members `from` .. `to` of the leave order leave, then join again in the same order. */
  const churn = (from, to) => {
    for (let k = from; k < to; k++) {
      const m = order[k];
      sync(member[m], mask[m], 0);
    }
    for (let k = from; k < to; k++) {
      const m = order[k];
      sync(member[m], 0, mask[m]);
    }
  };
  const pass = () => churn(0, live);
  const checksum = () => {
    let sum = 0;
    for (const id of ids) sum = (sum ^ checksumInts(lists[id], counts[id]) ^ Math.imul(counts[id], 0x9e3779b1)) >>> 0;
    return sum;
  };
  return { cap, live, ids, pass, churn, checksum };
}

/** One case, timed after short churns of 32 members (normal compiles, not OSR). */
function timeCase(label, opts) {
  const s = setupLayerFeed(opts);
  warmNormalCompile(() => s.churn(0, 32), 300);
  s.pass();
  const checksum = s.checksum();
  const timed = timeIt(`${label} (${s.live} of ${s.cap}, churned)`, s.pass, { iterations: 2, warmup: 1 });
  return { checksum, timed };
}

function main() {
  const args = parseArgs();
  const cap = Number(args.cap ?? CAP);
  const live = Number(args.live ?? LIVE);
  if (args.check) {
    for (const kind of ['particles', 'bodies']) {
      const s = setupLayerFeed({ kind, cap, live });
      s.pass();
      s.pass();
      console.log(`${kind}: checksum ${s.checksum()} (${s.live} of ${s.cap})`);
    }
    return;
  }
  const particles = timeCase('particle feed churn', { kind: 'particles', cap, live });
  const bodies = timeCase('body feed churn', { kind: 'bodies', cap, live });
  const report = {
    feature: 'layer-feed-lists',
    functions: ['syncParticleFeed', 'syncColliderFeed'],
    cap,
    live,
    checksum: (particles.checksum ^ bodies.checksum) >>> 0,
    cases: { particles: particles.timed, bodies: bodies.timed },
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    for (const [name, c] of Object.entries(report.cases)) {
      console.log(`${name}: ${c.opsPerSec.toFixed(2)} passes/s (${(1000 / c.opsPerSec).toFixed(2)} ms a pass)`);
    }
    console.log(`checksum ${report.checksum}`);
  }
}

if (isCli(import.meta.url)) main();
