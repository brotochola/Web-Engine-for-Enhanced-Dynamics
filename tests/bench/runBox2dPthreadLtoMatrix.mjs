#!/usr/bin/env node
/**
 * 2×2 matrix: Box2D WASM pthread pool (2|4) × LTO (on|off).
 * Per case: patch BallsScene box2dWorkerCount, rebuild sibling wasm, headed median bench.
 * Restores box2dWorkerCount=4 and t4_flto_full wasm at the end.
 *
 * Usage:
 *   node tests/bench/run-box2d-pthread-lto-matrix.mjs
 *   node tests/bench/run-box2d-pthread-lto-matrix.mjs --runs 5
 *   node tests/bench/run-box2d-pthread-lto-matrix.mjs --skip-build   # reuse current wasm (debug)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const ballsScenePath = path.join(repoRoot, 'demos/ballsScene/ballsScene.js');
const siblingRoot = path.resolve(repoRoot, '../Box2d_3.2_C_-_liquidfun');
const buildBat = path.join(siblingRoot, 'weedjs', 'build_for_weed.bat');
const medianRunner = path.join(repoRoot, 'tests/bench/run-headed-median.mjs');
const resultsDir = path.join(repoRoot, 'tests/results');

const CASES = [
  { label: 't2_lto', threads: 2, lto: 1 },
  { label: 't4_lto', threads: 4, lto: 1 },
  { label: 't2_nolto', threads: 2, lto: 0 },
  { label: 't4_nolto', threads: 4, lto: 0 },
];

function parseArgs(argv) {
  const out = { runs: 5, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === '--skip-build') out.skipBuild = true;
  }
  return out;
}

function setBallsSceneWorkerCount(n) {
  const src = fs.readFileSync(ballsScenePath, 'utf8');
  const re = /(\bbox2dWorkerCount\s*:\s*)(\d+)(\s*,)/;
  const m = src.match(re);
  if (!m) {
    throw new Error(`Could not find box2dWorkerCount in ${ballsScenePath}`);
  }
  if (Number(m[2]) === n) {
    console.log(`BallsScene box2dWorkerCount already ${n}`);
    return;
  }
  const next = src.replace(re, `$1${n}$3`);
  fs.writeFileSync(ballsScenePath, next, 'utf8');
  console.log(`BallsScene box2dWorkerCount -> ${n}`);
}

function buildWeedWasm(threads, lto) {
  if (!fs.existsSync(buildBat)) {
    throw new Error(`Missing build script: ${buildBat}`);
  }
  console.log(`\n=== build_for_weed.bat ${threads} ${lto} ===\n`);
  execFileSync('cmd.exe', ['/c', buildBat, String(threads), String(lto)], {
    stdio: 'inherit',
    cwd: siblingRoot,
  });
}

function runMedian(label, runs) {
  const outPath = path.join(resultsDir, `box2d-pthread-lto-${label}.json`);
  fs.mkdirSync(resultsDir, { recursive: true });
  console.log(`\n=== headed median (${label}, runs=${runs}) ===\n`);
  execFileSync(
    process.execPath,
    [medianRunner, '--runs', String(runs), '--json-out', outPath],
    { stdio: 'inherit', cwd: repoRoot },
  );
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

function fmt(n, digits = 3) {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function pickSummary(report, field) {
  return report?.summary?.physics?.[field] ?? null;
}

function printComparison(reportsByLabel) {
  console.log('\n========== Pthread × LTO matrix (physics) ==========');
  console.log(
    'label'.padEnd(12) +
      'STEP_MS'.padStart(10) +
      'Load%'.padStart(8) +
      'BOX2D_MS'.padStart(10) +
      'BODY'.padStart(8) +
      'AWAKE'.padStart(8) +
      'CV_step'.padStart(10),
  );

  const rows = [];
  for (const { label } of CASES) {
    const r = reportsByLabel[label];
    if (!r) continue;
    const step = pickSummary(r, 'STEP_MS');
    const box2d = pickSummary(r, 'BOX2D_MS');
    const body = pickSummary(r, 'BODY_COUNT');
    const awake = pickSummary(r, 'AWAKE_COUNT');
    const stepMed = step?.median;
    const load = Number.isFinite(stepMed) ? workerLoadPct(stepMed).toFixed(0) + '%' : 'n/a';
    rows.push({
      label,
      stepMed,
      box2dMed: box2d?.median,
      bodyMed: body?.median,
      awakeMed: awake?.median,
      stepCv: step?.cv,
    });
    console.log(
      label.padEnd(12) +
        fmt(stepMed).padStart(10) +
        load.padStart(8) +
        fmt(box2d?.median).padStart(10) +
        fmt(body?.median, 0).padStart(8) +
        fmt(awake?.median, 0).padStart(8) +
        (step?.cv != null ? `${(100 * step.cv).toFixed(1)}%` : 'n/a').padStart(10),
    );
  }

  const bodies = rows.map((r) => r.bodyMed).filter(Number.isFinite);
  if (bodies.length >= 2) {
    const meanBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
    const maxRel = Math.max(...bodies.map((b) => Math.abs(b - meanBody) / meanBody));
    if (maxRel > 0.05) {
      console.log(
        `\nWARN: BODY_COUNT medians diverge (max rel ${(100 * maxRel).toFixed(1)}% vs mean) — compare with care.`,
      );
    } else {
      console.log('\nBODY_COUNT medians within ~5% — workloads comparable.');
    }
  }

  const withStep = rows.filter((r) => Number.isFinite(r.stepMed));
  if (withStep.length) {
    withStep.sort((a, b) => a.stepMed - b.stepMed);
    const best = withStep[0];
    console.log(
      `\nLowest STEP_MS: ${best.label} (median ${fmt(best.stepMed)}` +
        (Number.isFinite(best.box2dMed) ? `, BOX2D_MS ${fmt(best.box2dMed)}` : '') +
        ')',
    );
  }
  console.log('====================================================\n');
}

const { runs, skipBuild } = parseArgs(process.argv.slice(2));
const reportsByLabel = Object.create(null);
let exitCode = 0;

try {
  if (!skipBuild && !fs.existsSync(buildBat)) {
    console.error(`ERROR: sibling build missing: ${buildBat}`);
    process.exit(1);
  }

  for (const c of CASES) {
    console.log(`\n######## CASE ${c.label} (threads=${c.threads} lto=${c.lto}) ########`);
    setBallsSceneWorkerCount(c.threads);
    if (!skipBuild) buildWeedWasm(c.threads, c.lto);
    try {
      reportsByLabel[c.label] = runMedian(c.label, runs);
    } catch (err) {
      console.error(`Case ${c.label} failed:`, err?.message || err);
      exitCode = 1;
    }
  }

  printComparison(reportsByLabel);
} finally {
  try {
    setBallsSceneWorkerCount(4);
  } catch (err) {
    console.error('Failed to restore BallsScene box2dWorkerCount=4:', err?.message || err);
    exitCode = 1;
  }
  if (!skipBuild) {
    try {
      console.log('\n=== restore default wasm (t4 flto=full) ===\n');
      buildWeedWasm(4, 'full');
    } catch (err) {
      console.error('Failed to restore t4 flto=full wasm:', err?.message || err);
      exitCode = 1;
    }
  }
}

process.exit(exitCode);
