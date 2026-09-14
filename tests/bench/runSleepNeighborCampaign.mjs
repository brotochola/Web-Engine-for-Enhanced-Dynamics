#!/usr/bin/env node
/**
 * Sleep-neighborhood neighbor hypothesis campaign.
 *
 *   node tests/bench/run-sleep-neighbor-campaign.mjs
 *   node tests/bench/run-sleep-neighbor-campaign.mjs --only S0,S2,S5
 *   node tests/bench/run-sleep-neighbor-campaign.mjs --dry-apply
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { HYPS, applyHyp, restoreAll, PATHS } from './sleep-neighbor-hyps/sleepHypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/sleep-neighbor-hyps');
const summaryPath = path.join(outDir, 'campaign-summary.json');

const SCENES = [
  { key: 'balls', scene: '/demos/ballsScene/ballsScene.js', exportName: 'BallsScene' },
  { key: 'predator', scene: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene' },
];

function parseArgs(argv) {
  const out = {
    runs: 2,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    only: null,
    dryApply: false,
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
    } else if (a === '--dry-apply') out.dryApply = true;
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
    spatialSleepSkipsSum: sum(pick('SLEEP_NEIGHBOR_SKIPS')),
    spatialGridCellsSum: sum(pick('GRID_CELLS_CHECKED')),
    physicsStepMs: physics?.statsSamplesAverage?.STEP_MS ?? 0,
    BODY_COUNT: physics?.statsSamplesAverage?.BODY_COUNT ?? 0,
    AWAKE_COUNT: physics?.statsSamplesAverage?.AWAKE_COUNT ?? 0,
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
  return summarizeReport(JSON.parse(fs.readFileSync(out, 'utf8')));
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

const hypList = args.only ? HYPS.filter((h) => args.only.includes(h.id)) : HYPS;
if (hypList.length === 0) throw new Error('No hyps selected');

if (args.dryApply) {
  for (const h of hypList) {
    console.log(`dry-apply ${h.id}: ${h.title}`);
    applyHyp(h.id);
  }
  restoreAll();
  console.log('All patches applied OK; restored baseline.');
  process.exit(0);
}

const report = {
  generatedAt: new Date().toISOString(),
  runs: args.runs,
  warmupMs: args.warmupMs,
  durationMs: args.durationMs,
  hyps: [],
};

try {
  for (const hyp of hypList) {
    console.log(`\n===== ${hyp.id}: ${hyp.title} =====`);
    applyHyp(hyp.id);
    const scenes = {};
    for (const scene of SCENES) {
      const runs = [];
      for (let r = 1; r <= args.runs; r++) {
        console.log(`\n--- ${hyp.id} ${scene.key} run ${r}/${args.runs} ---`);
        runs.push(runBench(scene, hyp.id, r, args.warmupMs, args.durationMs));
      }
      const pick = (k) => runs.map((x) => x[k]);
      scenes[scene.key] = {
        runs,
        stepMax: seriesStats(pick('spatialStepMsMax')),
        neighborSum: seriesStats(pick('spatialNeighborMsSum')),
        rebuildSum: seriesStats(pick('spatialRebuildMsSum')),
        reusedSum: seriesStats(pick('spatialNeighborsReusedSum')),
        sleepSkipsSum: seriesStats(pick('spatialSleepSkipsSum')),
        cellsSum: seriesStats(pick('spatialGridCellsSum')),
        BODY_COUNT: seriesStats(pick('BODY_COUNT')),
        AWAKE_COUNT: seriesStats(pick('AWAKE_COUNT')),
      };
    }
    report.hyps.push({ id: hyp.id, title: hyp.title, scenes });
  }
} finally {
  restoreAll();
}

const s0 = report.hyps.find((h) => h.id === 'S0');
report.compare = {};
if (s0) {
  for (const hyp of report.hyps) {
    if (hyp.id === 'S0') continue;
    report.compare[hyp.id] = {};
    for (const scene of SCENES) {
      const base = s0.scenes[scene.key];
      const cur = hyp.scenes[scene.key];
      const pct = (a, b) => (b === 0 ? null : ((a - b) / b) * 100);
      const bodyBase = base.BODY_COUNT.median;
      const bodyCur = cur.BODY_COUNT.median;
      const stepDelta = pct(cur.stepMax.median, base.stepMax.median);
      const bodyDelta = pct(bodyCur, bodyBase);
      const promote =
        stepDelta != null &&
        stepDelta <= -3 &&
        bodyDelta != null &&
        Math.abs(bodyDelta) <= 5 &&
        (cur.sleepSkipsSum.median > 1 || hyp.id === 'S5' || hyp.id === 'S6');
      report.compare[hyp.id][scene.key] = {
        stepDeltaPct: stepDelta,
        neighborDeltaPct: pct(cur.neighborSum.median, base.neighborSum.median),
        rebuildDeltaPct: pct(cur.rebuildSum.median, base.rebuildSum.median),
        bodyDeltaPct: bodyDelta,
        sleepSkipsMed: cur.sleepSkipsSum.median,
        promoteMetric: promote,
      };
    }
  }
}

fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));
console.log(`\nWrote ${summaryPath}`);
console.log(JSON.stringify(report.compare, null, 2));
