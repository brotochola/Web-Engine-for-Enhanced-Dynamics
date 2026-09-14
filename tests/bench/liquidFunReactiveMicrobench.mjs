// L1: first step_world after SPRING|REACTIVE create (SolveReactive PairExists cliff).
//
// Usage:
//   node tests/bench/liquidFunReactiveMicrobench.mjs
//   node tests/bench/liquidFunReactiveMicrobench.mjs --output tests/results/liquidfun-reactive-micro.json

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm, median } from './wasmLfBenchLib.mjs';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const HALF = Number(args.half ?? 280);
const REPS = Number(args.reps ?? 9);
const WARMUP = Number(args.warmup ?? 2);
const OUTPUT = args.output ? String(args.output) : null;
const LF_SPRING = 1 << 6;
const LF_REACTIVE = 1 << 11;
const FLAGS = args['spring-only'] ? LF_SPRING : LF_SPRING | LF_REACTIVE;

function timeFirstStep(fn) {
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
  if (!createParticleSystem(worldId, RADIUS, 1.0, 8000, 0)) throw new Error('create_particle_system failed');
  setSubSteps(1);

  const gid = createParticleGroupBox(
    -HALF, -HALF, HALF, HALF, 0, FLAGS, 0.5, 0, 0, 0, 1, 1, 0,
  );
  if (gid < 0) throw new Error(`group ${gid}`);
  const n = getParticleCount();

  const t0 = performance.now();
  stepWorld(worldId, 1 / 60, 1);
  const wallMs = performance.now() - t0;
  const lfMs = getLfMs();
  destroyParticleSystem();
  return { wallMs, lfMs, n };
}

const { fn } = instantiateBox2dWasm();
for (let i = 0; i < WARMUP; i++) timeFirstStep(fn);

const walls = [];
const lfs = [];
let last = null;
for (let r = 0; r < REPS; r++) {
  const row = timeFirstStep(fn);
  walls.push(row.wallMs);
  lfs.push(row.lfMs);
  last = row;
}
const wallMed = median(walls);
const lfMed = median(lfs);
console.log(
  `SolveReactive first step (${args['spring-only'] ? 'SPRING' : 'SPRING|REACTIVE'} n=${last.n}): lf median ${lfMed.toFixed(3)} ms ` +
    `(min ${Math.min(...lfs).toFixed(3)}, max ${Math.max(...lfs).toFixed(3)}) wall ${wallMed.toFixed(3)} ms n=${REPS}`,
);

if (OUTPUT) {
  writeReport(OUTPUT, {
    bench: 'liquidfun-reactive-microbench',
    particleCount: last.n,
    half: HALF,
    radius: RADIUS,
    reps: REPS,
    lfMedianMs: lfMed,
    lfMinMs: Math.min(...lfs),
    lfMaxMs: Math.max(...lfs),
    wallMedianMs: wallMed,
    lfSamplesMs: lfs.slice().sort((a, b) => a - b),
  });
}
