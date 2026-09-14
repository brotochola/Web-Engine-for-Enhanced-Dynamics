#!/usr/bin/env node
/**
 * Runs the integrated worker benchmark N times (headed, throttle mitigation on)
 * and prints median / mean / stdev / CV for physics + spatial worker stats.
 *
 * Usage:
 *   node tests/bench/run-headed-median.mjs
 *   node tests/bench/run-headed-median.mjs --runs 6 --json-out tests/results/research-spatial-headed.json
 *   node tests/bench/run-headed-median.mjs --scene /demos/carScene/carScene.js --scene-export CarScene
 *
 * Leave the Chromium window visible; do not minimize during measurement.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';

function formatLoadPct(stepMs) {
  return `${workerLoadPct(stepMs).toFixed(0)}%`;
}

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');

function parseArgs(argv) {
  const out = {
    runs: 5,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    jsonOut: null,
    scene: null,
    sceneExport: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || DEFAULT_WARMUP_MS;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || DEFAULT_DURATION_MS;
    else if (a === '--json-out' && argv[i + 1]) out.jsonOut = path.resolve(argv[++i]);
    else if (a === '--scene' && argv[i + 1]) out.scene = argv[++i];
    else if (a === '--scene-export' && argv[i + 1]) out.sceneExport = argv[++i];
  }
  return out;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdevSample(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function cv(arr) {
  const m = mean(arr);
  return m > 0 ? stdevSample(arr) / m : 0;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function minMax(arr) {
  const s = [...arr].sort((x, y) => x - y);
  return { min: s[0], max: s[s.length - 1] };
}

function fmtPct(x) {
  return `${(100 * x).toFixed(1)}%`;
}

function summaryForSeries(values, runs) {
  if (values.length !== runs || values.length === 0) return null;
  return {
    median: median(values),
    mean: mean(values),
    stdev: stdevSample(values),
    cv: cv(values),
    ...minMax(values),
  };
}

function recordSpatialFromReport(j, spatialAcc) {
  for (const w of j.workers || []) {
    if (!w.id.startsWith('spatial')) continue;
    if (!spatialAcc[w.id]) {
      spatialAcc[w.id] = { fps: [], stepMs: [], neighborMs: [], gridCells: [] };
    }
    spatialAcc[w.id].fps.push(w.averageFPS || 0);
    const s = w.statsSamplesAverage;
    if (s) {
      spatialAcc[w.id].stepMs.push(s.STEP_MS || 0);
      spatialAcc[w.id].neighborMs.push(s.NEIGHBOR_MS || 0);
      spatialAcc[w.id].gridCells.push(s.GRID_CELLS_CHECKED || 0);
    }
  }
}

function printSpatialSummary(spatialAcc, runs) {
  const ids = Object.keys(spatialAcc).sort();
  if (ids.length === 0) return;
  console.log('\n--- Summary (spatial workers) ---');
  for (const id of ids) {
    const a = spatialAcc[id];
    const stepS = summaryForSeries(a.stepMs, a.stepMs.length);
    const fpsS = summaryForSeries(a.fps, runs);
    const nmS = summaryForSeries(a.neighborMs, a.neighborMs.length);
    const gcS = summaryForSeries(a.gridCells, a.gridCells.length);
    if (stepS) {
      console.log(
        `${id} STEP_MS: median ${stepS.median.toFixed(3)} | mean ${stepS.mean.toFixed(3)} | CV ${fmtPct(stepS.cv)}` +
          ` | Load ${formatLoadPct(stepS.median)} (vs 60 Hz)`
      );
    }
    if (fpsS) {
      console.log(
        `${id} averageFPS: median ${fpsS.median.toFixed(2)} | mean ${fpsS.mean.toFixed(2)} | CV ${fmtPct(fpsS.cv)}`
      );
    }
    if (nmS) {
      console.log(
        `${id} NEIGHBOR_MS: median ${nmS.median.toFixed(3)} | mean ${nmS.mean.toFixed(3)} | CV ${fmtPct(nmS.cv)}`
      );
    }
    if (gcS) {
      console.log(
        `${id} GRID_CELLS_CHECKED: median ${gcS.median.toFixed(0)} | mean ${gcS.mean.toFixed(0)} | CV ${fmtPct(gcS.cv)}`
      );
    }
  }
}

function printPhysicsSummary(physicsFps, bodyCounts, stepMs, runs) {
  console.log('\n--- Summary (physics worker) ---');
  if (stepMs.length === runs) {
    const mmm = minMax(stepMs);
    const stepMed = median(stepMs);
    console.log(
      `STEP_MS: median ${stepMed.toFixed(3)} | mean ${mean(stepMs).toFixed(3)} | ` +
        `stdev ${stdevSample(stepMs).toFixed(3)} | CV ${fmtPct(cv(stepMs))} | min ${mmm.min.toFixed(3)} | max ${mmm.max.toFixed(3)}`
    );
    console.log(
      `Load%: ${formatLoadPct(stepMed)} (STEP_MS / 16.667 ms @ 60 Hz; >100% = over budget)`
    );
  }
  const mm = minMax(physicsFps);
  console.log(
    `averageFPS: median ${median(physicsFps).toFixed(2)} | mean ${mean(physicsFps).toFixed(2)} | ` +
      `stdev ${stdevSample(physicsFps).toFixed(2)} | CV ${fmtPct(cv(physicsFps))} | min ${mm.min.toFixed(2)} | max ${mm.max.toFixed(2)}`
  );
  if (bodyCounts.length === runs) {
    const cmm = minMax(bodyCounts);
    console.log(
      `BODY_COUNT: median ${median(bodyCounts).toFixed(0)} | mean ${mean(bodyCounts).toFixed(0)} | ` +
        `stdev ${stdevSample(bodyCounts).toFixed(0)} | CV ${fmtPct(cv(bodyCounts))} | min ${cmm.min.toFixed(0)} | max ${cmm.max.toFixed(0)}`
    );
    console.log(
      'Interpretation: compare builds only when BODY_COUNT mean/median are similar (same workload). High CV ⇒ noisy phase; more runs or longer duration.'
    );
  }
}

const PHYSICS_DIAGNOSTIC_FIELDS = [
  'BODY_SYNC_MS',
  'JOINT_SYNC_MS',
  'COMMAND_MS',
  'FORCE_MS',
  'BOX2D_MS',
  'POST_MS',
  'BODY_MOVED_COUNT',
  'AWAKE_COUNT',
  'BODY_SYNC_CHANGES',
  'BODY_SYNC_VISITED',
  'JOINT_SYNC_CHANGES',
  'COMMAND_COUNT',
  'COMMAND_OVERFLOW_TOTAL',
  'CONTACT_DROPPED',
  'SENSOR_DROPPED',
];

function recordPhysicsStats(stats, accumulator) {
  if (!stats) return;
  for (const field of PHYSICS_DIAGNOSTIC_FIELDS) {
    if (!accumulator[field]) accumulator[field] = [];
    accumulator[field].push(stats[field] || 0);
  }
}

function printPhysicsDiagnostics(accumulator, runs) {
  console.log('\n--- Physics subphases / diagnostics ---');
  for (const field of PHYSICS_DIAGNOSTIC_FIELDS) {
    const values = accumulator[field] || [];
    const summary = summaryForSeries(values, runs);
    if (!summary) continue;
    const digits = field.endsWith('_MS') ? 3 : 1;
    console.log(
      `${field}: median ${summary.median.toFixed(digits)} | mean ${summary.mean.toFixed(digits)} | CV ${fmtPct(summary.cv)}`
    );
  }
}

function runMedianBlock(runs, warmupMs, durationMs, tmpDir, runPrefix, scene, sceneExport) {
  const physicsFps = [];
  const bodyCounts = [];
  const stepMs = [];
  const physicsStats = Object.create(null);
  const spatialAcc = Object.create(null);
  let runsCompleted = 0;
  let attempts = 0;
  const maxAttempts = runs + 3;

  while (runsCompleted < runs && attempts < maxAttempts) {
    const attempt = attempts++;
    const outPath = path.join(tmpDir, `${runPrefix}-${attempt}.json`);
    const args = [
      runner,
      '--headed',
      '--warmup-ms',
      String(warmupMs),
      '--duration-ms',
      String(durationMs),
      '--output',
      outPath,
    ];
    if (scene) args.push('--scene', scene);
    if (sceneExport) args.push('--scene-export', sceneExport);
    try {
      execFileSync(process.execPath, args, { stdio: 'inherit', cwd: repoRoot });
    } catch (err) {
      console.warn(
        `  attempt ${attempt + 1}/${maxAttempts} failed; retrying (${err?.status ?? 'unknown status'})`
      );
      continue;
    }

    const j = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const ph = j.workers.find((w) => w.id === 'physics');
    if (!ph) {
      console.error('No physics worker in', outPath);
      process.exitCode = 1;
      break;
    }
    recordSpatialFromReport(j, spatialAcc);
    physicsFps.push(ph.averageFPS);
    if (ph.statsSamplesAverage) {
      bodyCounts.push(ph.statsSamplesAverage.BODY_COUNT || 0);
      stepMs.push(ph.statsSamplesAverage.STEP_MS || 0);
      recordPhysicsStats(ph.statsSamplesAverage, physicsStats);
    }
    runsCompleted++;
    const step = ph.statsSamplesAverage?.STEP_MS || 0;
    const avg = ph.statsSamplesAverage;
    let line =
      `  [${runsCompleted}/${runs}] physics STEP_MS ${step.toFixed(3)} | Load ${formatLoadPct(step)}` +
      ` | FPS ${ph.averageFPS.toFixed(2)}` +
      (avg
        ? ` | BODY_COUNT ${(avg.BODY_COUNT || 0).toFixed(0)}` +
          (avg.BOX2D_MS != null ? ` | BOX2D_MS ${Number(avg.BOX2D_MS).toFixed(3)}` : '') +
          (avg.BODY_MOVED_COUNT != null ? ` | Moved ${Number(avg.BODY_MOVED_COUNT).toFixed(0)}` : '') +
          (avg.AWAKE_COUNT != null ? ` | Awake ${Number(avg.AWAKE_COUNT).toFixed(0)}` : '')
        : '');
    for (const id of Object.keys(spatialAcc).sort()) {
      const lastStep = spatialAcc[id].stepMs[spatialAcc[id].stepMs.length - 1];
      const lastNm = spatialAcc[id].neighborMs[spatialAcc[id].neighborMs.length - 1];
      if (lastStep !== undefined) {
        line +=
          ` | ${id} STEP_MS ${lastStep.toFixed(3)} Load ${formatLoadPct(lastStep)}` +
          (lastNm !== undefined ? ` NEIGHBOR_MS ${lastNm.toFixed(3)}` : '');
      }
    }
    console.log(line);
  }

  return { physicsFps, bodyCounts, stepMs, physicsStats, spatialAcc, runsCompleted };
}

const { runs, warmupMs, durationMs, jsonOut, scene, sceneExport } = parseArgs(process.argv.slice(2));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-bench-'));
let exitCode = 0;

try {
  console.log(
    `Median benchmark: ${runs} headed runs, warmup ${warmupMs}ms, duration ${durationMs}ms\n` +
      '(Keep the Chromium window visible and in front.)\n'
  );

  const block = runMedianBlock(
    runs,
    warmupMs,
    durationMs,
    tmpDir,
    'run',
    scene,
    sceneExport,
  );
  if (block.physicsFps.length === 0) exitCode = 1;
  else {
    if (block.runsCompleted < runs) {
      console.error(`Only ${block.runsCompleted}/${runs} runs completed after retries.`);
      exitCode = 1;
    }
    printPhysicsSummary(block.physicsFps, block.bodyCounts, block.stepMs, block.runsCompleted);
    printPhysicsDiagnostics(block.physicsStats, block.runsCompleted);
    printSpatialSummary(block.spatialAcc, block.runsCompleted);

    if (jsonOut) {
      const single = {
        meta: {
          headed: true,
          warmupMs,
          durationMs,
          runs,
          scene: scene || '/demos/ballsScene/ballsScene.js',
          sceneExport: sceneExport || 'BallsScene',
          generatedAt: new Date().toISOString(),
        },
        physicsFps: block.physicsFps,
        bodyCounts: block.bodyCounts,
        stepMs: block.stepMs,
        physicsStatsPerRun: block.physicsStats,
        spatialPerRun: block.spatialAcc,
        summary: {
          physics: {
            averageFPS: summaryForSeries(block.physicsFps, block.runsCompleted),
            BODY_COUNT: summaryForSeries(block.bodyCounts, block.bodyCounts.length),
            STEP_MS: summaryForSeries(block.stepMs, block.stepMs.length),
            ...Object.fromEntries(
              Object.entries(block.physicsStats).map(([field, values]) => [
                field,
                summaryForSeries(values, values.length),
              ])
            ),
          },
        },
      };
      fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
      fs.writeFileSync(jsonOut, JSON.stringify(single, null, 2), 'utf8');
      console.log(`\nWrote ${jsonOut}`);
    }
  }
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    /* ignore */
  }
}

process.exit(exitCode);
