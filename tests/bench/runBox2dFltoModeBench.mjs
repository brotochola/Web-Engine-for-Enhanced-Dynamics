#!/usr/bin/env node
/**
 * Headed median A/B: -flto vs -flto=full at 4 pthreads (BallsScene box2dWorkerCount=4).
 * Restores default wasm (4 pthreads, -flto=full) at the end.
 *
 * Usage:
 *   node tests/bench/run-box2d-flto-mode-bench.mjs
 *   node tests/bench/run-box2d-flto-mode-bench.mjs --runs 5
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
  { label: 't4_flto', ltoArg: '1' },
  { label: 't4_flto_full', ltoArg: 'full' },
];

function parseArgs(argv) {
  const out = { runs: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
  }
  return out;
}

function setBallsSceneWorkerCount(n) {
  const src = fs.readFileSync(ballsScenePath, 'utf8');
  const re = /(\bbox2dWorkerCount\s*:\s*)(\d+)(\s*,)/;
  const m = src.match(re);
  if (!m) throw new Error(`Could not find box2dWorkerCount in ${ballsScenePath}`);
  if (Number(m[2]) === n) {
    console.log(`BallsScene box2dWorkerCount already ${n}`);
    return;
  }
  fs.writeFileSync(ballsScenePath, src.replace(re, `$1${n}$3`), 'utf8');
  console.log(`BallsScene box2dWorkerCount -> ${n}`);
}

function buildWeedWasm(ltoArg) {
  console.log(`\n=== build_for_weed.bat 4 ${ltoArg} ===\n`);
  execFileSync('cmd.exe', ['/c', buildBat, '4', String(ltoArg)], {
    stdio: 'inherit',
    cwd: siblingRoot,
  });
}

function runMedian(label, runs) {
  const outPath = path.join(resultsDir, `box2d-flto-mode-${label}.json`);
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

function pick(report, field) {
  return report?.summary?.physics?.[field] ?? null;
}

function printComparison(reports) {
  console.log('\n========== -flto vs -flto=full @ 4 pthreads ==========');
  console.log(
    'label'.padEnd(14) +
      'STEP_MS'.padStart(10) +
      'Load%'.padStart(8) +
      'BOX2D_MS'.padStart(10) +
      'BODY'.padStart(8) +
      'CV_step'.padStart(10),
  );
  const rows = [];
  for (const { label } of CASES) {
    const r = reports[label];
    if (!r) continue;
    const step = pick(r, 'STEP_MS');
    const box2d = pick(r, 'BOX2D_MS');
    const body = pick(r, 'BODY_COUNT');
    const stepMed = step?.median;
    rows.push({ label, stepMed, box2dMed: box2d?.median, bodyMed: body?.median, cv: step?.cv });
    console.log(
      label.padEnd(14) +
        fmt(stepMed).padStart(10) +
        (Number.isFinite(stepMed) ? `${workerLoadPct(stepMed).toFixed(0)}%` : 'n/a').padStart(8) +
        fmt(box2d?.median).padStart(10) +
        fmt(body?.median, 0).padStart(8) +
        (step?.cv != null ? `${(100 * step.cv).toFixed(1)}%` : 'n/a').padStart(10),
    );
  }
  const a = rows.find((r) => r.label === 't4_flto');
  const b = rows.find((r) => r.label === 't4_flto_full');
  if (a?.stepMed != null && b?.stepMed != null) {
    const dStep = ((b.stepMed - a.stepMed) / a.stepMed) * 100;
    const dBox =
      a.box2dMed != null && b.box2dMed != null
        ? ((b.box2dMed - a.box2dMed) / a.box2dMed) * 100
        : null;
    console.log(
      `\nfull vs -flto: STEP_MS ${dStep >= 0 ? '+' : ''}${dStep.toFixed(1)}%` +
        (dBox != null ? `, BOX2D_MS ${dBox >= 0 ? '+' : ''}${dBox.toFixed(1)}%` : '') +
        ' (negative = full faster)',
    );
    const best = b.stepMed < a.stepMed ? 't4_flto_full' : 't4_flto';
    console.log(`Lowest STEP_MS: ${best}`);
  }
  console.log('=====================================================\n');
}

const { runs } = parseArgs(process.argv.slice(2));
const reports = Object.create(null);
let exitCode = 0;

try {
  if (!fs.existsSync(buildBat)) {
    console.error(`ERROR: missing ${buildBat}`);
    process.exit(1);
  }
  setBallsSceneWorkerCount(4);
  for (const c of CASES) {
    console.log(`\n######## CASE ${c.label} ########`);
    try {
      buildWeedWasm(c.ltoArg);
      reports[c.label] = runMedian(c.label, runs);
    } catch (err) {
      console.error(`Case ${c.label} failed:`, err?.message || err);
      exitCode = 1;
    }
  }
  printComparison(reports);
} finally {
  try {
    setBallsSceneWorkerCount(4);
  } catch (err) {
    console.error(err?.message || err);
    exitCode = 1;
  }
  try {
    console.log('\n=== restore default wasm (4 pthreads, -flto=full) ===\n');
    buildWeedWasm('full');
  } catch (err) {
    console.error('Failed to restore -flto=full wasm:', err?.message || err);
    exitCode = 1;
  }
}

process.exit(exitCode);
