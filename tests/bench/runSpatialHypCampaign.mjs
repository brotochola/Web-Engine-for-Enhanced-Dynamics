#!/usr/bin/env node
/**
 * Spatial worker hypothesis campaign.
 *
 *   node tests/bench/run-spatial-hyp-campaign.mjs
 *   node tests/bench/run-spatial-hyp-campaign.mjs --only BASE,H3,H6
 *   node tests/bench/run-spatial-hyp-campaign.mjs --runs 2 --skip-restore-check
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { HYPS, applyHyp, restoreAll, PATHS } from './spatial-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/spatial-hyps');
const summaryPath = path.join(outDir, 'campaign-summary.json');

const SCENES = [
  {
    key: 'balls',
    scene: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
  },
  {
    key: 'predator',
    scene: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
  },
];

function parseArgs(argv) {
  const out = {
    runs: 2,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || DEFAULT_WARMUP_MS;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || DEFAULT_DURATION_MS;
    else if (a === '--only' && argv[i + 1]) {
      out.only = String(argv[++i])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function summarizeReport(j) {
  const spatialWorkers = (j.workers || []).filter((w) => w.id.startsWith('spatial'));
  const physics = (j.workers || []).find((w) => w.id === 'physics');
  const pick = (key) => spatialWorkers.map((w) => w.statsSamplesAverage?.[key] ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const step = pick('STEP_MS');
  return {
    spatialCount: spatialWorkers.length,
    spatialStepMsSum: sum(step),
    spatialStepMsMax: Math.max(0, ...step),
    spatialRebuildMsSum: sum(pick('REBUILD_MS')),
    spatialNeighborMsSum: sum(pick('NEIGHBOR_MS')),
    spatialNeighborsReusedSum: sum(pick('NEIGHBORS_REUSED')),
    spatialGridCellsSum: sum(pick('GRID_CELLS_CHECKED')),
    spatialPerWorker: spatialWorkers.map((w) => ({
      id: w.id,
      STEP_MS: w.statsSamplesAverage?.STEP_MS ?? 0,
      REBUILD_MS: w.statsSamplesAverage?.REBUILD_MS ?? 0,
      NEIGHBOR_MS: w.statsSamplesAverage?.NEIGHBOR_MS ?? 0,
      NEIGHBORS_REUSED: w.statsSamplesAverage?.NEIGHBORS_REUSED ?? 0,
      GRID_CELLS_CHECKED: w.statsSamplesAverage?.GRID_CELLS_CHECKED ?? 0,
      averageFPS: w.averageFPS ?? 0,
    })),
    physicsStepMs: physics?.statsSamplesAverage?.STEP_MS ?? 0,
    BODY_COUNT: physics?.statsSamplesAverage?.BODY_COUNT ?? 0,
    AWAKE_COUNT: physics?.statsSamplesAverage?.AWAKE_COUNT ?? 0,
    physicsFps: physics?.averageFPS ?? 0,
  };
}

function seriesStats(values) {
  return {
    median: median(values),
    mean: mean(values),
    samples: values,
    loadPctMedian: workerLoadPct(median(values)),
  };
}

function runBench(scene, hypId, runIndex, warmupMs, durationMs) {
  const out = path.join(outDir, `${hypId}-${scene.key}-r${runIndex}.json`);
  execFileSync(
    process.execPath,
    [
      runner,
      '--headed',
      '--scene',
      scene.scene,
      '--scene-export',
      scene.exportName,
      '--warmup-ms',
      String(warmupMs),
      '--duration-ms',
      String(durationMs),
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function dryApplyAll() {
  for (const h of HYPS) {
    restoreAll();
    h.apply();
    // basic syntax check via node --check on spatial
    try {
      execFileSync(process.execPath, ['--check', PATHS.spatial], { stdio: 'pipe' });
    } catch (e) {
      restoreAll();
      throw new Error(`Syntax fail on ${h.id}: ${e.message}`);
    }
    // scene files are always valid JS when only number patches
  }
  restoreAll();
  console.log('Dry-apply: all hyps syntax OK');
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

if (process.argv.includes('--dry-apply')) {
  dryApplyAll();
  process.exit(0);
}

const hypList = [{ id: 'BASE', title: 'Baseline (unpatched)', apply: () => restoreAll() }, ...HYPS];
const selected = args.only
  ? hypList.filter((h) => args.only.includes(h.id))
  : hypList;

const campaign = {
  generatedAt: new Date().toISOString(),
  chromiumMode: 'headed',
  warmupMs: args.warmupMs,
  durationMs: args.durationMs,
  runsPerCell: args.runs,
  results: [],
};

console.log(
  `Spatial hyp campaign | hyps=${selected.map((h) => h.id).join(',')} | runs=${args.runs} | headed\n`
);

try {
  for (const hyp of selected) {
    console.log(`\n########## ${hyp.id}: ${hyp.title} ##########`);
    restoreAll();
    hyp.apply();

    const sceneRows = {};
    for (const scene of SCENES) {
      const runs = [];
      for (let r = 0; r < args.runs; r++) {
        console.log(`\n--- ${hyp.id} / ${scene.key} / run ${r + 1} ---`);
        const j = runBench(scene, hyp.id, r + 1, args.warmupMs, args.durationMs);
        runs.push(summarizeReport(j));
      }
      const agg = {
        spatialStepMsMax: seriesStats(runs.map((x) => x.spatialStepMsMax)),
        spatialStepMsSum: seriesStats(runs.map((x) => x.spatialStepMsSum)),
        spatialRebuildMsSum: seriesStats(runs.map((x) => x.spatialRebuildMsSum)),
        spatialNeighborMsSum: seriesStats(runs.map((x) => x.spatialNeighborMsSum)),
        spatialNeighborsReusedSum: seriesStats(runs.map((x) => x.spatialNeighborsReusedSum)),
        spatialGridCellsSum: seriesStats(runs.map((x) => x.spatialGridCellsSum)),
        physicsStepMs: seriesStats(runs.map((x) => x.physicsStepMs)),
        BODY_COUNT: seriesStats(runs.map((x) => x.BODY_COUNT)),
      };
      sceneRows[scene.key] = { runs, aggregate: agg };
      console.log(
        `  ${scene.key}: STEP_MS max med=${agg.spatialStepMsMax.median.toFixed(3)} ` +
          `(${agg.spatialStepMsMax.loadPctMedian.toFixed(0)}%) ` +
          `REBUILD=${agg.spatialRebuildMsSum.median.toFixed(3)} ` +
          `NEIGHBOR=${agg.spatialNeighborMsSum.median.toFixed(3)} ` +
          `REUSED=${agg.spatialNeighborsReusedSum.median.toFixed(0)} ` +
          `BODY=${agg.BODY_COUNT.median.toFixed(0)}`
      );
    }

    campaign.results.push({
      id: hyp.id,
      title: hyp.title,
      scenes: sceneRows,
    });

    // checkpoint after each hyp
    fs.writeFileSync(summaryPath, JSON.stringify(campaign, null, 2) + '\n');
  }
} finally {
  restoreAll();
  console.log('\nRestored baseline sources.');
}

// Attach deltas vs BASE
const base = campaign.results.find((r) => r.id === 'BASE');
if (base) {
  for (const row of campaign.results) {
    if (row.id === 'BASE') continue;
    row.deltaVsBase = {};
    for (const scene of SCENES) {
      const b = base.scenes[scene.key].aggregate.spatialStepMsMax.median;
      const h = row.scenes[scene.key].aggregate.spatialStepMsMax.median;
      const bodyB = base.scenes[scene.key].aggregate.BODY_COUNT.median;
      const bodyH = row.scenes[scene.key].aggregate.BODY_COUNT.median;
      const stepDeltaPct = b > 0 ? ((h - b) / b) * 100 : 0;
      const bodyDeltaPct = bodyB > 0 ? ((bodyH - bodyB) / bodyB) * 100 : 0;
      const improved = stepDeltaPct <= -3 && Math.abs(bodyDeltaPct) <= 5;
      row.deltaVsBase[scene.key] = {
        stepMsMaxBase: b,
        stepMsMaxHyp: h,
        stepDeltaPct,
        bodyDeltaPct,
        screeningPromote: improved,
      };
    }
  }
}

fs.writeFileSync(summaryPath, JSON.stringify(campaign, null, 2) + '\n');
console.log(`\nWrote ${summaryPath}`);
