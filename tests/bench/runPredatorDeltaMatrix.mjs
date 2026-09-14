#!/usr/bin/env node
/**
 * PredatorScene A/B matrix for recent champions:
 *   BASE (all pre-opt) |
 *   Ray stamp-dedup alone | Ray top-N alone | Ray both |
 *   Decal UV-DDA alone | Particle P4+P5 alone |
 *   ALL champions together
 *
 *   node tests/bench/run-predator-delta-matrix.mjs
 *   node tests/bench/run-predator-delta-matrix.mjs --runs 2 --warmup-ms 8000 --duration-ms 10000
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import {
  applyCombo as applyRayCombo,
  restoreAll as restoreRay,
} from './ray-hyps/hypPatches.mjs';
import {
  applyCombo as applyDecalCombo,
  restoreAll as restoreDecal,
} from './decal-hyps/hypPatches.mjs';
import {
  applyCombo as applyParticleCombo,
  restoreAll as restoreParticle,
} from './particle-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/predator-delta-matrix');

function parseArgs(argv) {
  const out = { runs: 2, warmupMs: 8000, durationMs: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || 8000;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || 10000;
  }
  return out;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pctDelta(hyp, base) {
  if (base == null || !(base > 0) || hyp == null) return null;
  return ((hyp - base) / base) * 100;
}

function applyEntrant({ ray = [], decal = [], particle = [] }) {
  restoreRay();
  restoreDecal();
  restoreParticle();
  if (ray.length) applyRayCombo(ray);
  if (decal.length) applyDecalCombo(decal);
  if (particle.length) applyParticleCombo(particle);
}

function workerAvg(report, prefer) {
  const workers = report.workers || [];
  for (const id of prefer) {
    const w = workers.find((x) => x.id === id || x.type === id);
    if (w) return { id: w.id, avg: w.statsSamplesAverage || {}, fps: w.averageFPS ?? 0 };
  }
  return { id: null, avg: {}, fps: 0 };
}

function extract(report) {
  const logic = workerAvg(report, ['logic0', 'logic']);
  const particle = workerAvg(report, ['particle']);
  const aL = logic.avg;
  const aP = particle.avg;
  return {
    mainFPS: report.mainThreadAverageFPS ?? report.averageFPS ?? 0,
    logic: {
      STEP_MS: aL.STEP_MS ?? 0,
      RAYCAST_MS: aL.RAYCAST_MS ?? 0,
      RAYCAST_COUNT: aL.RAYCAST_COUNT ?? 0,
      ENTITIES_PROCESSED: aL.ENTITIES_PROCESSED ?? 0,
      loadPct: workerLoadPct(aL.STEP_MS ?? 0),
      fps: logic.fps,
    },
    particle: {
      STEP_MS: aP.STEP_MS ?? 0,
      DECAL_STAMP_MS: aP.DECAL_STAMP_MS ?? 0,
      PARTICLE_PHYSICS_MS: aP.PARTICLE_PHYSICS_MS ?? 0,
      BUILD_ACTIVE_VISIBLE_MS: aP.BUILD_ACTIVE_VISIBLE_MS ?? 0,
      PARTICLES_STAMPED: aP.PARTICLES_STAMPED ?? 0,
      ACTIVE_PARTICLES: aP.ACTIVE_PARTICLES ?? 0,
      loadPct: workerLoadPct(aP.STEP_MS ?? 0),
      fps: particle.fps,
    },
  };
}

function runPredator(tag, runIndex, args) {
  const out = path.join(outDir, `${tag}-r${runIndex}.json`);
  execFileSync(
    process.execPath,
    [
      integratedRunner,
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

function measure(label, ids, args) {
  console.log(`\n======== MEASURE ${label} ========`);
  applyEntrant(ids);
  const runs = [];
  for (let r = 0; r < args.runs; r++) {
    console.log(`\n--- ${label} run ${r + 1}/${args.runs} ---`);
    runs.push(runPredator(label, r, args));
  }
  const keysLogic = ['STEP_MS', 'RAYCAST_MS', 'RAYCAST_COUNT', 'ENTITIES_PROCESSED', 'loadPct', 'fps'];
  const keysParticle = [
    'STEP_MS',
    'DECAL_STAMP_MS',
    'PARTICLE_PHYSICS_MS',
    'BUILD_ACTIVE_VISIBLE_MS',
    'PARTICLES_STAMPED',
    'ACTIVE_PARTICLES',
    'loadPct',
    'fps',
  ];
  const summary = {
    label,
    ids,
    mainFPS: { median: median(runs.map((x) => x.mainFPS)), samples: runs.map((x) => x.mainFPS) },
    logic: Object.fromEntries(
      keysLogic.map((k) => [k, { median: median(runs.map((x) => x.logic[k])), samples: runs.map((x) => x.logic[k]) }])
    ),
    particle: Object.fromEntries(
      keysParticle.map((k) => [
        k,
        { median: median(runs.map((x) => x.particle[k])), samples: runs.map((x) => x.particle[k]) },
      ])
    ),
  };
  return summary;
}

function fmtPct(d) {
  if (d == null) return 'n/a';
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}%`;
}

const ENTRANTS = [
  { label: 'BASE', ids: { ray: [], decal: [], particle: [] }, what: 'antes (sin campeones)' },
  {
    label: 'RAY_stamp',
    ids: { ray: ['H6'], decal: [], particle: [] },
    what: 'solo Ray: stamp dedup (sin Set)',
  },
  {
    label: 'RAY_topN',
    ids: { ray: ['H1'], decal: [], particle: [] },
    what: 'solo Ray: top-N early-out en castAll',
  },
  {
    label: 'RAY_both',
    ids: { ray: ['H6', 'H1'], decal: [], particle: [] },
    what: 'Ray juntos: stamp + top-N',
  },
  {
    label: 'DECAL_D2',
    ids: { ray: [], decal: ['D2'], particle: [] },
    what: 'solo Decals: UV DDA entero',
  },
  {
    label: 'PART_P45',
    ids: { ray: [], decal: [], particle: ['P4', 'P5'] },
    what: 'solo Particles: split flat/heighted + skip z/vz flat',
  },
  {
    label: 'ALL',
    ids: { ray: ['H6', 'H1'], decal: ['D2'], particle: ['P4', 'P5'] },
    what: 'todos juntos (estado producción objetivo)',
  },
];

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

const results = {};
try {
  for (const e of ENTRANTS) {
    results[e.label] = { ...measure(e.label, e.ids, args), what: e.what };
  }
} finally {
  // Leave production champions applied.
  applyEntrant({ ray: ['H6', 'H1'], decal: ['D2'], particle: ['P4', 'P5'] });
  console.log('\nRestored production champions: Ray H6+H1, Decal D2, Particle P4+P5');
}

const base = results.BASE;
const rows = [];
for (const e of ENTRANTS) {
  const r = results[e.label];
  const row = {
    label: e.label,
    what: e.what,
    mainFPS: r.mainFPS.median,
    logic_STEP_MS: r.logic.STEP_MS.median,
    logic_RAYCAST_MS: r.logic.RAYCAST_MS.median,
    logic_RAYCAST_COUNT: r.logic.RAYCAST_COUNT.median,
    particle_STEP_MS: r.particle.STEP_MS.median,
    particle_DECAL_STAMP_MS: r.particle.DECAL_STAMP_MS.median,
    particle_PHYSICS_MS: r.particle.PARTICLE_PHYSICS_MS.median,
    d_logic_STEP: pctDelta(r.logic.STEP_MS.median, base.logic.STEP_MS.median),
    d_logic_RAYCAST: pctDelta(r.logic.RAYCAST_MS.median, base.logic.RAYCAST_MS.median),
    d_particle_STEP: pctDelta(r.particle.STEP_MS.median, base.particle.STEP_MS.median),
    d_decal_stamp: pctDelta(r.particle.DECAL_STAMP_MS.median, base.particle.DECAL_STAMP_MS.median),
    d_particle_phys: pctDelta(r.particle.PARTICLE_PHYSICS_MS.median, base.particle.PARTICLE_PHYSICS_MS.median),
    d_mainFPS: pctDelta(r.mainFPS.median, base.mainFPS.median),
  };
  rows.push(row);
}

const summary = {
  meta: { generatedAt: new Date().toISOString(), ...args, scene: 'PredatorScene', headless: true },
  rows,
  results,
};

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.log('\n================ PREDATOR DELTA MATRIX ================');
console.log(
  'label'.padEnd(12),
  'logicSTEP'.padStart(10),
  'dSTEP'.padStart(8),
  'RAY_MS'.padStart(8),
  'dRAY'.padStart(8),
  'pSTEP'.padStart(8),
  'dP'.padStart(8),
  'stamp'.padStart(8),
  'phys'.padStart(8),
  'FPS'.padStart(7)
);
for (const row of rows) {
  console.log(
    row.label.padEnd(12),
    row.logic_STEP_MS.toFixed(2).padStart(10),
    fmtPct(row.d_logic_STEP).padStart(8),
    row.logic_RAYCAST_MS.toFixed(2).padStart(8),
    fmtPct(row.d_logic_RAYCAST).padStart(8),
    row.particle_STEP_MS.toFixed(2).padStart(8),
    fmtPct(row.d_particle_STEP).padStart(8),
    row.particle_DECAL_STAMP_MS.toFixed(3).padStart(8),
    row.particle_PHYSICS_MS.toFixed(3).padStart(8),
    row.mainFPS.toFixed(1).padStart(7)
  );
}
console.log(`\nWrote ${path.join(outDir, 'summary.json')}`);
for (const row of rows) {
  console.log(`- ${row.label}: ${row.what}`);
}
