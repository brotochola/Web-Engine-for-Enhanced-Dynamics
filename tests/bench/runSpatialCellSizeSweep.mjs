#!/usr/bin/env node
/**
 * Sweep spatial.cellSize on BallsScene + PredatorScene (headed), restore configs after.
 *
 *   node tests/bench/run-spatial-cellsize-sweep.mjs
 *   node tests/bench/run-spatial-cellsize-sweep.mjs --sizes 64,100,128,256 --runs 2
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outReport = path.join(repoRoot, 'tests/results', 'spatial-cellsize-sweep.json');

const SCENES = [
  {
    key: 'balls',
    file: path.join(repoRoot, 'demos/ballsScene/ballsScene.js'),
    scene: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
    defaultCellSize: 100,
  },
  {
    key: 'predator',
    file: path.join(repoRoot, 'demos/predatorScene/predatorScene.js'),
    scene: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    defaultCellSize: 128,
  },
];

function parseArgs(argv) {
  const out = {
    sizes: [64, 100, 128, 256],
    runs: 2,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sizes' && argv[i + 1]) {
      out.sizes = String(argv[++i])
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0);
    } else if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || DEFAULT_WARMUP_MS;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || DEFAULT_DURATION_MS;
  }
  return out;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function setSpatialCellSize(filePath, cellSize) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Only the spatial hash cellSize (first `cellSize:` under spatial / near top of config).
  // Predator also has navigation.cellSize — leave that alone by matching inside spatial block.
  const spatialBlock = /spatial:\s*\{[\s\S]*?\n\s*\},/;
  const m = src.match(spatialBlock);
  if (!m) throw new Error(`spatial block not found in ${filePath}`);
  const patchedBlock = m[0].replace(/cellSize:\s*\d+/, `cellSize: ${cellSize}`);
  if (patchedBlock === m[0] && !m[0].includes(`cellSize: ${cellSize}`)) {
    throw new Error(`cellSize not patched in ${filePath}`);
  }
  fs.writeFileSync(filePath, src.replace(spatialBlock, patchedBlock));
}

function summarizeReport(j) {
  const spatialWorkers = (j.workers || []).filter((w) => w.id.startsWith('spatial'));
  const physics = (j.workers || []).find((w) => w.id === 'physics');
  const spatialStep = spatialWorkers.map((w) => w.statsSamplesAverage?.STEP_MS ?? 0);
  const spatialNeighbor = spatialWorkers.map((w) => w.statsSamplesAverage?.NEIGHBOR_MS ?? 0);
  const spatialGrid = spatialWorkers.map((w) => w.statsSamplesAverage?.GRID_CELLS_CHECKED ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    spatialCount: spatialWorkers.length,
    spatialStepMsSum: sum(spatialStep),
    spatialStepMsMax: Math.max(0, ...spatialStep),
    spatialNeighborMsSum: sum(spatialNeighbor),
    spatialGridCellsSum: sum(spatialGrid),
    spatialPerWorker: spatialWorkers.map((w) => ({
      id: w.id,
      STEP_MS: w.statsSamplesAverage?.STEP_MS ?? 0,
      NEIGHBOR_MS: w.statsSamplesAverage?.NEIGHBOR_MS ?? 0,
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

const { sizes, runs, warmupMs, durationMs } = parseArgs(process.argv.slice(2));
const originals = new Map(SCENES.map((s) => [s.file, fs.readFileSync(s.file, 'utf8')]));

const results = [];

console.log(
  `Spatial cellSize sweep | sizes=${sizes.join(',')} | runs=${runs} | headed | warmup ${warmupMs}ms measure ${durationMs}ms\n`
);

try {
  for (const scene of SCENES) {
    for (const cellSize of sizes) {
      console.log(`\n=== ${scene.key} cellSize=${cellSize} ===`);
      setSpatialCellSize(scene.file, cellSize);

      const runSummaries = [];
      for (let r = 0; r < runs; r++) {
        const out = path.join(
          repoRoot,
          'tests/results',
          `cellsize-${scene.key}-${cellSize}-r${r + 1}.json`
        );
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
        const j = JSON.parse(fs.readFileSync(out, 'utf8'));
        runSummaries.push(summarizeReport(j));
      }

      const row = {
        scene: scene.key,
        cellSize,
        defaultCellSize: scene.defaultCellSize,
        runs: runSummaries,
        aggregate: {
          spatialStepMsSum: seriesStats(runSummaries.map((x) => x.spatialStepMsSum)),
          spatialStepMsMax: seriesStats(runSummaries.map((x) => x.spatialStepMsMax)),
          spatialNeighborMsSum: seriesStats(runSummaries.map((x) => x.spatialNeighborMsSum)),
          spatialGridCellsSum: seriesStats(runSummaries.map((x) => x.spatialGridCellsSum)),
          physicsStepMs: seriesStats(runSummaries.map((x) => x.physicsStepMs)),
          BODY_COUNT: seriesStats(runSummaries.map((x) => x.BODY_COUNT)),
        },
      };
      results.push(row);

      const a = row.aggregate;
      console.log(
        `  median spatial STEP_MS sum=${a.spatialStepMsSum.median.toFixed(3)} (${a.spatialStepMsSum.loadPctMedian.toFixed(0)}%) ` +
          `max=${a.spatialStepMsMax.median.toFixed(3)} | NEIGHBOR_MS sum=${a.spatialNeighborMsSum.median.toFixed(3)} | ` +
          `GRID_CELLS=${a.spatialGridCellsSum.median.toFixed(0)} | physics STEP_MS=${a.physicsStepMs.median.toFixed(3)} | ` +
          `BODY_COUNT=${a.BODY_COUNT.median.toFixed(0)}`
      );
    }
  }
} finally {
  for (const [file, src] of originals) {
    fs.writeFileSync(file, src);
  }
  console.log('\nRestored scene configs.');
}

fs.mkdirSync(path.dirname(outReport), { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  chromiumMode: 'headed',
  warmupMs,
  durationMs,
  runsPerCell: runs,
  sizes,
  note: 'Primary: spatial STEP_MS (sum across workers + max). Load% vs 60 Hz budget. BODY_COUNT must stay similar across sizes for fair compare.',
  results,
};
fs.writeFileSync(outReport, JSON.stringify(payload, null, 2) + '\n');
console.log(`\nWrote ${outReport}`);
