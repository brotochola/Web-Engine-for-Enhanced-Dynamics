#!/usr/bin/env node
/**
 * Headed Predator gpuShadowPath cribado. Keep the Chromium window visible.
 *   node tests/bench/runGpuShadowPathScreen.mjs
 *   node tests/bench/runGpuShadowPathScreen.mjs --confirm
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/render-hyps/shadow-path');

const confirm = process.argv.includes('--confirm');
const warmupMs = confirm ? '25000' : '3000';
const durationMs = confirm ? '18000' : '5000';
const runs = confirm ? 5 : 1;

const zooms = [
  ['z15', 'zoom=1.5'],
  ['z04', 'zoom=0.4'],
  ['z04l20', 'zoom=0.4&shadowLights=20'],
];
const paths = [
  ['copy', 'gpuShadowPath=copy'],
  ['reuse', 'gpuShadowPath=reuse'],
  ['queue', 'gpuShadowPath=queue'],
  ['resident', 'gpuShadowPath=resident'],
  ['night', 'gpuShadowPath=copy&gpuShadowCookies=night'],
];

const only = [];
const onlyZooms = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--only' && process.argv[i + 1]) only.push(...process.argv[++i].split(','));
  if (process.argv[i] === '--zooms' && process.argv[i + 1]) onlyZooms.push(...process.argv[++i].split(','));
}

fs.mkdirSync(outDir, { recursive: true });

function pickRenderer(j) {
  return (j.workers || []).find((w) => w.id === 'renderer' || w.type === 'renderer');
}

function pickPhysics(j) {
  return (j.workers || []).find((w) => w.id === 'physics' || w.type === 'physics');
}

function lineFromJson(name, j) {
  const r = pickRenderer(j);
  const p = pickPhysics(j);
  const a = (r && r.statsSamplesAverage) || {};
  const b = (p && p.statsSamplesAverage) || {};
  return {
    name,
    pixi: a.STEP_MS,
    shadowsJs: a.SHADOWS_MS,
    gpuStep: a.GPU_STEP_MS,
    gpuShadows: a.GPU_SHADOWS_MS,
    gpuPasses: a.GPU_PASSES,
    casters: a.GPU_CASTERS,
    shadowLights: a.GPU_SHADOW_LIGHTS,
    visible: a.VISIBLE_ENTITIES,
    bodies: b.BODY_COUNT,
  };
}

const rows = [];
for (const [pathName, pathQ] of paths) {
  if (only.length && !only.includes(pathName)) continue;
  for (const [zoomName, zoomQ] of zooms) {
    if (onlyZooms.length && !onlyZooms.includes(zoomName)) continue;
    const name = `${pathName}-${zoomName}`;
    const query = `${zoomQ}&${pathQ}`;
    const samples = [];
    for (let run = 0; run < runs; run++) {
      const out = path.join(outDir, `${name}${confirm ? `-r${run}` : ''}.json`);
      console.log(`\n======== ${name} run ${run + 1}/${runs} query=${query} ========`);
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
      if (r.status !== 0) process.exit(r.status || 1);
      const j = JSON.parse(fs.readFileSync(out, 'utf8'));
      samples.push(lineFromJson(name, j));
    }
    const med = (key) => {
      const s = samples.map((x) => Number(x[key]) || 0).sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    rows.push({
      name,
      pixi: med('pixi'),
      shadowsJs: med('shadowsJs'),
      gpuStep: med('gpuStep'),
      gpuShadows: med('gpuShadows'),
      gpuPasses: med('gpuPasses'),
      casters: med('casters'),
      shadowLights: med('shadowLights'),
      visible: med('visible'),
      bodies: med('bodies'),
    });
  }
}

console.log('\nname\tpixi\tSHADOWS_MS\tGPU_STEP\tGPU_SHADOWS\tpasses\tcasters\tlights\tbodies');
for (const r of rows) {
  console.log(
    [r.name, r.pixi, r.shadowsJs, r.gpuStep, r.gpuShadows, r.gpuPasses, r.casters, r.shadowLights, r.bodies]
      .map((v) => (typeof v === 'number' ? v.toFixed(3) : v))
      .join('\t')
  );
}

fs.writeFileSync(path.join(outDir, confirm ? 'confirm-summary.json' : 'screen-summary.json'), JSON.stringify(rows, null, 2) + '\n');
