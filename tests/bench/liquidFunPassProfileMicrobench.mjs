// L1: pass-bucket split on an lfstress-like mix.
// water|tensile + spring|staticPressure + solid|rigid ice. subSteps=1.
//
// Usage:
//   node tests/bench/liquidFunPassProfileMicrobench.mjs
//   node tests/bench/liquidFunPassProfileMicrobench.mjs --workers 4

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm, median, lfPasses, LF_PASS_NAMES } from './wasmLfBenchLib.mjs';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 8);
const REPS = Number(args.reps ?? 5);
const WARMUP_STEPS = Number(args.warmup ?? 25);
const MEASURE_STEPS = Number(args.steps ?? 40);
const OUTPUT = args.output ? String(args.output) : null;
const WORKERS = String(args.workers ?? '1,4')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);

const WATER = 0;
const TENSILE = 1 << 3;
const SPRING = 1 << 6;
const STATIC_PRESSURE = 1 << 8;
const SOLID = 1 << 0;
const RIGID = 1 << 1;

function addFloor(fn, worldId) {
  const slot = fn('create_body_box')(
    worldId, 0, 2500, 2600, 0, 2400, 130, 0, 0, 1, 0.6, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, 0,
  );
  if (slot < 0) throw new Error(`floor ${slot}`);
}

function measure(fn, workerCount, opts = {}) {
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, workerCount);
  if (!worldId) throw new Error('create_world failed');
  if (!fn('bind_game_buffers')(16)) throw new Error('bind_game_buffers failed');
  addFloor(fn, worldId);
  if (!fn('create_particle_system')(worldId, RADIUS, 1.0, 15000, 0)) {
    throw new Error('create_particle_system failed');
  }
  fn('set_particle_sub_steps')(1);
  // Same AABBs as LiquidFunStressScene (radius 8, default spacing).
  if (fn('create_particle_group_box')(400, 500, 2800, 1100, 0, WATER | TENSILE, 0.5, 0, 0, 0, 1, 1, 0) < 0) {
    throw new Error('water group');
  }
  if (fn('create_particle_group_box')(3660, 655, 4600, 945, 0, SPRING | STATIC_PRESSURE, 0.5, 0, 0, 0, 1, 1, 0) < 0) {
    throw new Error('spring group');
  }
  if (fn('create_particle_group_box')(3020, 300, 3380, 500, 0, WATER, 0.5, 0, 0, 0, 1, 1, SOLID | RIGID) < 0) {
    throw new Error('ice group');
  }
  const n = fn('get_particle_count')();
  const dt = 1 / 60;
  for (let i = 0; i < WARMUP_STEPS; i++) fn('step_world')(worldId, dt, 1);
  if (opts.reuseContacts) fn('set_lf_reuse_particle_contacts')(1);
  if (opts.skipPass != null) fn('set_lf_skip_pass')(opts.skipPass, 1);

  const samples = [];
  const passSamples = LF_PASS_NAMES.map(() => []);
  let contacts = 0;
  for (let i = 0; i < MEASURE_STEPS; i++) {
    fn('step_world')(worldId, dt, 1);
    samples.push(fn('get_liquidfun_step_ms')());
    const { passMs } = lfPasses(fn);
    LF_PASS_NAMES.forEach((name, idx) => passSamples[idx].push(passMs[name]));
    contacts = fn('get_lf_particle_contact_count')();
  }
  fn('destroy_particle_system')();
  const lfMedianMs = median(samples);
  const passes = {};
  LF_PASS_NAMES.forEach((name, idx) => {
    const ms = median(passSamples[idx]);
    passes[name] = { ms, pct: lfMedianMs > 0 ? ms / lfMedianMs : 0 };
  });
  return {
    n,
    workerCount,
    boundWorkers: fn('get_lf_worker_count')(),
    lfMedianMs,
    lfMinMs: Math.min(...samples),
    lfMaxMs: Math.max(...samples),
    particleContacts: contacts,
    passes,
  };
}

const { fn } = instantiateBox2dWasm();
const report = {
  bench: 'liquidfun-pass-profile-microbench',
  radius: RADIUS,
  reps: REPS,
  worlds: {},
};

const CEILING = args.reuse === true || args.reuse === '1';
const SKIP = args['skip-pass'] != null ? Number(args['skip-pass']) : null;

for (const workers of WORKERS) {
  const rows = [];
  for (let r = 0; r < REPS; r++) {
    rows.push(measure(fn, workers, { reuseContacts: CEILING, skipPass: Number.isFinite(SKIP) ? SKIP : null }));
  }
  const last = rows[rows.length - 1];
  const lfMedian = median(rows.map((r) => r.lfMedianMs));
  const passMed = {};
  for (const name of LF_PASS_NAMES) {
    const ms = median(rows.map((r) => r.passes[name].ms));
    passMed[name] = { ms, pct: lfMedian > 0 ? ms / lfMedian : 0 };
  }
  const winner = LF_PASS_NAMES.reduce((a, b) => (passMed[b].ms > passMed[a].ms ? b : a));
  report.worlds[`workers${workers}`] = {
    particleCount: last.n,
    boundWorkers: last.boundWorkers,
    lfMedianMs: lfMedian,
    lfMinMs: Math.min(...rows.map((r) => r.lfMedianMs)),
    lfMaxMs: Math.max(...rows.map((r) => r.lfMedianMs)),
    particleContacts: last.particleContacts,
    passes: passMed,
    winner,
  };
  const parts = LF_PASS_NAMES.map((n) => `${n} ${(passMed[n].pct * 100).toFixed(1)}%`).join('  ');
  console.log(
    `workers=${workers} (bound ${last.boundWorkers}) n=${last.n} contacts=${last.particleContacts} ` +
      `lf ${lfMedian.toFixed(3)} ms  winner=${winner}  ${parts}`,
  );
}

if (OUTPUT) writeReport(OUTPUT, report);
