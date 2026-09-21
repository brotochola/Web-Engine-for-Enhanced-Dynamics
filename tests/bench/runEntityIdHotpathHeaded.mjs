#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { measureSceneSide, parseMeasureArgs, repoRoot } from './measureLib.mjs';

const side = process.argv[process.argv.indexOf('--side') + 1] || 'u16';
const which = process.argv[process.argv.indexOf('--scene') + 1] || 'bunny';
const scenes = {
  bunny: {
    path: '/demos/bunnyMarkScene/bunnyMarkScene.js',
    exportName: 'BunnyMarkScene',
    headed: true,
  },
  balls: {
    path: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
    headed: true,
  },
};
const args = parseMeasureArgs([]);
const outDir = path.join(repoRoot, 'tests/results/entity-id-hotpath', `${which}-${side}`);
fs.mkdirSync(outDir, { recursive: true });
const result = measureSceneSide(side, scenes[which], args, outDir);
const file = path.join(repoRoot, 'tests/results/entity-id-hotpath', `${which}-${side}-summary.json`);
fs.writeFileSync(file, JSON.stringify(result.ok ? result.summary : { error: result.error }, null, 2));
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
const s = result.summary;
const keys = which === 'balls'
  ? ['physics_STEP_MS', 'logic0_STEP_MS', 'BODY_COUNT']
  : ['preRender_STEP_MS', 'logic0_STEP_MS', 'MARK_ACTIVE'];
for (const k of keys) {
  const row = s[k];
  console.log(k, row ? `${row.median} cv ${row.cv} samples ${JSON.stringify(row.samples)}` : 'missing');
}
