#!/usr/bin/env node
/**
 * A/B: spatial.neighborTickInterval off(1) vs on(6) for Balls + Predator.
 *
 *   node tests/bench/run-neighbor-tick-ab.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/neighbor-tick-ab-nopublish');
const summaryPath = path.join(outDir, 'summary.json');

const WARMUP_MS = 12_000;
const DURATION_MS = 10_000;
const RUNS = 2;
const INTERVALS = [1, 6];

const SCENES = [
  {
    key: 'balls',
    scene: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
    file: path.join(repoRoot, 'demos/ballsScene/ballsScene.js'),
  },
  {
    key: 'predator',
    scene: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    file: path.join(repoRoot, 'demos/predatorScene/predatorScene.js'),
  },
];

fs.mkdirSync(outDir, { recursive: true });

const originals = Object.fromEntries(
  SCENES.map((s) => [s.key, fs.readFileSync(s.file, 'utf8')])
);

function setIntervalInScene(scene, interval) {
  let src = originals[scene.key];
  if (/neighborTickInterval:\s*\d+/.test(src)) {
    src = src.replace(/neighborTickInterval:\s*\d+/, `neighborTickInterval: ${interval}`);
  } else if (/spatial:\s*\{/.test(src)) {
    src = src.replace(
      /spatial:\s*\{/,
      `spatial: {\n      neighborTickInterval: ${interval},`
    );
  } else {
    throw new Error(`no spatial block in ${scene.key}`);
  }
  fs.writeFileSync(scene.file, src);
}

function restoreAll() {
  for (const s of SCENES) {
    fs.writeFileSync(s.file, originals[s.key]);
  }
}

function summarize(j) {
  const spatial = (j.workers || []).filter((w) => w.id.startsWith('spatial'));
  const physics = (j.workers || []).find((w) => w.id === 'physics');
  const avg = (key) => spatial.map((w) => w.statsSamplesAverage?.[key] ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const steps = avg('STEP_MS');
  const neigh = avg('NEIGHBOR_MS');
  const rebuild = avg('REBUILD_MS');
  const reused = avg('NEIGHBORS_REUSED');
  const processed = avg('ENTITIES_PROCESSED');
  return {
    spatialCount: spatial.length,
    stepMax: Math.max(0, ...steps),
    stepSum: sum(steps),
    neighborSum: sum(neigh),
    rebuildSum: sum(rebuild),
    reusedSum: sum(reused),
    processedSum: sum(processed),
    BODY_COUNT: physics?.statsSamplesAverage?.BODY_COUNT ?? 0,
    loadPctMax: workerLoadPct(Math.max(0, ...steps)),
    fps: j.averageFPS ?? j.metadata?.averageFPS ?? null,
  };
}

function runOne(scene, interval, runIdx) {
  const tag = `${scene.key}-i${interval}-r${runIdx}`;
  const out = path.join(outDir, `${tag}.json`);
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
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { tag, file: out, ...summarize(j) };
}

const results = [];

try {
  for (const interval of INTERVALS) {
    for (const scene of SCENES) {
      setIntervalInScene(scene, interval);
      for (let r = 1; r <= RUNS; r++) {
        console.log(`\n=== ${scene.key} neighborTickInterval=${interval} run ${r}/${RUNS} ===`);
        results.push({ scene: scene.key, interval, run: r, ...runOne(scene, interval, r) });
      }
    }
  }
} finally {
  restoreAll();
}

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const m = (a.length - 1) / 2;
  return (a[Math.floor(m)] + a[Math.ceil(m)]) / 2;
}

const summary = { warmupMs: WARMUP_MS, durationMs: DURATION_MS, runs: RUNS, results, compare: {} };
for (const scene of SCENES) {
  const off = results.filter((r) => r.scene === scene.key && r.interval === 1);
  const on = results.filter((r) => r.scene === scene.key && r.interval === 6);
  const pick = (rows, key) => rows.map((r) => r[key]);
  summary.compare[scene.key] = {
    off: {
      stepMaxMed: median(pick(off, 'stepMax')),
      neighborSumMed: median(pick(off, 'neighborSum')),
      rebuildSumMed: median(pick(off, 'rebuildSum')),
      reusedSumMed: median(pick(off, 'reusedSum')),
      bodyMed: median(pick(off, 'BODY_COUNT')),
    },
    on: {
      stepMaxMed: median(pick(on, 'stepMax')),
      neighborSumMed: median(pick(on, 'neighborSum')),
      rebuildSumMed: median(pick(on, 'rebuildSum')),
      reusedSumMed: median(pick(on, 'reusedSum')),
      bodyMed: median(pick(on, 'BODY_COUNT')),
    },
  };
  const c = summary.compare[scene.key];
  const pct = (a, b) => (b === 0 ? null : ((a - b) / b) * 100);
  c.deltaPct = {
    stepMax: pct(c.on.stepMaxMed, c.off.stepMaxMed),
    neighborSum: pct(c.on.neighborSumMed, c.off.neighborSumMed),
    rebuildSum: pct(c.on.rebuildSumMed, c.off.rebuildSumMed),
  };
}

fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log('\n=== COMPARE (median of runs; negative delta = faster on) ===');
console.log(JSON.stringify(summary.compare, null, 2));
console.log(`\nWrote ${summaryPath}`);
