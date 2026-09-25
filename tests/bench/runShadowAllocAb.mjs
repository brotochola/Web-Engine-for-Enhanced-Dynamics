#!/usr/bin/env node
/**
 * Headed Predator A/B: current src vs a git rev (default HEAD~1).
 * Keep the Chromium window visible.
 *   node tests/bench/runShadowAllocAb.mjs
 *   node tests/bench/runShadowAllocAb.mjs --vs 7f04fe9
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySrcRev, repoRoot, restoreSrcTree, snapshotSrcTree } from './measureLib.mjs';

const runner = path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/render-hyps/shadow-alloc');

let vs = 'HEAD~1';
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--vs' && process.argv[i + 1]) vs = String(process.argv[++i]);
}

const warmupMs = '3000';
const durationMs = '5000';
const zooms = [
  ['z15', 'hour=0&zoom=1.5'],
  ['z04', 'hour=0&zoom=0.4'],
];

fs.mkdirSync(outDir, { recursive: true });

function pickRenderer(j) {
  return (j.workers || []).find((w) => w.id === 'renderer' || w.type === 'renderer');
}

function pickPhysics(j) {
  return (j.workers || []).find((w) => w.id === 'physics' || w.type === 'physics');
}

function pickPreRender(j) {
  const list = (j.workers || []).filter((w) => w.id === 'preRender' || w.type === 'preRender');
  let step = 0;
  for (const w of list) {
    const ms = Number((w.statsSamplesAverage || {}).STEP_MS) || 0;
    if (ms > step) step = ms;
  }
  return step;
}

function lineFromJson(name, j) {
  const r = pickRenderer(j);
  const p = pickPhysics(j);
  const a = (r && r.statsSamplesAverage) || {};
  const b = (p && p.statsSamplesAverage) || {};
  const particle = (j.workers || []).find((w) => w.id === 'particle' || w.type === 'particle');
  const pa = (particle && particle.statsSamplesAverage) || {};
  return {
    name,
    pixi: a.STEP_MS,
    shadowsJs: a.SHADOWS_MS,
    gpuStep: a.GPU_STEP_MS,
    gpuShadows: a.GPU_SHADOWS_MS,
    gpuLights: a.GPU_LIGHTS_MS,
    gpuPresent: a.GPU_PRESENT_MS,
    gpuPasses: a.GPU_PASSES,
    casters: a.GPU_CASTERS,
    shadowLights: a.GPU_SHADOW_LIGHTS,
    visible: a.VISIBLE_ENTITIES,
    bodies: b.BODY_COUNT,
    particles: pa.ACTIVE_PARTICLES,
    preRender: pickPreRender(j),
  };
}

function runCell(label, query) {
  const out = path.join(outDir, `${label}.json`);
  console.log(`\n======== ${label} query=${query} ========`);
  const r = spawnSync(
    process.execPath,
    [
      runner,
      '--headed',
      '--src',
      '--scene',
      '/demos/predatorScene/predatorScene.js',
      '--scene-export',
      'PredatorScene',
      '--warmup-ms',
      warmupMs,
      '--duration-ms',
      durationMs,
      '--query',
      query,
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error(`${label} exited ${r.status}`);
  return lineFromJson(label, JSON.parse(fs.readFileSync(out, 'utf8')));
}

const snap = snapshotSrcTree();
const rows = [];
try {
  console.log(`BASE src from ${vs}`);
  applySrcRev(vs);
  for (const [zoomName, query] of zooms) {
    rows.push(runCell(`base-${zoomName}`, query));
  }
} finally {
  restoreSrcTree(snap);
}

console.log('HYP current src tree');
for (const [zoomName, query] of zooms) {
  rows.push(runCell(`hyp-${zoomName}`, query));
}

const payload = { vs, warmupMs: Number(warmupMs), durationMs: Number(durationMs), rows };
fs.writeFileSync(path.join(outDir, 'rows.json'), `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload, null, 2));
