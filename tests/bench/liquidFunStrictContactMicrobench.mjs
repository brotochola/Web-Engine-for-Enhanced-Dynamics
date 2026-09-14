// L1: strictContactCheck qsort path (H28 fixture). Floor + two walls, corner puddle.
//
// Usage:
//   node tests/bench/liquidFunStrictContactMicrobench.mjs
//   node tests/bench/liquidFunStrictContactMicrobench.mjs --output tests/results/liquidfun-strict-contact-micro.json

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm, median, lfCounters } from './wasmLfBenchLib.mjs';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const REPS = Number(args.reps ?? 7);
const WARMUP_STEPS = Number(args.warmup ?? 30);
const MEASURE_STEPS = Number(args.steps ?? 50);
const OUTPUT = args.output ? String(args.output) : null;

function addTank(fn, worldId) {
  const floor = fn('create_body_box')(
    worldId, 0, 0, 400, 0, 900, 130, 0, 0, 1, 0.6, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, 0,
  );
  const left = fn('create_body_box')(
    worldId, 0, -780, 120, 0, 80, 280, 0, 0, 1, 0.6, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, 1,
  );
  const right = fn('create_body_box')(
    worldId, 0, 780, 120, 0, 80, 280, 0, 0, 1, 0.6, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, 2,
  );
  if (floor < 0 || left < 0 || right < 0) throw new Error('tank bodies');
}

function measure(fn, strict) {
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!fn('bind_game_buffers')(16)) throw new Error('bind_game_buffers failed');
  addTank(fn, worldId);
  if (!fn('create_particle_system')(worldId, RADIUS, 1.0, 10000, strict ? 1 : 0)) {
    throw new Error('create_particle_system failed');
  }
  fn('set_particle_sub_steps')(1);
  const gid = fn('create_particle_group_box')(
    -700, 40, 200, 260, 0, 0, 0.5, 0, 0, 0, 1, 1, 0,
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

const { fn } = instantiateBox2dWasm();
const report = {
  bench: 'liquidfun-strict-contact-microbench',
  radius: RADIUS,
  reps: REPS,
  scenes: {},
};

for (const strict of [false, true]) {
  const id = strict ? 'strict-on' : 'strict-off';
  const medians = [];
  let last = null;
  for (let r = 0; r < REPS; r++) {
    const row = measure(fn, strict);
    medians.push(row.lfMedianMs);
    last = row;
  }
  const lfMedian = median(medians);
  report.scenes[id] = {
    particleCount: last.n,
    lfMedianMs: lfMedian,
    lfMinMs: Math.min(...medians),
    lfMaxMs: Math.max(...medians),
    worldMediansMs: medians,
    counters: last.counters,
  };
  console.log(
    `${id} (n=${last.n}): lf median ${lfMedian.toFixed(4)} ms ` +
      `contacts=${last.counters.bodyContacts} impulse=${last.counters.impulse}`,
  );
}

const off = report.scenes['strict-off'].lfMedianMs;
const on = report.scenes['strict-on'].lfMedianMs;
report.ceilings = { strictOnVsOff: (on - off) / off };
console.log(`strict-on vs off +${(report.ceilings.strictOnVsOff * 100).toFixed(1)}% (upper bound for H16)`);

if (OUTPUT) writeReport(OUTPUT, report);
