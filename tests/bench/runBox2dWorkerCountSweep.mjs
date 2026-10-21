// E-04b: sweep `physics.numberOfPhysicsWorkers` at a FIXED Box2D thread pool.
//
// Why this exists. The 2026-10-01 pool experiment (4 threads -> 2) is recorded as a
// REGRESSION: physics 8.671 -> 10.875 ms, +26.2 %, 8/8 worse. But it changed the
// POOL, and while it measured the frame it also removed spin - the trace shows three
// Box2D threads at 1000 ms/s with 67.8 % of them inside `wasm-function[102]`, which
// DEVLOG disassembled on 1 October and again on 14 October as the Emscripten pthread
// mailbox, not the solver.
//
// Those are different things and the old sitting cannot tell them apart:
//   - does the SOLVER need the cores?      (pool 4 -> 2 says yes)
//   - how much of the number is SPIN?      (nobody measured)
//
// `numberOfPhysicsWorkers` is the knob that changes the solver's task decomposition while
// leaving the pool alone, so sweeping it separates them: a step that gets worse while
// CPU time falls is losing to less parallelism, not paying more spin.
//
// Primary: physics_STEP_MS. Load: BODY_COUNT and AWAKE_COUNT, both within 5 %.
// This is a CONFIG sweep, not a tree A/B: every arm runs the same tree, so no
// override worktree is involved and the order is round-robin to keep drift off any
// one arm.
//
// E-04b in docs/internal/EXECUTION_PLAN.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { upperMedian } from './benchMath.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'tests/results/e04b-worker-count');
fs.mkdirSync(OUT, { recursive: true });

const ARGS = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = ARGS.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = ARGS[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const COUNTS = String(flag('counts', '1,2,3,4'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
const ROUNDS = Number(flag('rounds', 2));
const WARMUP = String(flag('warmup-ms', 10000));
const DURATION = String(flag('duration-ms', 10000));
const SCENE = String(flag('scene', '/demos/ballsScene/ballsScene.js'));
const EXPORT = String(flag('scene-export', 'BallsScene'));

function runArm(count, round) {
  const out = path.join(OUT, `wc${count}-r${round}.json`);
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'tests/bench/runIntegratedWorkerBenchmark.mjs'),
      '--src',
      '--scene', SCENE,
      '--scene-export', EXPORT,
      '--warmup-ms', WARMUP,
      '--duration-ms', DURATION,
      '--no-collect-detailed-stats',
      '--query', `numberOfPhysicsWorkers=${count}`,
      '--output', out,
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  const byType = rep.workersByType || {};
  const pick = (t) => {
    const arr = byType[t] || [];
    const avg = arr[0]?.statsSamplesAverage || {};
    return { stepMs: avg.STEP_MS ?? null, avg };
  };
  // Record EVERY worker, not just physics. The whole premise of this sweep is that
  // fewer Box2D workers frees cores for everyone else - and the 2026-10-01 pool
  // experiment saw exactly that (renderer -10.4 %, pre-render -9.9 % when the pool
  // went 4 -> 2). If the bystanders do NOT get cheaper here, then reducing worker
  // count is a pure loss with no offsetting gain, and that is the answer.
  const all = {};
  for (const [type, arr] of Object.entries(byType)) {
    let worst = null;
    for (const w of arr) {
      const ms = w.statsSamplesAverage?.STEP_MS;
      if (Number.isFinite(ms) && (worst === null || ms > worst)) worst = ms;
    }
    all[type] = worst;
  }
  const phys = pick('physics');
  return { count, round, all, ...phys };
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? upperMedian(v) : null;
};

console.log(`E-04b numberOfPhysicsWorkers sweep: counts=${COUNTS.join(',')} rounds=${ROUNDS}`);
console.log(`scene=${SCENE}  warmup=${WARMUP}ms measure=${DURATION}ms  stats off\n`);

const arms = [];
for (let r = 0; r < ROUNDS; r++) {
  for (const c of COUNTS) {
    process.stdout.write(`  round ${r + 1}/${ROUNDS}  workers=${c} ... `);
    const a = runArm(c, r);
    arms.push(a);
    console.log(`physics ${a.stepMs?.toFixed(3)} ms  bodies ${a.avg.BODY_COUNT}  awake ${a.avg.AWAKE_COUNT}`);
  }
}

const rows = [];
for (const c of COUNTS) {
  const mine = arms.filter((a) => a.count === c);
  const steps = mine.map((a) => a.stepMs);
  const bodies = mine.map((a) => a.avg.BODY_COUNT);
  const awake = mine.map((a) => a.avg.AWAKE_COUNT);
  rows.push({
    numberOfPhysicsWorkers: c,
    stepMsMedian: median(steps),
    stepMsSamples: steps,
    bodyCountMedian: median(bodies),
    awakeCountMedian: median(awake),
    // Max STEP_MS across every worker of each kind, per round, then the median.
    allWorkersMedian: Object.fromEntries(
      Object.keys(arms[0]?.all || {}).map((kind) => [
        kind,
        median(mine.map((a) => a.all?.[kind])),
      ]),
    ),
  });
}

const base = rows.find((r) => r.numberOfPhysicsWorkers === COUNTS[COUNTS.length - 1]) || rows[rows.length - 1];
console.log('\n--- physics STEP_MS by numberOfPhysicsWorkers ---');
for (const r of rows) {
  const pct = base.stepMsMedian && r.stepMsMedian
    ? ((r.stepMsMedian - base.stepMsMedian) / base.stepMsMedian) * 100
    : null;
  console.log(
    `  workers=${r.numberOfPhysicsWorkers}  ${r.stepMsMedian?.toFixed(3)} ms` +
      (pct == null ? '' : `  ${pct >= 0 ? '+' : ''}${pct.toFixed(1)} % vs workers=${base.numberOfPhysicsWorkers}`) +
      `  bodies=${r.bodyCountMedian}  awake=${r.awakeCountMedian}`,
  );
}

// Load gate, per HOW_WE_MEASURE: a mismatch above 5 % means the arms are not comparable.
const bodies = rows.map((r) => r.bodyCountMedian).filter((x) => Number.isFinite(x) && x > 0);
const awake = rows.map((r) => r.awakeCountMedian).filter((x) => Number.isFinite(x) && x > 0);
const spread = (xs) => (xs.length ? (Math.max(...xs) - Math.min(...xs)) / Math.max(...xs) : 0);
const bodySpread = spread(bodies);
const awakeSpread = spread(awake);
console.log(`\nload spread: BODY_COUNT ${(bodySpread * 100).toFixed(1)} %   AWAKE_COUNT ${(awakeSpread * 100).toFixed(1)} %`);
console.log(bodySpread <= 0.05 && awakeSpread <= 0.05
  ? 'pair is valid (load within 5 %)'
  : 'PAIR INVALID: load did not close, do not read the deltas');

// The offset question: does dropping Box2D workers make the OTHER workers cheaper?
// If physics gets 2x worse and nothing else moves, there is no trade to make.
const kinds = Object.keys(rows[rows.length - 1].allWorkersMedian || {});
if (kinds.length) {
  console.log('\n--- max STEP_MS per worker kind (offsetting effect) ---');
  const header = kinds.map((k) => k.padEnd(11)).join('');
  console.log(`  workers     ${header}`);
  for (const r of rows) {
    const cells = kinds
      .map((k) => {
        const v = r.allWorkersMedian[k];
        return (v == null ? '-' : v.toFixed(2)).padEnd(11);
      })
      .join('');
    console.log(`  ${String(r.numberOfPhysicsWorkers).padEnd(11)} ${cells}`);
  }
}

fs.writeFileSync(
  path.join(OUT, 'summary.json'),
  JSON.stringify(
    {
      name: 'E-04b',
      scene: SCENE,
      rounds: ROUNDS,
      warmupMs: Number(WARMUP),
      durationMs: Number(DURATION),
      rows,
      bodyCountSpreadPct: +(bodySpread * 100).toFixed(2),
      awakeCountSpreadPct: +(awakeSpread * 100).toFixed(2),
      loadClosed: bodySpread <= 0.05 && awakeSpread <= 0.05,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
console.log(`\nwrote ${path.join(OUT, 'summary.json')}`);