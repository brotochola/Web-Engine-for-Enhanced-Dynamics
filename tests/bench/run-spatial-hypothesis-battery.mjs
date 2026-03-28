#!/usr/bin/env node
/**
 * Headed (or headless) integrated BallsScene benchmark; reports physics + spatial worker metrics.
 *
 * Usage:
 *   node tests/bench/run-spatial-hypothesis-battery.mjs
 *   node tests/bench/run-spatial-hypothesis-battery.mjs --headless --warmup-ms 5000 --duration-ms 4000
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests', 'results');

function parseArgs(argv) {
  const out = { headless: false, warmupMs: 10000, durationMs: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headless') out.headless = true;
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || out.warmupMs;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || out.durationMs;
  }
  return out;
}

const { headless, warmupMs, durationMs } = parseArgs(process.argv.slice(2));

const variants = [
  {
    id: 'balls_scene_default',
    description: 'BallsScene as configured in demos/scenes/BallsScene.js (no benchmark patches)',
    extraArgs: [],
  },
];

function pickMetrics(report) {
  const workers = report.workers || [];
  const row = (id) => workers.find((w) => w.id === id);
  const spatial = ['spatial0', 'spatial1'].map((id) => {
    const w = row(id);
    if (!w) return { id, averageFPS: null, statsSamplesAverage: null };
    return {
      id,
      averageFPS: w.averageFPS,
      statsSamplesAverage: w.statsSamplesAverage || null,
    };
  });
  const ph = row('physics');
  return {
    mainThread: report.mainThread?.averageFPS,
    physics: ph
      ? {
          averageFPS: ph.averageFPS,
          statsSamplesAverage: ph.statsSamplesAverage || null,
        }
      : null,
    spatial,
  };
}

const battery = {
  meta: {
    headed: !headless,
    warmupMs,
    durationMs,
    generatedAt: new Date().toISOString(),
    note: 'See tests/bench/SPATIAL_WORKER_OPTIMIZATION_LOG.md for autonomous hypothesis history.',
  },
  runs: [],
};

fs.mkdirSync(outDir, { recursive: true });

for (const v of variants) {
  const outPath = path.join(outDir, `spatial-battery-${v.id}.json`);
  const args = [
    runner,
    ...(headless ? [] : ['--headed']),
    '--warmup-ms',
    String(warmupMs),
    '--duration-ms',
    String(durationMs),
    '--output',
    outPath,
    ...v.extraArgs,
  ];

  console.log(`\n>>> ${v.id}\n    ${v.description}\n`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: repoRoot });
  if (r.status !== 0) {
    console.error(`Battery failed on variant ${v.id}`);
    process.exit(r.status ?? 1);
  }

  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  battery.runs.push({
    variant: v.id,
    description: v.description,
    extraArgs: v.extraArgs,
    outputPath: path.relative(repoRoot, outPath).replace(/\\/g, '/'),
    metrics: pickMetrics(report),
  });
}

const summaryPath = path.join(outDir, 'spatial-hypothesis-battery-summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(battery, null, 2) + '\n', 'utf8');
console.log(`\nWrote ${path.relative(repoRoot, summaryPath)}`);
