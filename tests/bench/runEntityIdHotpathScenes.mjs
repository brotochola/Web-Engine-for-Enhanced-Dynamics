#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { measureSceneSide, parseMeasureArgs, repoRoot } from './measureLib.mjs';

const args = parseMeasureArgs(process.argv.slice(2));
const side = process.argv.includes('--side')
  ? process.argv[process.argv.indexOf('--side') + 1]
  : 'base';
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',')
  : ['spatial', 'drain', 'cap'];

const scenes = {
  spatial: {
    path: '/tests/bench/stressScenes/stationarySpatialPlay32Scene.js',
    exportName: 'StationarySpatialPlay32Scene',
    headed: false,
  },
  drain: {
    path: '/tests/bench/stressScenes/contactDrainHuntScene.js',
    exportName: 'ContactDrainBest32Scene',
    headed: false,
  },
  cap: {
    path: '/tests/bench/stressScenes/entityIdSpatial300kScene.js',
    exportName: 'EntityIdSpatial300kScene',
    headed: false,
  },
};

const outRoot = path.join(repoRoot, 'tests/results/entity-id-hotpath');
fs.mkdirSync(outRoot, { recursive: true });
const summary = {};
for (const id of only) {
  const scene = scenes[id];
  if (!scene) throw new Error(`unknown scene ${id}`);
  const measureArgs = id === 'cap'
    ? { ...args, stressRuns: 1, stressWarmupMs: 4000, stressDurationMs: 4000 }
    : args;
  const result = measureSceneSide(side, scene, measureArgs, path.join(outRoot, `${id}-${side}`));
  summary[id] = result.ok
    ? { ok: true, summary: result.summary }
    : { ok: false, error: result.error };
  fs.writeFileSync(path.join(outRoot, `${id}-${side}-summary.json`), JSON.stringify(summary[id], null, 2));
  if (!result.ok) {
    console.error(id, result.error);
    process.exit(1);
  }
  console.log(id, JSON.stringify(result.summary));
}
