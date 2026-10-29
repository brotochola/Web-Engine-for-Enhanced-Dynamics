#!/usr/bin/env node
/**
 * E-172: ParticleEmitter.emitGpu called the way games call it per entity per tick: many small calls (one or two
 * particles) from four emit sites, each with its own config shape, on one GPU_PARTICLES layer's ring (no renderer).
 * Times the shipped call: run it before and after a change to `_emit` (one process each, alternated).
 *
 *   node tests/bench/emitGpuCallMicrobench.mjs [--calls 4096] [--running] [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/emitGpuCallMicrobench.mjs [--args '{"running":true}']
 *
 * A round is a frame's worth of calls; between rounds the sim clock moves 16.67 ms (lockstep), so records end as in a
 * game and the ring does not lap live ones. `running` starts the sim clock instead (Time._startSimClock), as a running
 * scene has it, and each round notes a frame's wall time as a worker's frame loop does (Time._noteFrameWall, E-174,
 * where the tree has it).
 * Reports the median ms of 50 rounds of `calls` calls, ns a call, and a checksum (the records the calls wrote).
 * Browser-safe (chromeKernel.mjs runs `run`); the Node helpers load only from the command line.
 */
import { GpuParticles } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { LAYER_KIND } from '../../src/util/configDefaults.js';
import { GPU_RING } from '../../src/util/gpuParticleLayout.js';
import { seededRandom } from '../../src/util/utils.js';

const LAYER = 'sparks';

function setup(running) {
  const layers = { [LAYER]: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 1 << 18 } };
  Layer.reset();
  Layer.initializeFromConfig(layers, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 0;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(7, 'emitGpuCall');
  Time._advanceSimNow(1000);
  if (running) Time._startSimClock();
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

/** Short calls first, so the timed loop is a normal TurboFan compile, not OSR (microbenchHelpers' warmNormalCompile). */
function warm(short, calls = 3000) {
  for (let i = 0; i < calls; i++) short();
}

export function run({ calls = 4096, running = false, rounds = 50, reps = 7 } = {}) {
  setup(running);
  const noteFrame = typeof Time._noteFrameWall === 'function';
  const frame = () => {
    if (!running) Time._advanceSimNow(16.67);
    else if (noteFrame) Time._noteFrameWall(performance.timeOrigin + performance.now());
  };
  try {
    const checksum = emitRound(calls);
    frame();
    warm(() => {
      emitRound(64);
      frame();
    });
    const times = [];
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      for (let k = 0; k < rounds; k++) {
        emitRound(calls);
        frame();
      }
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const ms = times[(times.length / 2) | 0];
    const overflow = Atomics.load(GpuParticles.layerOf(LAYER).rings[0].header, GPU_RING.OVERFLOW);
    return { feature: 'emit-gpu-call', calls, running, checksum, ms, rounds, nsPerCall: (ms / rounds / calls) * 1e6, overflow };
  } finally {
    GpuParticles.reset();
    Layer.reset();
    Time.unbind();
  }
}

const fromCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (fromCli) {
  const { parseArgs, writeReport } = await import('./microbenchHelpers.mjs');
  const args = parseArgs();
  const report = run({ calls: Number(args.calls ?? 4096), running: !!args.running });
  console.log(`~${report.nsPerCall.toFixed(1)} ns an emitGpu call (${report.calls} calls a round, clock ${report.running ? 'running' : 'stepped'})`);
  console.log(`checksum ${report.checksum}`);
  if (args.output) writeReport(String(args.output), report);
}
