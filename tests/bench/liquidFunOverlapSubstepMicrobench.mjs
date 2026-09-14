// L1: OverlapAABB across particle sub-steps. Many static platforms.
// H4: overlap_aabb_calls == subSteps when reuse is off.
// H26: reuse flag (default ON) makes overlap_aabb_calls == 1; query_shape_count stays.
//
// Usage:
//   node tests/bench/liquidFunOverlapSubstepMicrobench.mjs
//   node tests/bench/liquidFunOverlapSubstepMicrobench.mjs --output tests/results/liquidfun-overlap-substep-micro.json

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm, median, lfCounters } from './wasmLfBenchLib.mjs';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const REPS = Number(args.reps ?? 7);
const WARMUP_STEPS = Number(args.warmup ?? 20);
const MEASURE_STEPS = Number(args.steps ?? 40);
const SHAPES = Number(args.shapes ?? 180);
const OUTPUT = args.output ? String(args.output) : null;

function addPlatforms(fn, worldId, n) {
  for (let i = 0; i < n; i++) {
    const col = i % 18;
    const row = (i / 18) | 0;
    const slot = fn('create_body_box')(
      worldId,
      0,
      -700 + col * 80, 80 + row * 55, 0,
      28, 14,
      0, 0,
      1, 0.6, 0,
      0, 0, 1,
      0, 0, 0,
      0, 0,
      1, 0xffffffff,
      0, 0, i,
    );
    if (slot < 0) throw new Error(`platform ${i} ${slot}`);
  }
}

function measure(fn, setup) {
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!fn('bind_game_buffers')(256)) throw new Error('bind_game_buffers failed');
  addPlatforms(fn, worldId, SHAPES);
  if (!fn('create_particle_system')(worldId, RADIUS, 1.0, 12000, 0)) {
    throw new Error('create_particle_system failed');
  }
  fn('set_particle_sub_steps')(setup.subSteps);
  fn('set_lf_reuse_query_across_substeps')(setup.reuse ? 1 : 0);

  const gid = fn('create_particle_group_box')(
    -900, -80, 900, 280, 0, 0, 0.5, 0, 0, 0, 1, 1, 0,
  );
  if (gid < 0) throw new Error(`group ${gid}`);
  const n = fn('get_particle_count')();
  const dt = 1 / 60;
  for (let i = 0; i < WARMUP_STEPS; i++) fn('step_world')(worldId, dt, 1);

  const samples = [];
  for (let i = 0; i < MEASURE_STEPS; i++) {
    fn('step_world')(worldId, dt, 1);
    samples.push(fn('get_liquidfun_step_ms')());
  }
  const counters = lfCounters(fn);
  fn('destroy_particle_system')();
  return { n, lfMedianMs: median(samples), lfMinMs: Math.min(...samples), lfMaxMs: Math.max(...samples), counters };
}

const SCENES = [
  { id: 'sub1', subSteps: 1, reuse: 0 },
  { id: 'sub2', subSteps: 2, reuse: 0 },
  { id: 'sub4', subSteps: 4, reuse: 0 },
  { id: 'sub4-reuse', subSteps: 4, reuse: 1 },
];

const { fn } = instantiateBox2dWasm();
const report = {
  bench: 'liquidfun-overlap-substep-microbench',
  radius: RADIUS,
  shapes: SHAPES,
  reps: REPS,
  scenes: {},
};

for (const scene of SCENES) {
  const medians = [];
  let last = null;
  for (let r = 0; r < REPS; r++) {
    const row = measure(fn, scene);
    medians.push(row.lfMedianMs);
    last = row;
  }
  const lfMedian = median(medians);
  report.scenes[scene.id] = {
    particleCount: last.n,
    lfMedianMs: lfMedian,
    lfMinMs: Math.min(...medians),
    lfMaxMs: Math.max(...medians),
    worldMediansMs: medians,
    counters: last.counters,
  };
  console.log(
    `${scene.id} (n=${last.n}): lf median ${lfMedian.toFixed(4)} ms ` +
      `overlap=${last.counters.overlapAabb} shapes=${last.counters.queryShapes} ` +
      `contacts=${last.counters.bodyContacts}`,
  );
}

const s4 = report.scenes.sub4.lfMedianMs;
const s4r = report.scenes['sub4-reuse'].lfMedianMs;
report.ceilings = {
  sub4VsSub1: (report.scenes.sub4.lfMedianMs - report.scenes.sub1.lfMedianMs) / report.scenes.sub1.lfMedianMs,
  reuseVsSub4: (s4 - s4r) / s4,
};
console.log(
  `sub4 vs sub1 +${(report.ceilings.sub4VsSub1 * 100).toFixed(1)}%  ` +
    `H14 reuse vs sub4 ${(report.ceilings.reuseVsSub4 * 100).toFixed(1)}%`,
);

if (OUTPUT) writeReport(OUTPUT, report);
