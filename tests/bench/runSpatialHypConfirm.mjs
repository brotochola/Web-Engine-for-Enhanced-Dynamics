#!/usr/bin/env node
/**
 * 5-run confirmation for promoted spatial hyps.
 *   node tests/bench/run-spatial-hyp-confirm.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { applyHyp, restoreAll } from './spatial-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/spatial-hyps');
const outPath = path.join(outDir, 'confirm-summary.json');

const RUNS = 5;
const CONFIRM = [
  { id: 'BASE', title: 'Baseline', apply: () => restoreAll() },
  { id: 'H1', title: 'Sleeping cells skip', apply: () => applyHyp('H1') },
  { id: 'H3', title: 'Verlet reuse skin', apply: () => applyHyp('H3') },
  { id: 'H11', title: 'Transform fallback B', apply: () => applyHyp('H11') },
];

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
  return { median: median(values), mean: mean(values), stdev: stdev(values), cv: cv(values), samples: values, loadPct: workerLoadPct(median(values)) };
}

function summarize(j) {
  const spatial = (j.workers || []).filter((w) => w.id.startsWith('spatial'));
  const physics = (j.workers || []).find((w) => w.id === 'physics');
  const steps = spatial.map((w) => w.statsSamplesAverage?.STEP_MS ?? 0);
  const rebuild = spatial.map((w) => w.statsSamplesAverage?.REBUILD_MS ?? 0);
  const neigh = spatial.map((w) => w.statsSamplesAverage?.NEIGHBOR_MS ?? 0);
  const reused = spatial.map((w) => w.statsSamplesAverage?.NEIGHBORS_REUSED ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    stepMax: Math.max(0, ...steps),
    stepSum: sum(steps),
    rebuildSum: sum(rebuild),
    neighborSum: sum(neigh),
    reusedSum: sum(reused),
    BODY_COUNT: physics?.statsSamplesAverage?.BODY_COUNT ?? 0,
    AWAKE_COUNT: physics?.statsSamplesAverage?.AWAKE_COUNT ?? 0,
  };
}

fs.mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), runs: RUNS, results: [] };

try {
  for (const hyp of CONFIRM) {
    console.log(`\n===== CONFIRM ${hyp.id} =====`);
    restoreAll();
    hyp.apply();
    const scenes = {};
    for (const scene of SCENES) {
      const samples = [];
      for (let r = 0; r < RUNS; r++) {
        const out = path.join(outDir, `confirm-${hyp.id}-${scene.key}-r${r + 1}.json`);
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
        samples.push(summarize(JSON.parse(fs.readFileSync(out, 'utf8'))));
      }
      scenes[scene.key] = {
        stepMax: series(samples.map((s) => s.stepMax)),
        stepSum: series(samples.map((s) => s.stepSum)),
        rebuildSum: series(samples.map((s) => s.rebuildSum)),
        neighborSum: series(samples.map((s) => s.neighborSum)),
        reusedSum: series(samples.map((s) => s.reusedSum)),
        BODY_COUNT: series(samples.map((s) => s.BODY_COUNT)),
        AWAKE_COUNT: series(samples.map((s) => s.AWAKE_COUNT)),
      };
      console.log(
        `  ${scene.key}: STEP max med=${scenes[scene.key].stepMax.median.toFixed(3)} ` +
          `CV=${(scenes[scene.key].stepMax.cv * 100).toFixed(1)}% BODY=${scenes[scene.key].BODY_COUNT.median.toFixed(0)}`
      );
    }
    report.results.push({ id: hyp.id, title: hyp.title, scenes });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  restoreAll();
}

const base = report.results.find((r) => r.id === 'BASE');
for (const row of report.results) {
  if (row.id === 'BASE') continue;
  row.deltaVsBase = {};
  for (const scene of SCENES) {
    const b = base.scenes[scene.key].stepMax.median;
    const h = row.scenes[scene.key].stepMax.median;
    const bodyB = base.scenes[scene.key].BODY_COUNT.median;
    const bodyH = row.scenes[scene.key].BODY_COUNT.median;
    const stepDeltaPct = b > 0 ? ((h - b) / b) * 100 : 0;
    const bodyDeltaPct = bodyB > 0 ? ((bodyH - bodyB) / bodyB) * 100 : 0;
    row.deltaVsBase[scene.key] = {
      stepDeltaPct,
      bodyDeltaPct,
      accepted: stepDeltaPct <= -3 && Math.abs(bodyDeltaPct) <= 5,
    };
  }
}
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`\nWrote ${outPath}`);
