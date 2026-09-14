#!/usr/bin/env node
/**
 * Dual-grid (fine + 4×) smoke bench — short discard run.
 *
 *   node tests/bench/run-multigrid-smoke.mjs
 *   node tests/bench/run-multigrid-smoke.mjs --confirm
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { HYPS, applyHyp, restoreAll } from './multigrid-hyps/multigridHypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/multigrid-hyps');

const WARMUP_MS = 8_000;
const DURATION_MS = 6_000;

const SCENES = [
  { key: 'balls', scene: '/demos/ballsScene/ballsScene.js', exportName: 'BallsScene' },
  { key: 'predator', scene: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene' },
];

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const runs = confirm ? 2 : 1;

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(j) {
  const spatial = (j.workers || []).filter((w) => w.id.startsWith('spatial'));
  const physics = (j.workers || []).find((w) => w.id === 'physics');
  const pick = (k) => spatial.map((w) => w.statsSamplesAverage?.[k] ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const steps = pick('STEP_MS');
  return {
    stepMax: Math.max(0, ...steps),
    rebuildSum: sum(pick('REBUILD_MS')),
    neighborSum: sum(pick('NEIGHBOR_MS')),
    cellsSum: sum(pick('GRID_CELLS_CHECKED')),
    BODY_COUNT: physics?.statsSamplesAverage?.BODY_COUNT ?? 0,
    loadPct: workerLoadPct(Math.max(0, ...steps)),
  };
}

function runOne(scene, hypId, runIndex) {
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
      String(WARMUP_MS),
      '--duration-ms',
      String(DURATION_MS),
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return summarize(JSON.parse(fs.readFileSync(out, 'utf8')));
}

fs.mkdirSync(outDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  warmupMs: WARMUP_MS,
  durationMs: DURATION_MS,
  runs,
  confirm,
  hyps: [],
};

try {
  for (const hyp of HYPS) {
    console.log(`\n===== ${hyp.id}: ${hyp.title} =====`);
    applyHyp(hyp.id);
    const scenes = {};
    for (const scene of SCENES) {
      const runRows = [];
      for (let r = 1; r <= runs; r++) {
        console.log(`\n--- ${hyp.id} ${scene.key} ${r}/${runs} ---`);
        runRows.push(runOne(scene, hyp.id, r));
      }
      const pick = (k) => runRows.map((x) => x[k]);
      scenes[scene.key] = {
        runs: runRows,
        stepMax: median(pick('stepMax')),
        rebuildSum: median(pick('rebuildSum')),
        neighborSum: median(pick('neighborSum')),
        cellsSum: median(pick('cellsSum')),
        BODY_COUNT: median(pick('BODY_COUNT')),
      };
    }
    report.hyps.push({ id: hyp.id, title: hyp.title, scenes });
  }
} finally {
  restoreAll();
}

const m0 = report.hyps.find((h) => h.id === 'M0');
const m1 = report.hyps.find((h) => h.id === 'M1');
report.compare = {};
if (m0 && m1) {
  const pct = (a, b) => (b === 0 ? null : ((a - b) / b) * 100);
  for (const scene of SCENES) {
    const b = m0.scenes[scene.key];
    const c = m1.scenes[scene.key];
    const stepDelta = pct(c.stepMax, b.stepMax);
    const rebuildDelta = pct(c.rebuildSum, b.rebuildSum);
    const rejectRebuild =
      rebuildDelta != null && rebuildDelta > 50 && !(stepDelta != null && stepDelta <= -3);
    const promote =
      stepDelta != null &&
      stepDelta <= -3 &&
      Math.abs(pct(c.BODY_COUNT, b.BODY_COUNT) || 0) <= 5 &&
      !rejectRebuild;
    report.compare[scene.key] = {
      stepDeltaPct: stepDelta,
      rebuildDeltaPct: rebuildDelta,
      neighborDeltaPct: pct(c.neighborSum, b.neighborSum),
      cellsDeltaPct: pct(c.cellsSum, b.cellsSum),
      bodyDeltaPct: pct(c.BODY_COUNT, b.BODY_COUNT),
      rejectRebuildBlowup: rejectRebuild,
      promoteMetric: promote,
    };
  }
}

const outPath = path.join(outDir, confirm ? 'confirm-summary.json' : 'smoke-summary.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nWrote ${outPath}`);
console.log(JSON.stringify(report.compare, null, 2));

const predatorOk = report.compare?.predator?.promoteMetric;
if (!confirm && predatorOk) {
  console.log('\nPredator promoted — re-run with --confirm for 2-run median.');
} else if (!confirm) {
  console.log('\nNo Predator promote — discard without confirm.');
}
