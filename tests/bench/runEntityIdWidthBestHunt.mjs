#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outDir = 'tests/results/entity-id-width-best';
const warmup = String(process.argv.includes('--smoke') ? 4000 : 8000);
const duration = String(process.argv.includes('--smoke') ? 5000 : 10000);

const scenes = [
  {
    id: 'spawnStorm32',
    scene: '/tests/bench/stressScenes/spawnStorm32Scene.js',
    export: 'SpawnStorm32Scene',
    primary: 'logic0',
    load: 'ENTITIES_PROCESSED',
  },
  {
    id: 'spatialPlay32',
    scene: '/tests/bench/stressScenes/stationarySpatialPlay32Scene.js',
    export: 'StationarySpatialPlay32Scene',
    primary: 'spatialMax',
    load: 'NEIGHBORS_REUSED',
  },
  {
    id: 'contactDrain32',
    scene: '/tests/bench/stressScenes/contactDrainHuntScene.js',
    export: 'ContactDrainBest32Scene',
    primary: 'logic0',
    load: 'BODY_COUNT',
  },
  {
    id: 'leftoverConstraint32',
    scene: '/tests/bench/stressScenes/leftoverConstraint32Scene.js',
    export: 'LeftoverConstraint32Scene',
    primary: 'physics',
    load: 'BODY_COUNT',
  },
  {
    id: 'leftoverCompound32',
    scene: '/tests/bench/stressScenes/leftoverCompound32Scene.js',
    export: 'LeftoverCompound32Scene',
    primary: 'spatialMax',
    load: 'BODY_COUNT',
  },
];

function pickWorker(report, id) {
  const workers = report.workers || [];
  if (id === 'spatialMax') {
    const spatials = workers.filter((w) => w.id?.startsWith('spatial') || w.type === 'spatial');
    if (!spatials.length) return null;
    return spatials.reduce((best, w) => {
      const a = best.statsSamplesAverage?.STEP_MS ?? 0;
      const b = w.statsSamplesAverage?.STEP_MS ?? 0;
      return b > a ? w : best;
    });
  }
  return workers.find((w) => w.id === id || w.id === `${id}_worker` || w.type === id) || null;
}

function loadKey(worker, key) {
  const avg = worker?.statsSamplesAverage || {};
  return avg[key] ?? null;
}

const rows = [];
for (const s of scenes) {
  const output = path.join(outDir, `hunt-${s.id}.json`);
  console.log(`\n=== HUNT ${s.id} ===`);
  const r = spawnSync(
    process.execPath,
    [
      'tests/bench/runIntegratedWorkerBenchmark.mjs',
      '--src',
      '--no-collect-detailed-stats',
      '--warmup-ms',
      warmup,
      '--duration-ms',
      duration,
      '--scene',
      s.scene,
      '--scene-export',
      s.export,
      '--output',
      output,
    ],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  if (r.status !== 0) {
    rows.push({ id: s.id, error: `exit ${r.status}`, primaryMs: null, ok8: false });
    continue;
  }
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const worker = pickWorker(report, s.primary);
  const primaryMs = worker?.statsSamplesAverage?.STEP_MS ?? null;
  rows.push({
    id: s.id,
    primary: s.primary,
    primaryMs,
    load: s.load,
    loadValue: loadKey(worker, s.load),
    ok8: primaryMs != null && primaryMs >= 8,
  });
}

const summary = { warmupMs: Number(warmup), durationMs: Number(duration), rows };
fs.writeFileSync(path.join(outDir, 'hunt.json'), JSON.stringify(summary, null, 2) + '\n');
console.log('\nHUNT SUMMARY');
for (const row of rows) {
  console.log(
    `${row.id}: ${row.primary} ${row.primaryMs?.toFixed?.(3) ?? row.error} ${row.ok8 ? 'OK>=8' : 'NEED-RAISE'} load ${row.load}=${row.loadValue}`,
  );
}
