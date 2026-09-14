// L1: step with ~10k particles spaced > diameter (almost no contacts).
// Isolates ComputeSweptCloudAABB + BuildGrid vs contact-heavy L2.
//
// Usage:
//   node tests/bench/liquidFunSparseStepMicrobench.mjs
//   node tests/bench/liquidFunSparseStepMicrobench.mjs --output tests/results/liquidfun-sparse-step-micro.json

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm, median } from './wasmLfBenchLib.mjs';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const SPACING = Number(args.spacing ?? 80);
const HALF = Number(args.half ?? 4000);
const REPS = Number(args.reps ?? 7);
const WARMUP_STEPS = Number(args.warmup ?? 8);
const MEASURE_STEPS = Number(args.steps ?? 40);
const OUTPUT = args.output ? String(args.output) : null;

function measure(fn) {
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const destroyParticleSystem = fn('destroy_particle_system');
  const getParticleCount = fn('get_particle_count');
  const setSubSteps = fn('set_particle_sub_steps');
  const stepWorld = fn('step_world');
  const getLfMs = fn('get_liquidfun_step_ms');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!bindGameBuffers(16)) throw new Error('bind_game_buffers failed');
  if (!createParticleSystem(worldId, RADIUS, 1.0, 16000, 0)) throw new Error('create_particle_system failed');
  setSubSteps(1);

  const gid = createParticleGroupBox(-HALF, -HALF, HALF, HALF, SPACING, 0, 0.5, 0, 0, 0, 1, 1, 0);
  if (gid < 0) throw new Error(`group ${gid}`);
  const n = getParticleCount();
  const dt = 1 / 60;
  for (let i = 0; i < WARMUP_STEPS; i++) stepWorld(worldId, dt, 1);

  const samples = [];
  const t0 = performance.now();
  for (let i = 0; i < MEASURE_STEPS; i++) {
    stepWorld(worldId, dt, 1);
    samples.push(getLfMs());
  }
  const wallMs = performance.now() - t0;
  destroyParticleSystem();
  return {
    n,
    lfMedianMs: median(samples),
    lfMinMs: Math.min(...samples),
    lfMaxMs: Math.max(...samples),
    wallPerStepMs: wallMs / MEASURE_STEPS,
  };
}

const { fn } = instantiateBox2dWasm();
const worlds = [];
for (let r = 0; r < REPS; r++) worlds.push(measure(fn));
const lfMed = median(worlds.map((w) => w.lfMedianMs));
const wallMed = median(worlds.map((w) => w.wallPerStepMs));
const last = worlds[worlds.length - 1];
console.log(
  `sparse step (n=${last.n} spacing=${SPACING}): lf median ${lfMed.toFixed(4)} ms ` +
    `(min ${Math.min(...worlds.map((w) => w.lfMedianMs)).toFixed(4)}, ` +
    `max ${Math.max(...worlds.map((w) => w.lfMedianMs)).toFixed(4)}, worlds=${REPS}) ` +
    `wall ${wallMed.toFixed(4)} ms/step`,
);

if (OUTPUT) {
  writeReport(OUTPUT, {
    bench: 'liquidfun-sparse-step-microbench',
    particleCount: last.n,
    spacing: SPACING,
    half: HALF,
    radius: RADIUS,
    reps: REPS,
    lfMedianMs: lfMed,
    lfMinMs: Math.min(...worlds.map((w) => w.lfMedianMs)),
    lfMaxMs: Math.max(...worlds.map((w) => w.lfMedianMs)),
    wallPerStepMedianMs: wallMed,
    worldMediansMs: worlds.map((w) => w.lfMedianMs),
  });
}
