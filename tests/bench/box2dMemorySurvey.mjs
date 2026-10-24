// BM-10 / BM-11 (docs/internal/BOX2D_MEMORY_PLAN.md): how much Box2D memory each kind of scene needs.
//
// Runs scenes one at a time through runIntegratedWorkerBenchmark.mjs with `?physicsMemoryMB=N`
// and reads the physics worker's MEMORY_PEAK_KB (the break: static data, stacks, the highest heap
// address reached; it only rises). Recommended size = peak x 1.25, rounded up to the ladder below.
// A run fails when it does not boot, the fatal overlay appears, or physics stops stepping.
//
//   node tests/bench/box2dMemorySurvey.mjs                    every scene at 512 MB
//   node tests/bench/box2dMemorySurvey.mjs --only BallsScene  some of them (labels, comma list)
//   node tests/bench/box2dMemorySurvey.mjs --verify <summary.json>
//        every scene at its recommended size, plus the --expect-fail runs (Label@MB,...) which must
//        stop with the out-of-memory error
//   --jobs N        runs at once (default 1); --churn-ms N  window of the churn scenes (default 60 s)
//
// Memory, not time: detailed stats stay on (contact and joint counts), and the machine need not be
// quiet, so runs can go in parallel. Each one commits its Box2D size plus a browser: mind free commit.
// A scene that spawns over time reaches less in a slowed window; its physics FPS is in the row.
// Other sessions' benches still lose CPU to it, so check none is running first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
const LADDER_MB = [16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048];

const SCENES = [
  { label: 'SteadyCombatScene', path: '/tests/bench/stressScenes/steadyCombatScene.js', exportName: 'SteadyCombatScene' },
  { label: 'BallsScene', path: '/demos/ballsScene/ballsScene.js', exportName: 'BallsScene' },
  ...[1, 8, 16, 32].map((n) => ({
    label: `BallsScene w${n}`,
    path: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
    query: `numberOfPhysicsWorkers=${n}`,
  })),
  { label: 'BallsHeavyStressScene', path: '/tests/bench/stressScenes/ballsHeavyStressScene.js', exportName: 'BallsHeavyStressScene' },
  { label: 'WaterAndBoxesScene', path: '/demos/waterAndBoxesScene/waterAndBoxesScene.js', exportName: 'WaterAndBoxesScene' },
  { label: 'PredatorScene', path: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene' },
  { label: 'BoidsScene', path: '/demos/boidsScene/boidsScene.js', exportName: 'BoidsScene' },
  { label: 'MovedBodiesAwakeScene', path: '/tests/bench/stressScenes/movedBodiesStillScene.js', exportName: 'MovedBodiesAwakeScene' },
  { label: 'MovedBodiesStillScene', path: '/tests/bench/stressScenes/movedBodiesStillScene.js', exportName: 'MovedBodiesStillScene' },
  { label: 'CompoundFixtureSpatialScene', path: '/tests/bench/stressScenes/compoundFixtureSpatialScene.js', exportName: 'CompoundFixtureSpatialScene' },
  { label: 'CompoundGeometryDirtyScene', path: '/tests/bench/stressScenes/compoundGeometryDirtyScene.js', exportName: 'CompoundGeometryDirtyScene', durationMs: 60000 },
  { label: 'DestructibleTerrainScene', path: '/demos/destructibleTerrainScene/destructibleTerrainScene.js', exportName: 'DestructibleTerrainScene' },
  { label: 'ConstraintBoxScene', path: '/demos/constraintBoxScene/constraintBoxScene.js', exportName: 'ConstraintBoxScene' },
  { label: 'WeldBreakScene', path: '/demos/weldBreakScene/weldBreakScene.js', exportName: 'WeldBreakScene' },
  { label: 'MamushkaDigScene', path: '/demos/mamushkaDigScene/mamushkaDigScene.js', exportName: 'MamushkaDigScene' },
  { label: 'GearChainScene', path: '/demos/gearChainScene/gearChainScene.js', exportName: 'GearChainScene' },
  { label: 'UChainScene', path: '/demos/uChainScene/uChainScene.js', exportName: 'UChainScene' },
  { label: 'LiquidFunStressScene', path: '/tests/bench/stressScenes/liquidFunStressScene.js', exportName: 'LiquidFunStressScene' },
  { label: 'LiquidFunQueryStressScene', path: '/tests/bench/stressScenes/liquidFunQueryStressScene.js', exportName: 'LiquidFunQueryStressScene' },
  { label: 'BadPiggiesScene', path: '/demos/badPiggiesScene/badPiggiesScene.js', exportName: 'BadPiggiesScene' },
  { label: 'SpawnStormScene', path: '/tests/bench/stressScenes/spawnStormScene.js', exportName: 'SpawnStormScene', durationMs: 60000 },
  { label: 'QueryChurnScene', path: '/tests/bench/stressScenes/queryChurnScene.js', exportName: 'QueryChurnScene', durationMs: 60000 },
];

const ARGS = process.argv.slice(2);
function flag(name, fallback) {
  const i = ARGS.indexOf(`--${name}`);
  return i < 0 ? fallback : ARGS[i + 1];
}

/** The ladder size at or above `mb`. */
export function ladderAtLeast(mb) {
  return LADDER_MB.find((step) => step >= mb) ?? null;
}

/** Recommended physics.wasmMemoryMB for a measured peak: peak x 1.25, rounded up to the ladder. */
export function recommendedMB(peakMB) {
  return ladderAtLeast(peakMB * 1.25);
}

/** Run the benchmark runner; resolves with its exit code and output. Kills the tree on timeout. */
function runRunner(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // The runner's Chrome is its child: take the whole tree.
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

async function runOne(scene, mb, outDir, log) {
  const warmupMs = Number(flag('warmup-ms', 3000));
  const durationMs = scene.durationMs ? Number(flag('churn-ms', scene.durationMs)) : Number(flag('duration-ms', 5000));
  const slug = `${scene.label.replace(/\W+/g, '_')}_${mb}mb`;
  const outPath = path.join(outDir, `${slug}.json`);
  fs.rmSync(outPath, { force: true });
  const query = [`physicsMemoryMB=${mb}`, scene.query].filter(Boolean).join('&');
  const t0 = Date.now();
  const res = await runRunner(
    [RUNNER, '--src', '--scene', scene.path, '--scene-export', scene.exportName, '--query', query,
      '--warmup-ms', String(warmupMs), '--duration-ms', String(durationMs), '--output', outPath],
    // The page ends a run whose worker died while booting; this only backs that up.
    warmupMs + durationMs + 120000,
  );
  const row = { label: scene.label, mb, durationMs, seconds: Math.round((Date.now() - t0) / 1000) };
  if (res.timedOut || res.code !== 0 || !fs.existsSync(outPath)) {
    const fatal = /Fatal engine error while the scene booted: ([^\n]*)/.exec(res.output);
    row.status = res.timedOut ? 'timeout' : fatal ? 'boot-error' : 'runner-error';
    row.error = (fatal ? fatal[1] : res.output.trim().split('\n').slice(-3).join(' | ')).slice(0, 300);
  } else {
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const physics = report.workers.find((w) => w.type === 'physics' || /physics/i.test(w.id || ''));
    const end = physics?.statsEnd || {};
    row.peakMB = +((end.MEMORY_PEAK_KB || 0) / 1024).toFixed(1);
    row.liveHighWaterMB = +((end.HEAP_HIGH_WATER_KB || 0) / 1024).toFixed(1);
    row.liveMB = +((end.HEAP_USED_KB || 0) / 1024).toFixed(1);
    row.bodies = end.BODY_COUNT ?? 0;
    row.joints = end.JOINT_COUNT ?? 0;
    row.contacts = end.COUNTER_CONTACTS ?? 0;
    row.physicsFps = +(physics?.averageFPS ?? 0).toFixed(1);
    row.ranMB = report.metadata?.physicsMemoryMB ?? null;
    row.fatalError = report.metadata?.fatalError ?? null;
    row.status = row.fatalError ? 'fatal' : !(row.physicsFps >= 1) ? 'stalled' : row.ranMB !== mb ? 'wrong-size' : 'ok';
    if (row.status === 'ok') row.recommendedMB = recommendedMB(row.peakMB);
  }
  const line =
    `${row.label.padEnd(28)} ${String(mb).padStart(5)} MB  ${row.status.padEnd(12)}` +
    (row.status === 'ok' || row.status === 'fatal' || row.status === 'stalled'
      ? ` peak ${String(row.peakMB).padStart(7)} MB  live-hw ${String(row.liveHighWaterMB).padStart(7)} MB  ` +
        `bodies ${row.bodies}  joints ${row.joints}  contacts ${row.contacts}  fps ${row.physicsFps}` +
        (row.recommendedMB ? `  -> ${row.recommendedMB} MB` : '')
      : '') +
    (row.fatalError || row.error ? `  ${(row.fatalError || row.error).slice(0, 160)}` : '') +
    `  (${row.seconds} s)`;
  console.log(line);
  if (log) fs.appendFileSync(log, `${line}\n`);
  return row;
}

/** Run `tasks` (functions returning promises) `jobs` at a time; `onRow` sees each row as it lands. */
async function pool(tasks, jobs, onRow) {
  const rows = [];
  let next = 0;
  async function lane() {
    while (next < tasks.length) {
      const row = await tasks[next++]();
      rows.push(row);
      onRow(rows);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, tasks.length)) }, lane));
  return rows;
}

async function main() {
  const outDir = path.resolve(flag('out', path.join(ROOT, 'tests/results/box2d-memory-survey')));
  fs.mkdirSync(outDir, { recursive: true });
  const log = flag('log', null);
  const jobs = Number(flag('jobs', 1));
  const only = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pick = (scenes) => (only.length ? scenes.filter((s) => only.includes(s.label)) : scenes);
  const verifyFrom = flag('verify', null);
  // Saved after every row, so a stopped survey keeps what it measured.
  const save = (file, extra) => (rows) =>
    fs.writeFileSync(path.join(outDir, file), JSON.stringify({ when: new Date().toISOString(), ...extra, rows }, null, 2) + '\n');

  if (verifyFrom) {
    const summary = JSON.parse(fs.readFileSync(verifyFrom, 'utf8'));
    const tasks = [];
    for (const scene of pick(SCENES)) {
      const surveyed = summary.rows.find((r) => r.label === scene.label && r.recommendedMB);
      if (surveyed) tasks.push(async () => ({ ...(await runOne(scene, surveyed.recommendedMB, outDir, log)), expect: 'ok' }));
    }
    for (const spec of (flag('expect-fail', '') || '').split(',').filter(Boolean)) {
      const [label, mb] = spec.split('@');
      const scene = SCENES.find((s) => s.label === label);
      if (!scene) throw new Error(`--expect-fail: unknown scene ${label}`);
      tasks.push(async () => ({ ...(await runOne(scene, Number(mb), outDir, log)), expect: 'out-of-memory' }));
    }
    const rows = await pool(tasks, jobs, save('verify.json', {}));
    const bad = rows.filter((r) =>
      r.expect === 'ok'
        ? r.status !== 'ok'
        : !/Box2D ran out of memory/.test(`${r.fatalError || ''} ${r.error || ''}`),
    );
    console.log(bad.length ? `VERIFY FAILED: ${bad.map((r) => `${r.label}@${r.mb} ${r.status}`).join(', ')}` : 'verify: every run as expected');
    process.exitCode = bad.length ? 1 : 0;
    return;
  }

  const mb = Number(flag('mb', 512));
  const file = `summary-${mb}mb.json`;
  await pool(pick(SCENES).map((scene) => () => runOne(scene, mb, outDir, log)), jobs, save(file, { mb }));
  console.log(`summary: ${path.join(outDir, file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
