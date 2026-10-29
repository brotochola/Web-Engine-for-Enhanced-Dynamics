#!/usr/bin/env node
/**
 * E-172: ParticleEmitter.emitGpu called the way games call it per entity per tick: many small calls (one or two
 * particles) from four emit sites, each with its own config shape, on one GPU_PARTICLES layer's ring (Node, no
 * renderer). Times the shipped call: run it before and after a change to `_emit` (one process each, alternated).
 *
 *   node tests/bench/emitGpuCallMicrobench.mjs [--calls 4096] [--output path]
 *
 * Reports the median ms of 50 rounds of `calls` calls, ns a call, and a checksum (the records the calls wrote).
 */
import { GpuParticles } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { LAYER_KIND } from '../../src/util/configDefaults.js';
import { seededRandom } from '../../src/util/utils.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const LAYER = 'sparks';

function setup() {
  const layers = { [LAYER]: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 1 << 17 } };
  Layer.reset();
  Layer.initializeFromConfig(layers, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 0;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(7, 'emitGpuCall');
  Time._advanceSimNow(1000);
}

/** Four emit sites, each with a config object of its own shape, reused call after call as games do. */
const trail = { layer: LAYER, count: 1, x: 0, y: 0, vx: 0, vy: -1, lifespan: 900, scale: { from: 1, to: 0.2 } };
const spark = {
  layer: LAYER, count: 2, x: 0, y: 0, angleXY: { min: 0, max: 360 }, speed: { min: 1, max: 3 }, lifespan: 400,
  alpha: { from: 1, to: 0 }, tint: { from: 0xffffff, to: 0xff8800 },
};
const smoke = { layer: LAYER, count: 1, x: 0, y: 0, speed: 0.5, angleXY: 270, drag: 0.3, lifespan: 1500, delay: { min: 0, max: 16 } };
const dust = { layer: LAYER, count: 1, x: 0, y: 0, vx: { min: -1, max: 1 }, vy: 0, z: 0, vz: 2, gravity: 0.2, lifespan: 700 };
const SITES = [trail, spark, smoke, dust];

function emitRound(calls) {
  let written = 0;
  for (let i = 0; i < calls; i++) {
    const cfg = SITES[i & 3];
    cfg.x = (i * 37) % 1920;
    cfg.y = (i * 53) % 1080;
    written += ParticleEmitter.emitGpu(cfg);
  }
  return written;
}

export function runEmitGpuCallMicrobench({ calls = 4096 } = {}) {
  setup();
  try {
    const checksum = emitRound(calls);
    warmNormalCompile(() => emitRound(64));
    const round = timeIt('emitGpu calls', () => emitRound(calls), { iterations: 50 });
    const nsPerCall = (round.ms / round.iterations / calls) * 1e6;
    console.log(`~${nsPerCall.toFixed(1)} ns an emitGpu call (${calls} calls a round)`);
    console.log(`checksum ${checksum}`);
    return { feature: 'emit-gpu-call', calls, checksum, nsPerCall, cases: { calls: round } };
  } finally {
    GpuParticles.reset();
    Layer.reset();
    Time.unbind();
  }
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const report = runEmitGpuCallMicrobench({ calls: Number(args.calls ?? 4096) });
  if (args.output) writeReport(String(args.output), report);
}
