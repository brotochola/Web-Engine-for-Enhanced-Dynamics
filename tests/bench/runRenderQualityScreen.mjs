#!/usr/bin/env node
/**
 * Headed Predator quality knobs. Keep the Chromium window visible.
 * Night is pinned with hour=0 (day cycle off).
 *   node tests/bench/runRenderQualityScreen.mjs --phase lights
 *   node tests/bench/runRenderQualityScreen.mjs --phase res --base shadowLights=48
 *   node tests/bench/runRenderQualityScreen.mjs --phase interval --base shadowLights=48
 *   node tests/bench/runRenderQualityScreen.mjs --confirm --phase interval --base shadowLights=48 --cells i1-z15,i1-z04,i2-z15,i2-z04
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/render-hyps/quality-knobs');

const confirm = process.argv.includes('--confirm');
const warmupMs = confirm ? '25000' : '3000';
const durationMs = confirm ? '18000' : '5000';
const runs = confirm ? 5 : 1;

let phase = 'lights';
let baseQ = '';
const onlyCells = [];
const onlyZooms = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--phase' && process.argv[i + 1]) phase = process.argv[++i];
  if (process.argv[i] === '--base' && process.argv[i + 1]) baseQ = process.argv[++i];
  if (process.argv[i] === '--cells' && process.argv[i + 1]) onlyCells.push(...process.argv[++i].split(','));
  if (process.argv[i] === '--zooms' && process.argv[i + 1]) onlyZooms.push(...process.argv[++i].split(','));
}

const night = 'hour=0';
const zooms = [
  ['z15', 'zoom=1.5'],
  ['z04', 'zoom=0.4'],
];

function cellsForPhase() {
  const z = zooms.filter(([name]) => !onlyZooms.length || onlyZooms.includes(name));
  const extra = baseQ ? `&${baseQ}` : '';
  const out = [];
  if (phase === 'lights') {
    for (const [capName, capQ] of [
      ['l1000', 'shadowLights=1000'],
      ['l48', 'shadowLights=48'],
      ['l20', 'shadowLights=20'],
    ]) {
      for (const [zoomName, zoomQ] of z) {
        out.push([`${capName}-${zoomName}`, `${night}&${zoomQ}&${capQ}`]);
      }
    }
  } else if (phase === 'res') {
    for (const [resName, resQ] of [
      ['lres025', 'lightingRes=0.25'],
      ['lres0125', 'lightingRes=0.125'],
      ['lres05', 'lightingRes=0.5'],
      ['sres025', 'shadowRes=0.25'],
    ]) {
      for (const [zoomName, zoomQ] of z) {
        out.push([`${resName}-${zoomName}`, `${night}&${zoomQ}${extra}&${resQ}`]);
      }
    }
  } else if (phase === 'interval') {
    for (const [intName, intQ] of [
      ['i1', 'shadowInterval=1'],
      ['i2', 'shadowInterval=2'],
      ['i3', 'shadowInterval=3'],
    ]) {
      for (const [zoomName, zoomQ] of z) {
        out.push([`${intName}-${zoomName}`, `${night}&${zoomQ}${extra}&${intQ}`]);
      }
    }
  } else if (phase === 'cookie') {
    for (const [name, q] of [
      ['mix-i1', 'lightingRes=0.5&shadowRes=0.25&shadowInterval=1'],
      ['mix-i2', 'lightingRes=0.5&shadowRes=0.25&shadowInterval=2'],
      ['same-i1', 'lightingRes=0.25&shadowRes=0.25&shadowInterval=1'],
    ]) {
      for (const [zoomName, zoomQ] of z) {
        out.push([`${name}-${zoomName}`, `${night}&${zoomQ}&${q}`]);
      }
    }
  } else if (phase === 'perlight') {
    for (const [plName, plQ] of [
      ['pl512', 'shadowsPerLight=512'],
      ['pl64', 'shadowsPerLight=64'],
      ['pl15', 'shadowsPerLight=15'],
    ]) {
      for (const [zoomName, zoomQ] of z) {
        out.push([`${plName}-${zoomName}`, `${night}&${zoomQ}${extra}&${plQ}`]);
      }
    }
  } else {
    console.error(`unknown --phase ${phase} (lights|res|interval|perlight|cookie)`);
    process.exit(2);
  }
  return onlyCells.length ? out.filter(([name]) => onlyCells.includes(name)) : out;
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
    gpuLights: a.GPU_LIGHTS_MS,
    gpuPresent: a.GPU_PRESENT_MS,
    gpuPasses: a.GPU_PASSES,
    casters: a.GPU_CASTERS,
    shadowLights: a.GPU_SHADOW_LIGHTS,
    visible: a.VISIBLE_ENTITIES,
    bodies: b.BODY_COUNT,
  };
}

const cells = cellsForPhase();
const rows = [];
for (const [name, query] of cells) {
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
    gpuLights: med('gpuLights'),
    gpuPresent: med('gpuPresent'),
    gpuPasses: med('gpuPasses'),
    casters: med('casters'),
    shadowLights: med('shadowLights'),
    visible: med('visible'),
    bodies: med('bodies'),
  });
}

console.log(
  '\nname\tpixi\tSHADOWS_MS\tGPU_STEP\tGPU_SHADOWS\tGPU_LIGHTS\tGPU_PRESENT\tpasses\tcasters\tlights\tbodies'
);
for (const r of rows) {
  console.log(
    [
      r.name,
      r.pixi,
      r.shadowsJs,
      r.gpuStep,
      r.gpuShadows,
      r.gpuLights,
      r.gpuPresent,
      r.gpuPasses,
      r.casters,
      r.shadowLights,
      r.bodies,
    ]
      .map((v) => (typeof v === 'number' ? v.toFixed(3) : v))
      .join('\t')
  );
}

const summaryName = confirm ? `${phase}-confirm-summary.json` : `${phase}-summary.json`;
fs.writeFileSync(path.join(outDir, summaryName), JSON.stringify(rows, null, 2) + '\n');
