#!/usr/bin/env node
/**
 * Headed Predator matrix → pick best config by primary metric and leave it applied.
 *
 * Primary: min median of max(logic0..2 STEP_MS); tie-break particle STEP_MS, then physics STEP_MS.
 *
 *   node tests/bench/run-predator-headed-pick.mjs
 *   node tests/bench/run-predator-headed-pick.mjs --runs 3
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { applyCombo as applyRay, restoreAll as restoreRay } from './ray-hyps/hypPatches.mjs';
import { applyCombo as applyDecal, restoreAll as restoreDecal } from './decal-hyps/hypPatches.mjs';
import { applyCombo as applyParticle, restoreAll as restoreParticle } from './particle-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/predator-headed-pick');

function parseArgs(argv) {
  const out = { runs: 3, warmupMs: DEFAULT_WARMUP_MS, durationMs: DEFAULT_DURATION_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || out.warmupMs;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || out.durationMs;
  }
  return out;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(hyp, base) {
  if (!(base > 0) || hyp == null) return null;
  return ((hyp - base) / base) * 100;
}

const ENTRANTS = [
  { label: 'BASE', what: 'all pre-opt', ray: [], decal: [], particle: [] },
  { label: 'RAY', what: 'stamp dedup + top-N castAll', ray: ['H6', 'H1'], decal: [], particle: [] },
  { label: 'D2', what: 'decal UV DDA', ray: [], decal: ['D2'], particle: [] },
  { label: 'P45', what: 'particle split + skip z/vz', ray: [], decal: [], particle: ['P4', 'P5'] },
  { label: 'D2_P45', what: 'decals+particles (no Ray)', ray: [], decal: ['D2'], particle: ['P4', 'P5'] },
  { label: 'RAY_D2_P45', what: 'Ray + D2 + P4+P5', ray: ['H6', 'H1'], decal: ['D2'], particle: ['P4', 'P5'] },
];

function applyEntrant(e) {
  restoreRay();
  restoreDecal();
  restoreParticle();
  if (e.ray.length) applyRay(e.ray);
  if (e.decal.length) applyDecal(e.decal);
  if (e.particle.length) applyParticle(e.particle);
}

function extract(report) {
  const workers = report.workers || [];
  const logics = workers.filter((w) => String(w.id || '').startsWith('logic') || w.type === 'logic');
  const particle = workers.find((w) => w.id === 'particle' || w.type === 'particle');
  const physics = workers.find((w) => w.id === 'physics' || w.type === 'physics');
  const logicSteps = logics.map((w) => w.statsSamplesAverage?.STEP_MS ?? 0);
  const logic0 = logics.find((w) => w.id === 'logic0') || logics[0];
  const aL = logic0?.statsSamplesAverage || {};
  const aP = particle?.statsSamplesAverage || {};
  const aPh = physics?.statsSamplesAverage || {};
  return {
    mainFPS: report.mainThreadAverageFPS ?? 0,
    logic0_STEP_MS: aL.STEP_MS ?? 0,
    logic_max_STEP_MS: logicSteps.length ? Math.max(...logicSteps) : 0,
    logic_RAYCAST_MS: aL.RAYCAST_MS ?? 0,
    logic_RAYCAST_COUNT: aL.RAYCAST_COUNT ?? 0,
    particle_STEP_MS: aP.STEP_MS ?? 0,
    particle_DECAL_STAMP_MS: aP.DECAL_STAMP_MS ?? 0,
    particle_PHYSICS_MS: aP.PARTICLE_PHYSICS_MS ?? 0,
    physics_STEP_MS: aPh.STEP_MS ?? 0,
    BODY_COUNT: aPh.BODY_COUNT ?? 0,
    particle_loadPct: workerLoadPct(aP.STEP_MS ?? 0),
  };
}

function runOnce(tag, i, args) {
  const out = path.join(outDir, `${tag}-r${i}.json`);
  execFileSync(
    process.execPath,
    [
      integratedRunner,
      '--headed',
      '--scene',
      '/demos/predatorScene/predatorScene.js',
      '--scene-export',
      'PredatorScene',
      '--warmup-ms',
      String(args.warmupMs),
      '--duration-ms',
      String(args.durationMs),
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return extract(JSON.parse(fs.readFileSync(out, 'utf8')));
}

function measure(e, args) {
  console.log(`\n======== MEASURE ${e.label}: ${e.what} ========`);
  applyEntrant(e);
  const samples = [];
  for (let i = 0; i < args.runs; i++) {
    console.log(`\n--- ${e.label} headed run ${i + 1}/${args.runs} ---`);
    samples.push(runOnce(e.label, i, args));
  }
  const keys = Object.keys(samples[0]);
  const summary = Object.fromEntries(
    keys.map((k) => [k, { median: median(samples.map((s) => s[k])), samples: samples.map((s) => s[k]) }])
  );
  return { ...e, summary, samples };
}

function score(result) {
  // Lower is better. Primary = logic max STEP (Predator bottleneck).
  return {
    primary: result.summary.logic_max_STEP_MS.median,
    particle: result.summary.particle_STEP_MS.median,
    physics: result.summary.physics_STEP_MS.median,
  };
}

function better(a, b) {
  const sa = score(a);
  const sb = score(b);
  if (sa.primary !== sb.primary) return sa.primary < sb.primary ? a : b;
  if (sa.particle !== sb.particle) return sa.particle < sb.particle ? a : b;
  return sa.physics <= sb.physics ? a : b;
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

console.log(
  `Predator headed pick: ${ENTRANTS.length} configs × ${args.runs} runs, warmup ${args.warmupMs}ms, duration ${args.durationMs}ms`
);
console.log('Keep Chromium visible and in front.');

const results = [];
try {
  for (const e of ENTRANTS) {
    results.push(measure(e, args));
  }
} catch (err) {
  console.error('Matrix failed:', err);
  // leave last attempted state; still try to apply BASE-safe ship guess
  applyEntrant(ENTRANTS[0]);
  throw err;
}

const base = results.find((r) => r.label === 'BASE');
let winner = results[0];
for (const r of results.slice(1)) winner = better(winner, r);

applyEntrant(winner);
console.log(`\nApplied winner: ${winner.label} (${winner.what})`);

const rows = results.map((r) => {
  const s = r.summary;
  return {
    label: r.label,
    what: r.what,
    logic_max_STEP_MS: s.logic_max_STEP_MS.median,
    logic0_STEP_MS: s.logic0_STEP_MS.median,
    logic_RAYCAST_MS: s.logic_RAYCAST_MS.median,
    logic_RAYCAST_COUNT: s.logic_RAYCAST_COUNT.median,
    particle_STEP_MS: s.particle_STEP_MS.median,
    particle_DECAL_STAMP_MS: s.particle_DECAL_STAMP_MS.median,
    particle_PHYSICS_MS: s.particle_PHYSICS_MS.median,
    physics_STEP_MS: s.physics_STEP_MS.median,
    BODY_COUNT: s.BODY_COUNT.median,
    mainFPS: s.mainFPS.median,
    d_logic_max: pct(s.logic_max_STEP_MS.median, base.summary.logic_max_STEP_MS.median),
    d_particle: pct(s.particle_STEP_MS.median, base.summary.particle_STEP_MS.median),
  };
});

const summary = {
  meta: { generatedAt: new Date().toISOString(), headed: true, ...args },
  winner: { label: winner.label, what: winner.what, ids: { ray: winner.ray, decal: winner.decal, particle: winner.particle } },
  rows,
  results: Object.fromEntries(results.map((r) => [r.label, { summary: r.summary, what: r.what }])),
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.log('\n================ PREDATOR HEADED PICK ================');
console.log(
  'label'.padEnd(12),
  'logicMax'.padStart(9),
  'dLogic'.padStart(8),
  'pSTEP'.padStart(7),
  'dPart'.padStart(8),
  'phys'.padStart(7),
  'FPS'.padStart(6)
);
for (const row of rows) {
  const dl = row.d_logic_max == null ? '' : `${row.d_logic_max > 0 ? '+' : ''}${row.d_logic_max.toFixed(1)}%`;
  const dp = row.d_particle == null ? '' : `${row.d_particle > 0 ? '+' : ''}${row.d_particle.toFixed(1)}%`;
  const mark = row.label === winner.label ? ' *' : '';
  console.log(
    (row.label + mark).padEnd(12),
    row.logic_max_STEP_MS.toFixed(2).padStart(9),
    dl.padStart(8),
    row.particle_STEP_MS.toFixed(2).padStart(7),
    dp.padStart(8),
    row.physics_STEP_MS.toFixed(2).padStart(7),
    row.mainFPS.toFixed(1).padStart(6)
  );
}
console.log(`\nWinner: ${winner.label} — ${winner.what}`);
console.log(`Wrote ${path.join(outDir, 'summary.json')}`);
