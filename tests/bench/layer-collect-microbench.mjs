// L1 microbench: collectRenderable's layerMask -> sprite-queue-layerId dispatch.
// baseline = old loop (0..Layer.count, Layer.isLiquidFunDensityLayer + Layer.hasSpriteQueue
// per bit) vs optimized = bit-scan over precomputed Layer._spriteQueueBits.
//
// Usage:
//   node tests/bench/layer-collect-microbench.mjs
//   node tests/bench/layer-collect-microbench.mjs --renderables 20000 --frames 500 --output tests/results/layer-collect-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';
import { Layer } from '../../src/core/Layer.js';

const BUILT_IN_LAYERS = {
  BACKGROUND: {},
  DECALS: {},
  CASTED_SHADOWS: {},
  ENTITIES: {},
  LIGHTING: {},
};

/** Pre-refactor loop shape (0..Layer.count, two Layer method calls per set bit). */
function collectBaseline(mask, out) {
  let n = 0;
  for (let layerId = 0; layerId < Layer.count; layerId++) {
    if (!(mask & (1 << layerId))) continue;
    if (Layer.isLiquidFunDensityLayer(layerId)) continue;
    if (!Layer.hasSpriteQueue(layerId)) continue;
    out[n++] = layerId;
  }
  return n;
}

/** Current collectRenderable shape: bit-scan over the precomputed sprite-queue mask. */
function collectOptimized(mask, out) {
  let n = 0;
  let bits = mask & Layer._spriteQueueBits;
  while (bits) {
    const lsb = bits & -bits;
    out[n++] = 31 - Math.clz32(lsb);
    bits ^= lsb;
  }
  return n;
}

export function runLayerCollectMicrobench(cliArgs = parseArgs()) {
  const RENDERABLES = Number(cliArgs.renderables ?? 20000);
  const FRAMES = Number(cliArgs.frames ?? 500);
  const SEED = Number(cliArgs.seed ?? 0x1ee7);
  const outputPath = cliArgs.output ? String(cliArgs.output) : null;

  Layer.reset();
  Layer.initializeFromConfig(
    {
      water: { zIndex: 3 },
      canopy: { zIndex: 4 },
      fx: { zIndex: 5 },
      oil: { shader: { fragment: 'f', densitySource: 1 } }, // LAYER_DENSITY_SOURCE.LIQUID_FUN
      fire: { shader: { fragment: 'f', compute: 's' } },
    },
    BUILT_IN_LAYERS,
    true
  );

  const entities = Layer.entitiesMask();
  const waterBit = 1 << Layer.getId('water');
  const canopyBit = 1 << Layer.getId('canopy');
  const fxBit = 1 << Layer.getId('fx');
  const oilBit = 1 << Layer.getId('oil'); // density — never a sprite-queue bit
  const fireBit = 1 << Layer.getId('fire'); // compute — never a sprite-queue bit

  const rng = mulberry32(SEED);
  const masks = new Uint16Array(RENDERABLES);
  for (let i = 0; i < RENDERABLES; i++) {
    const r = rng();
    // Realistic mix: mostly plain ENTITIES, some single custom sprite layer,
    // a few multi-layer (sprite + density/compute bits mixed in), matching how
    // setLayer/setLayers/emit build masks in real scenes.
    if (r < 0.7) masks[i] = entities;
    else if (r < 0.82) masks[i] = waterBit;
    else if (r < 0.9) masks[i] = canopyBit;
    else if (r < 0.95) masks[i] = fxBit;
    else if (r < 0.98) masks[i] = entities | fireBit; // draw ENTITIES, feed compute
    else masks[i] = waterBit | oilBit; // sprite layer + density subscription
  }

  // Correctness gate: same output set for every mask.
  const outA = new Uint16Array(Layer.MAX_LAYERS);
  const outB = new Uint16Array(Layer.MAX_LAYERS);
  for (let i = 0; i < RENDERABLES; i++) {
    const nA = collectBaseline(masks[i], outA);
    const nB = collectOptimized(masks[i], outB);
    if (nA !== nB) {
      throw new Error(`LAYER-COLLECT count mismatch at ${i}: baseline=${nA} opt=${nB} mask=${masks[i]}`);
    }
    for (let k = 0; k < nA; k++) {
      if (outA[k] !== outB[k]) {
        throw new Error(`LAYER-COLLECT set mismatch at ${i}: baseline=[${outA.slice(0, nA)}] opt=[${outB.slice(0, nB)}]`);
      }
    }
  }
  console.log(`Correctness OK (${RENDERABLES} masks, identical sprite-layer sets)`);

  const out = new Uint16Array(Layer.MAX_LAYERS);
  const baseline = timeIt(
    'collectRenderable layer dispatch (baseline: 0..Layer.count loop)',
    (n) => {
      const frames = Math.max(1, n | 0);
      let sink = 0;
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < RENDERABLES; i++) sink += collectBaseline(masks[i], out);
      }
      if (sink === -1) console.log(sink);
    },
    { iterations: FRAMES, warmup: Math.min(20, FRAMES) }
  );

  const optimized = timeIt(
    'collectRenderable layer dispatch (optimized: bit-scan _spriteQueueBits)',
    (n) => {
      const frames = Math.max(1, n | 0);
      let sink = 0;
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < RENDERABLES; i++) sink += collectOptimized(masks[i], out);
      }
      if (sink === -1) console.log(sink);
    },
    { iterations: FRAMES, warmup: Math.min(20, FRAMES) }
  );

  Layer.reset();

  const report = {
    name: 'layer-collect',
    hyp: 'LAYER-COLLECT',
    seed: SEED,
    renderables: RENDERABLES,
    frames: FRAMES,
    correctness: { ok: true },
    timings: { baseline, optimized },
    ratios: { overall: optimized.ms / baseline.ms },
  };

  console.log(`Ratio opt/baseline: ${report.ratios.overall.toFixed(3)} (<1 = faster)`);
  if (outputPath) writeReport(outputPath, report);
  return report;
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  runLayerCollectMicrobench();
}
