#!/usr/bin/env node
/**
 * 5-run confirmation for promoted sleep-neighbor hyps.
 *   node tests/bench/run-sleep-neighbor-confirm.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { applyHyp, restoreAll } from './sleep-neighbor-hyps/sleepHypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/sleep-neighbor-hyps');
const outPath = path.join(outDir, 'confirm-summary.json');

const RUNS = 5;
const CONFIRM = ['S0', 'S1', 'S2', 'S3', 'S6'];

const SCENES = [
  { key: 'balls', scene: '/demos/ballsScene/ballsScene.js', exportName: 'BallsScene' },
  { key: 'predator', scene: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene' },
];

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}
function cv(arr) {
  const m = mean(arr);
  return m > 0 ? stdev(arr) / m : 0;
}
function series(values) {
  return {
    median: median(values),
    mean: mean(values),
    stdev: stdev(values),
    cv: cv(values),
    samples: values,
    loadPct: workerLoadPct(median(values)),
  };
}

function summarize(j) {
  const spatial = (j.workers || []).filter((w) => w.id.startsWith('spatial'));
  const physics = (j.workers || []).find((w) => w.id === 'physics');
  const steps = spatial.map((w) => w.statsSamplesAverage?.STEP_MS ?? 0);
  const rebuild = spatial.map((w) => w.statsSamplesAverage?.REBUILD_MS ?? 0);
  const neigh = spatial.map((w) => w.statsSamplesAverage?.NEIGHBOR_MS ?? 0);
  const reused = spatial.map((w) => w.statsSamplesAverage?.NEIGHBORS_REUSED ?? 0);
  const sleep = spatial.map((w) => w.statsSamplesAverage?.SLEEP_NEIGHBOR_SKIPS ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    stepMax: Math.max(0, ...steps),
    stepSum: sum(steps),
    rebuildSum: sum(rebuild),
    neighborSum: sum(neigh),
    reusedSum: sum(reused),
    sleepSkipsSum: sum(sleep),
    BODY_COUNT: physics?.statsSamplesAverage?.BODY_COUNT ?? 0,
    AWAKE_COUNT: physics?.statsSamplesAverage?.AWAKE_COUNT ?? 0,
  };
}

fs.mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), runs: RUNS, results: [] };

try {
  for (const id of CONFIRM) {
    console.log(`\n===== CONFIRM ${id} =====`);
    applyHyp(id);
    const scenes = {};
    for (const scene of SCENES) {
      const runs = [];
      for (let r = 1; r <= RUNS; r++) {
        const out = path.join(outDir, `confirm-${id}-${scene.key}-r${r}.json`);
        console.log(`\n--- confirm ${id} ${scene.key} ${r}/${RUNS} ---`);
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
            String(DEFAULT_WARMUP_MS),
            '--duration-ms',
            String(DEFAULT_DURATION_MS),
            '--output',
            out,
          ],
          { cwd: repoRoot, stdio: 'inherit' }
        );
        runs.push(summarize(JSON.parse(fs.readFileSync(out, 'utf8'))));
      }
      const pick = (k) => runs.map((x) => x[k]);
      scenes[scene.key] = {
        stepMax: series(pick('stepMax')),
        neighborSum: series(pick('neighborSum')),
        rebuildSum: series(pick('rebuildSum')),
        reusedSum: series(pick('reusedSum')),
        sleepSkipsSum: series(pick('sleepSkipsSum')),
        BODY_COUNT: series(pick('BODY_COUNT')),
        AWAKE_COUNT: series(pick('AWAKE_COUNT')),
      };
    }
    report.results.push({ id, scenes });
  }
} finally {
  restoreAll();
}

const s0 = report.results.find((r) => r.id === 'S0');
report.compare = {};
if (s0) {
  for (const r of report.results) {
    if (r.id === 'S0') continue;
    report.compare[r.id] = {};
    for (const scene of SCENES) {
      const b = s0.scenes[scene.key];
      const c = r.scenes[scene.key];
      const pct = (a, bb) => (bb === 0 ? null : ((a - bb) / bb) * 100);
      report.compare[r.id][scene.key] = {
        stepDeltaPct: pct(c.stepMax.median, b.stepMax.median),
        neighborDeltaPct: pct(c.neighborSum.median, b.neighborSum.median),
        rebuildDeltaPct: pct(c.rebuildSum.median, b.rebuildSum.median),
        bodyDeltaPct: pct(c.BODY_COUNT.median, b.BODY_COUNT.median),
        sleepSkipsMed: c.sleepSkipsSum.median,
        stepCv: c.stepMax.cv,
      };
    }
  }
}

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nWrote ${outPath}`);
console.log(JSON.stringify(report.compare, null, 2));
