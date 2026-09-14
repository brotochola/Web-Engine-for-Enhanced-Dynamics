// L1: body-couple API cost. A1 = water on one static floor. A2 = water + 48 dynamic crates.
// Ceiling: skip ApplyLinearImpulse / GetWorldPointVelocity (still counted).
//
// Usage:
//   node tests/bench/liquidFunBodyCoupleMicrobench.mjs
//   node tests/bench/liquidFunBodyCoupleMicrobench.mjs --output tests/results/liquidfun-bodycouple-micro.json

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm, median, lfCounters } from './wasmLfBenchLib.mjs';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const REPS = Number(args.reps ?? 7);
const WARMUP_STEPS = Number(args.warmup ?? 25);
const MEASURE_STEPS = Number(args.steps ?? 50);
const OUTPUT = args.output ? String(args.output) : null;

function addFloor(fn, worldId) {
  const slot = fn('create_body_box')(
    worldId,
    0,
    0, 400, 0,
    2200, 130,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 0,
  );
  if (slot < 0) throw new Error(`floor ${slot}`);
}

function addCrates(fn, worldId, n) {
  for (let i = 0; i < n; i++) {
    const col = i % 8;
    const row = (i / 8) | 0;
    const slot = fn('create_body_box')(
      worldId,
      1,
      -280 + col * 80, 80 + row * 50, 0,
      18, 18,
      0, 0,
      0.35, 0.4, 0,
      0.05, 0.05, 1,
      0, 0, 0,
      0, 0,
      1, 0xffffffff,
      0, 1, 10 + i,
    );
    if (slot < 0) throw new Error(`crate ${i} ${slot}`);
  }
}

function measure(fn, setup) {
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!fn('bind_game_buffers')(128)) throw new Error('bind_game_buffers failed');
  addFloor(fn, worldId);
  if (setup.crates) addCrates(fn, worldId, setup.crates);
  if (!fn('create_particle_system')(worldId, RADIUS, 1.0, setup.cap, 0)) {
    throw new Error('create_particle_system failed');
  }
  fn('set_particle_sub_steps')(1);
  if (setup.skipImpulse) fn('set_lf_skip_body_impulse')(1);
  if (setup.skipVelocity) fn('set_lf_skip_body_velocity')(1);

  const gid = fn('create_particle_group_box')(
    -1600, -80, 1600, 360, 0, 0, 0.5, 0, 0, 0, 1, 1, 0,
  );
  if (gid < 0) throw new Error(`group ${gid}`);
  const n = fn('get_particle_count')();
  const dt = 1 / 60;
  for (let i = 0; i < WARMUP_STEPS; i++) fn('step_world')(worldId, dt, 1);

  const samples = [];
  const t0 = performance.now();
  for (let i = 0; i < MEASURE_STEPS; i++) {
    fn('step_world')(worldId, dt, 1);
    samples.push(fn('get_liquidfun_step_ms')());
  }
  const wallMs = performance.now() - t0;
  const counters = lfCounters(fn);
  fn('destroy_particle_system')();
  return {
    n,
    lfMedianMs: median(samples),
    lfMinMs: Math.min(...samples),
    lfMaxMs: Math.max(...samples),
    wallPerStepMs: wallMs / MEASURE_STEPS,
    counters,
  };
}

const SCENES = [
  { id: 'a1-static', crates: 0, cap: 12000, skipImpulse: 0, skipVelocity: 0 },
  { id: 'a1-skip-impulse', crates: 0, cap: 12000, skipImpulse: 1, skipVelocity: 0 },
  { id: 'a1-skip-impulse-vel', crates: 0, cap: 12000, skipImpulse: 1, skipVelocity: 1 },
  { id: 'a2-crates48', crates: 48, cap: 12000, skipImpulse: 0, skipVelocity: 0 },
  { id: 'a2-skip-impulse', crates: 48, cap: 12000, skipImpulse: 1, skipVelocity: 0 },
  { id: 'a2-skip-impulse-vel', crates: 48, cap: 12000, skipImpulse: 1, skipVelocity: 1 },
];

const { fn } = instantiateBox2dWasm();
const report = {
  bench: 'liquidfun-bodycouple-microbench',
  radius: RADIUS,
  reps: REPS,
  warmupSteps: WARMUP_STEPS,
  measureSteps: MEASURE_STEPS,
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
      `(min ${Math.min(...medians).toFixed(4)}, max ${Math.max(...medians).toFixed(4)}) ` +
      `impulse=${last.counters.impulse} contacts=${last.counters.bodyContacts} ` +
      `pointVel=${last.counters.pointVel} props=${last.counters.bodyProp}`,
  );
}

const a1 = report.scenes['a1-static'].lfMedianMs;
const a1Skip = report.scenes['a1-skip-impulse'].lfMedianMs;
const a1SkipBoth = report.scenes['a1-skip-impulse-vel'].lfMedianMs;
const a2 = report.scenes['a2-crates48'].lfMedianMs;
const a2Skip = report.scenes['a2-skip-impulse'].lfMedianMs;
const a2SkipBoth = report.scenes['a2-skip-impulse-vel'].lfMedianMs;
report.ceilings = {
  a1Impulse: (a1 - a1Skip) / a1,
  a1ImpulseVel: (a1 - a1SkipBoth) / a1,
  a2Impulse: (a2 - a2Skip) / a2,
  a2ImpulseVel: (a2 - a2SkipBoth) / a2,
};
console.log(
  `ceiling A1 skip-impulse ${(report.ceilings.a1Impulse * 100).toFixed(1)}% ` +
    `skip-impulse+vel ${(report.ceilings.a1ImpulseVel * 100).toFixed(1)}%`,
);
console.log(
  `ceiling A2 skip-impulse ${(report.ceilings.a2Impulse * 100).toFixed(1)}% ` +
    `skip-impulse+vel ${(report.ceilings.a2ImpulseVel * 100).toFixed(1)}%`,
);

if (OUTPUT) writeReport(OUTPUT, report);
