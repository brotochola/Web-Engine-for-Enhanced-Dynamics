#!/usr/bin/env node
/**
 * Grid sweep: neighborReuseSkin × neighborReuseMaxFrames on Balls + Predator.
 *
 *   node tests/bench/run-neighbor-reuse-grid.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const defaultsPath = path.join(repoRoot, 'src/core/ConfigDefaults.js');
const outDir = path.join(repoRoot, 'tests/results/neighbor-reuse');
const summaryPath = path.join(outDir, 'skin-frames-grid.json');

const SKINS = [0, 0.01, 0.05, 0.1, 0.15, 0.2, 0.25, 0.35, 0.4, 0.75];
const FRAMES = [1, 5, 10, 15, 20, 30];
const WARMUP_MS = 12_000;
const DURATION_MS = 10_000;

const SCENES = [
  { key: 'balls', scene: '/demos/ballsScene/ballsScene.js', exportName: 'BallsScene' },
  { key: 'predator', scene: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene' },
];

const defaultsOriginal = fs.readFileSync(defaultsPath, 'utf8');

function patchDefaults(skin, maxFrames) {
  let src = defaultsOriginal;
  if (!/neighborReuseSkin:\s*[\d.]+/.test(src)) {
    throw new Error('neighborReuseSkin not found in ConfigDefaults.js');
  }
  if (!/neighborReuseMaxFrames:\s*\d+/.test(src)) {
    throw new Error('neighborReuseMaxFrames not found in ConfigDefaults.js');
  }
  src = src.replace(/neighborReuseSkin:\s*[\d.]+/, `neighborReuseSkin: ${skin}`);
  src = src.replace(/neighborReuseMaxFrames:\s*\d+/, `neighborReuseMaxFrames: ${maxFrames}`);
  fs.writeFileSync(defaultsPath, src);
}

function restoreDefaults() {
  fs.writeFileSync(defaultsPath, defaultsOriginal);
}

function summarize(j) {
  const spatial = (j.workers || []).filter((w) => w.id.startsWith('spatial'));
  const physics = (j.workers || []).find((w) => w.id === 'physics');
  const steps = spatial.map((w) => w.statsSamplesAverage?.STEP_MS ?? 0);
  const neigh = spatial.map((w) => w.statsSamplesAverage?.NEIGHBOR_MS ?? 0);
  const rebuild = spatial.map((w) => w.statsSamplesAverage?.REBUILD_MS ?? 0);
  const reused = spatial.map((w) => w.statsSamplesAverage?.NEIGHBORS_REUSED ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    spatialCount: spatial.length,
    stepMax: Math.max(0, ...steps),
    stepSum: sum(steps),
    neighborSum: sum(neigh),
    rebuildSum: sum(rebuild),
    reusedSum: sum(reused),
    reusedMax: Math.max(0, ...reused),
    BODY_COUNT: physics?.statsSamplesAverage?.BODY_COUNT ?? 0,
    loadPctMax: workerLoadPct(Math.max(0, ...steps)),
  };
}

function runOne(scene, skin, frames) {
  const tag = `skin${String(skin).replace('.', 'p')}-f${frames}-${scene.key}`;
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
  return { tag, file: out, ...summarize(JSON.parse(fs.readFileSync(out, 'utf8'))) };
}

function buildConfigs() {
  const configs = [{ skin: 0, frames: 10 }]; // frames placeholder unused when skin=0
  for (const skin of SKINS) {
    if (skin === 0) continue;
    for (const frames of FRAMES) {
      configs.push({ skin, frames });
    }
  }
  return configs;
}

fs.mkdirSync(outDir, { recursive: true });
const configs = buildConfigs();
const results = [];

console.log(
  `Neighbor reuse grid | configs=${configs.length} | scenes=2 | headed | ` +
    `warmup ${WARMUP_MS}ms measure ${DURATION_MS}ms\n`
);

try {
  for (const cfg of configs) {
    const framesForPatch = cfg.skin === 0 ? 10 : cfg.frames;
    patchDefaults(cfg.skin, framesForPatch);
    for (const scene of SCENES) {
      console.log(`\n=== skin=${cfg.skin} frames=${cfg.skin === 0 ? 'n/a' : cfg.frames} / ${scene.key} ===`);
      const row = runOne(scene, cfg.skin, cfg.skin === 0 ? 0 : cfg.frames);
      const entry = {
        skin: cfg.skin,
        frames: cfg.skin === 0 ? null : cfg.frames,
        scene: scene.key,
        ...row,
      };
      results.push(entry);
      console.log(
        `  STEP_max=${row.stepMax.toFixed(3)} NEIGH=${row.neighborSum.toFixed(3)} ` +
          `REUSED_sum=${row.reusedSum.toFixed(0)} BODY=${row.BODY_COUNT.toFixed(0)}`
      );
      // checkpoint
      fs.writeFileSync(
        summaryPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            warmupMs: WARMUP_MS,
            durationMs: DURATION_MS,
            skins: SKINS,
            frames: FRAMES,
            note: 'skin0 uses frames=null; maxFrames never patched as 0 (avoids worker fallback).',
            results,
          },
          null,
          2
        ) + '\n'
      );
    }
  }
} finally {
  restoreDefaults();
  console.log('\nRestored ConfigDefaults.js');
}

// Attach deltas vs skin0 baseline per scene
const baseline = {};
for (const scene of SCENES) {
  const b = results.find((r) => r.scene === scene.key && r.skin === 0);
  baseline[scene.key] = b;
}
for (const r of results) {
  const b = baseline[r.scene];
  if (!b || r.skin === 0) {
    r.stepDeltaPct = 0;
    continue;
  }
  r.stepDeltaPct = b.stepMax > 0 ? ((r.stepMax - b.stepMax) / b.stepMax) * 100 : 0;
}

const best = {};
for (const scene of SCENES) {
  const rows = results.filter((r) => r.scene === scene.key);
  const sorted = [...rows].sort((a, b) => a.stepMax - b.stepMax);
  best[scene.key] = sorted.slice(0, 5).map((r) => ({
    skin: r.skin,
    frames: r.frames,
    stepMax: r.stepMax,
    stepDeltaPct: r.stepDeltaPct,
    reusedSum: r.reusedSum,
  }));
}

const payload = {
  generatedAt: new Date().toISOString(),
  warmupMs: WARMUP_MS,
  durationMs: DURATION_MS,
  skins: SKINS,
  frames: FRAMES,
  baseline,
  best,
  results,
};
fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`\nWrote ${summaryPath}`);
console.log('\n=== BEST (lowest STEP_max) ===');
for (const scene of SCENES) {
  console.log(scene.key, JSON.stringify(best[scene.key], null, 2));
}
