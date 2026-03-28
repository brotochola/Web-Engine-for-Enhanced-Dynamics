#!/usr/bin/env node
/**
 * Runs the integrated worker benchmark N times (headed, throttle mitigation on)
 * and prints median / mean / stdev / CV for physics + spatial worker stats.
 *
 * Usage:
 *   node tests/bench/run-headed-median.mjs
 *   node tests/bench/run-headed-median.mjs --runs 6 --json-out tests/results/research-spatial-headed.json
 *
 * Leave the Chromium window visible; do not minimize during measurement.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');

function parseArgs(argv) {
  const out = {
    runs: 5,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    jsonOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || DEFAULT_WARMUP_MS;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || DEFAULT_DURATION_MS;
    else if (a === '--json-out' && argv[i + 1]) out.jsonOut = path.resolve(argv[++i]);
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
      spatialAcc[w.id] = { fps: [], neighborMs: [], gridCells: [] };
    }
    spatialAcc[w.id].fps.push(w.averageFPS || 0);
    const s = w.statsSamplesAverage;
    if (s) {
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
    const fpsS = summaryForSeries(a.fps, runs);
    const nmS = summaryForSeries(a.neighborMs, a.neighborMs.length);
    const gcS = summaryForSeries(a.gridCells, a.gridCells.length);
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

function printPhysicsSummary(physicsFps, collisionChecks, collisionMs, runs) {
  const mm = minMax(physicsFps);
  console.log('\n--- Summary (physics worker) ---');
  console.log(
    `averageFPS: median ${median(physicsFps).toFixed(2)} | mean ${mean(physicsFps).toFixed(2)} | ` +
      `stdev ${stdevSample(physicsFps).toFixed(2)} | CV ${fmtPct(cv(physicsFps))} | min ${mm.min.toFixed(2)} | max ${mm.max.toFixed(2)}`
  );
  if (collisionChecks.length === runs) {
    const cmm = minMax(collisionChecks);
    console.log(
      `COLLISION_CHECKS: median ${median(collisionChecks).toFixed(0)} | mean ${mean(collisionChecks).toFixed(0)} | ` +
        `stdev ${stdevSample(collisionChecks).toFixed(0)} | CV ${fmtPct(cv(collisionChecks))} | min ${cmm.min.toFixed(0)} | max ${cmm.max.toFixed(0)}`
    );
    console.log(
      'Interpretation: compare builds only when COLLISION_CHECKS mean/median are similar (same workload). High CV ⇒ noisy phase; more runs or longer duration.'
    );
  }
  if (collisionMs.length === runs) {
    const mmm = minMax(collisionMs);
    console.log(
      `COLLISION_MS: median ${median(collisionMs).toFixed(3)} | mean ${mean(collisionMs).toFixed(3)} | ` +
        `stdev ${stdevSample(collisionMs).toFixed(3)} | CV ${fmtPct(cv(collisionMs))} | min ${mmm.min.toFixed(3)} | max ${mmm.max.toFixed(3)}`
    );
  }
}

function runMedianBlock(runs, warmupMs, durationMs, tmpDir, runPrefix) {
  const physicsFps = [];
  const collisionChecks = [];
  const collisionMs = [];
  const spatialAcc = Object.create(null);
  let runsCompleted = 0;

  for (let i = 0; i < runs; i++) {
    const outPath = path.join(tmpDir, `${runPrefix}-${i}.json`);
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
    execFileSync(process.execPath, args, { stdio: 'inherit', cwd: repoRoot });

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
      collisionChecks.push(ph.statsSamplesAverage.COLLISION_CHECKS || 0);
      collisionMs.push(ph.statsSamplesAverage.COLLISION_MS || 0);
    }
    runsCompleted++;
    let line =
      `  [${i + 1}/${runs}] physics avg FPS ${ph.averageFPS.toFixed(2)}` +
      (ph.statsSamplesAverage
        ? ` | COLLISION_CHECKS ${(ph.statsSamplesAverage.COLLISION_CHECKS || 0).toFixed(0)} | COLLISION_MS ${(ph.statsSamplesAverage.COLLISION_MS || 0).toFixed(3)}`
        : '');
    for (const id of Object.keys(spatialAcc).sort()) {
      const lastFps = spatialAcc[id].fps[spatialAcc[id].fps.length - 1];
      const lastNm = spatialAcc[id].neighborMs[spatialAcc[id].neighborMs.length - 1];
      if (lastNm !== undefined) {
        line += ` | ${id} FPS ${lastFps.toFixed(1)} NEIGHBOR_MS ${lastNm.toFixed(3)}`;
      }
    }
    console.log(line);
  }

  return { physicsFps, collisionChecks, collisionMs, spatialAcc, runsCompleted };
}

const { runs, warmupMs, durationMs, jsonOut } = parseArgs(process.argv.slice(2));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-bench-'));
let exitCode = 0;

try {
  console.log(
    `Median benchmark: ${runs} headed runs, warmup ${warmupMs}ms, duration ${durationMs}ms\n` +
      '(Keep the Chromium window visible and in front.)\n'
  );

  const block = runMedianBlock(runs, warmupMs, durationMs, tmpDir, 'run');
  if (block.physicsFps.length === 0) exitCode = 1;
  else {
    printPhysicsSummary(block.physicsFps, block.collisionChecks, block.collisionMs, block.runsCompleted);
    printSpatialSummary(block.spatialAcc, block.runsCompleted);

    if (jsonOut) {
      const single = {
        meta: {
          headed: true,
          warmupMs,
          durationMs,
          runs,
          generatedAt: new Date().toISOString(),
          note: 'Scene config from demos/scenes/BallsScene.js only.',
        },
        physicsFps: block.physicsFps,
        collisionChecks: block.collisionChecks,
        collisionMs: block.collisionMs,
        spatialPerRun: block.spatialAcc,
        summary: {
          physics: {
            averageFPS: summaryForSeries(block.physicsFps, block.runsCompleted),
            COLLISION_CHECKS: summaryForSeries(block.collisionChecks, block.collisionChecks.length),
            COLLISION_MS: summaryForSeries(block.collisionMs, block.collisionMs.length),
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
