#!/usr/bin/env node
/**
 * Headless repeated integrated BallsScene benchmark at the scene's configured spatial settings.
 * Writes tests/results/research-spatial-cell.json (relative to repo root).
 *
 *   node tests/bench/run-spatial-cell-study.mjs
 *   node tests/bench/run-spatial-cell-study.mjs --runs 3 --warmup-ms 10000 --duration-ms 8000
 *
 * To compare different spatial.cellSize values, change `demos/scenes/BallsScene.js` static config
 * between runs (no CLI overrides).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outReport = path.join(repoRoot, 'tests', 'results', 'research-spatial-cell.json');

function parseArgs(argv) {
  const o = { runs: 2, warmupMs: 10_000, durationMs: 8_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) o.runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) o.warmupMs = parseInt(argv[++i], 10) || 10_000;
    else if (a === '--duration-ms' && argv[i + 1]) o.durationMs = parseInt(argv[++i], 10) || 8_000;
  }
  return o;
}

function mean(arr) {
  return arr.reduce((x, y) => x + y, 0) / arr.length;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const mu = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1));
}

const { runs, warmupMs, durationMs } = parseArgs(process.argv.slice(2));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-cell-'));

const physicsFps = [];
const collisionChecks = [];
const collisionMs = [];

console.log(
  `BallsScene benchmark: ${runs} run(s) | headless | warmup ${warmupMs}ms measure ${durationMs}ms\n` +
    '(Spatial settings come from BallsScene static config.)\n'
);

for (let r = 0; r < runs; r++) {
  const file = path.join(tmpDir, `run-${r}.json`);
  execFileSync(
    process.execPath,
    [
      runner,
      '--warmup-ms',
      String(warmupMs),
      '--duration-ms',
      String(durationMs),
      '--output',
      file,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ph = j.workers.find((w) => w.id === 'physics');
  physicsFps.push(ph.averageFPS);
  collisionChecks.push(ph.statsSamplesAverage?.COLLISION_CHECKS ?? 0);
  collisionMs.push(ph.statsSamplesAverage?.COLLISION_MS ?? 0);
}

try {
  fs.rmSync(tmpDir, { recursive: true });
} catch {
  /* ignore */
}

const row = {
  physicsFps: { median: median(physicsFps), mean: mean(physicsFps), stdev: stdev(physicsFps), samples: physicsFps },
  collisionChecks: {
    median: median(collisionChecks),
    mean: mean(collisionChecks),
    stdev: stdev(collisionChecks),
    samples: collisionChecks,
  },
  collisionMs: {
    median: median(collisionMs),
    mean: mean(collisionMs),
    samples: collisionMs,
  },
};

console.log(
  `physics FPS median ${row.physicsFps.median.toFixed(2)} | checks median ${row.collisionChecks.median.toFixed(0)}`
);

const payload = {
  generatedAt: new Date().toISOString(),
  chromiumMode: 'headless',
  warmupMs,
  durationMs,
  runs,
  note: 'Spatial cellSize and worker counts are from BallsScene static config (no CLI patch).',
  results: [row],
};

fs.mkdirSync(path.dirname(outReport), { recursive: true });
fs.writeFileSync(outReport, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`\nWrote ${outReport}`);
