#!/usr/bin/env node
/**
 * Predator A/B after Ray revert:
 *   BASE_full = all pre-opt baselines
 *   SHIP      = Ray baseline + Decal D2 + Particle P4+P5
 *
 * Leaves SHIP applied.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { restoreAll as restoreRay } from './ray-hyps/hypPatches.mjs';
import { applyCombo as applyDecal, restoreAll as restoreDecal } from './decal-hyps/hypPatches.mjs';
import { applyCombo as applyParticle, restoreAll as restoreParticle } from './particle-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/predator-ship-confirm');

const runs = 2;
const warmupMs = 8000;
const durationMs = 10000;

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(hyp, base) {
  if (!(base > 0) || hyp == null) return null;
  return ((hyp - base) / base) * 100;
}

function apply(mode) {
  restoreRay();
  restoreDecal();
  restoreParticle();
  if (mode === 'SHIP') {
    applyDecal(['D2']);
    applyParticle(['P4', 'P5']);
  }
}

function extract(report) {
  const workers = report.workers || [];
  const logic = workers.find((w) => w.id === 'logic0' || w.type === 'logic') || {};
  const particle = workers.find((w) => w.id === 'particle' || w.type === 'particle') || {};
  const aL = logic.statsSamplesAverage || {};
  const aP = particle.statsSamplesAverage || {};
  return {
    logic_STEP_MS: aL.STEP_MS ?? 0,
    logic_RAYCAST_MS: aL.RAYCAST_MS ?? 0,
    logic_RAYCAST_COUNT: aL.RAYCAST_COUNT ?? 0,
    particle_STEP_MS: aP.STEP_MS ?? 0,
    particle_DECAL_STAMP_MS: aP.DECAL_STAMP_MS ?? 0,
    particle_PHYSICS_MS: aP.PARTICLE_PHYSICS_MS ?? 0,
    particle_loadPct: workerLoadPct(aP.STEP_MS ?? 0),
  };
}

function runOnce(tag, i) {
  const out = path.join(outDir, `${tag}-r${i}.json`);
  execFileSync(
    process.execPath,
    [
      integratedRunner,
      '--scene',
      '/demos/predatorScene/predatorScene.js',
      '--scene-export',
      'PredatorScene',
      '--warmup-ms',
      String(warmupMs),
      '--duration-ms',
      String(durationMs),
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return extract(JSON.parse(fs.readFileSync(out, 'utf8')));
}

function measure(tag, mode) {
  console.log(`\n======== ${tag} (${mode}) ========`);
  apply(mode);
  const samples = [];
  for (let i = 0; i < runs; i++) {
    console.log(`\n--- ${tag} run ${i + 1}/${runs} ---`);
    samples.push(runOnce(tag, i));
  }
  const keys = Object.keys(samples[0]);
  return Object.fromEntries(
    keys.map((k) => [k, { median: median(samples.map((s) => s[k])), samples: samples.map((s) => s[k]) }])
  );
}

fs.mkdirSync(outDir, { recursive: true });

let base;
let ship;
try {
  base = measure('BASE_full', 'BASE');
  ship = measure('SHIP', 'SHIP');
} finally {
  apply('SHIP');
  console.log('\nLeft SHIP applied: Ray baseline + D2 + P4+P5');
}

const keys = [
  'logic_STEP_MS',
  'logic_RAYCAST_MS',
  'logic_RAYCAST_COUNT',
  'particle_STEP_MS',
  'particle_DECAL_STAMP_MS',
  'particle_PHYSICS_MS',
];
const rows = keys.map((k) => ({
  metric: k,
  BASE_full: base[k].median,
  SHIP: ship[k].median,
  deltaPct: pct(ship[k].median, base[k].median),
}));

const summary = {
  meta: { generatedAt: new Date().toISOString(), runs, warmupMs, durationMs, scene: 'PredatorScene' },
  rows,
  base,
  ship,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.log('\n================ PREDATOR SHIP CONFIRM ================');
for (const r of rows) {
  const d = r.deltaPct == null ? 'n/a' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`;
  console.log(
    r.metric.padEnd(28),
    r.BASE_full.toFixed(3).padStart(10),
    r.SHIP.toFixed(3).padStart(10),
    d.padStart(8)
  );
}
console.log(`\nWrote ${path.join(outDir, 'summary.json')}`);
