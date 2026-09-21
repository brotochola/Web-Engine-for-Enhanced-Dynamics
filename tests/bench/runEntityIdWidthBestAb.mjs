#!/usr/bin/env node
/**
 * Stress A/B for the only 32-vs-32 kernel winner: FL1 BigInt64 vs FL4 i32 19+13.
 * Also records play-scale spatial 30k width 32 (neighbor encoding did not win).
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SPEED_PCT,
  measureSceneSide,
  parseMeasureArgs,
  pctDelta,
  repoRoot,
  stepMsFloorOk,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const FL_FILE = path.join(repoRoot, 'src/util/atomicFreeList.js');
const TOGGLE_RE = /export const U32_FREE_LIST_HEAD = '[^']+'/;

const SPAWN = {
  path: '/tests/bench/stressScenes/spawnStorm32Scene.js',
  exportName: 'SpawnStorm32Scene',
  headed: false,
};
const SPATIAL = {
  path: '/tests/bench/stressScenes/stationarySpatialPlay32Scene.js',
  exportName: 'StationarySpatialPlay32Scene',
  headed: false,
};

function setHead(kind) {
  const src = fs.readFileSync(FL_FILE, 'utf8');
  if (!TOGGLE_RE.test(src)) throw new Error('U32_FREE_LIST_HEAD toggle missing');
  const next = src.replace(TOGGLE_RE, `export const U32_FREE_LIST_HEAD = '${kind}'`);
  if (next !== src) fs.writeFileSync(FL_FILE, next);
}

const args = parseMeasureArgs(process.argv.slice(2));
const outRoot = path.join(repoRoot, 'tests/results/entity-id-width-best');

setHead('bigint64');
const fl1Spawn = measureSceneSide('fl1-spawn', SPAWN, args, path.join(outRoot, 'ab-fl1-spawn'));
if (!fl1Spawn.ok) throw new Error(`FL1 spawn failed: ${fl1Spawn.error}`);
const fl1Spatial = measureSceneSide('fl1-spatial', SPATIAL, args, path.join(outRoot, 'ab-fl1-spatial'));
if (!fl1Spatial.ok) throw new Error(`FL1 spatial failed: ${fl1Spatial.error}`);

setHead('i32-19-13');
const fl4Spawn = measureSceneSide('fl4-spawn', SPAWN, args, path.join(outRoot, 'ab-fl4-spawn'));
if (!fl4Spawn.ok) {
  setHead('bigint64');
  throw new Error(`FL4 spawn failed: ${fl4Spawn.error}`);
}

const load = workloadOk(fl1Spawn.summary, fl4Spawn.summary, ['ENTITIES_PROCESSED']);
const floor = stepMsFloorOk(fl1Spawn.summary, fl4Spawn.summary, ['logic0_STEP_MS']);
const spawnBase = fl1Spawn.summary.logic0_STEP_MS.median;
const spawnHyp = fl4Spawn.summary.logic0_STEP_MS.median;
const spawnDelta = pctDelta(spawnHyp, spawnBase);
const spawnWin = load.ok && floor.ok && spawnDelta != null && spawnDelta <= -SPEED_PCT;

let fl4Spatial = null;
if (spawnWin) {
  fl4Spatial = measureSceneSide('fl4-spatial', SPATIAL, args, path.join(outRoot, 'ab-fl4-spatial'));
}

if (!spawnWin) setHead('bigint64');

const report = {
  feature: 'entity-id-width-best-fl4-ab',
  spawn: {
    fl1: fl1Spawn.summary,
    fl4: fl4Spawn.summary,
    load,
    floor,
    medianMs: { fl1: spawnBase, fl4: spawnHyp },
    deltaPct: spawnDelta,
    samples: {
      fl1: fl1Spawn.rows.map((r) => r.logic0_STEP_MS),
      fl4: fl4Spawn.rows.map((r) => r.logic0_STEP_MS),
    },
    verdict: !load.ok || !floor.ok
      ? 'FAIL'
      : spawnWin
        ? 'KEPT-FL4'
        : Math.abs(spawnDelta) < SPEED_PCT
          ? 'TIE'
          : 'WORSE-FL4',
  },
  spatialPlay32: {
    fl1: fl1Spatial.summary,
    fl4: fl4Spatial?.ok ? fl4Spatial.summary : null,
    samples: {
      fl1: fl1Spatial.rows.map((r) => r.spatialMax_STEP_MS),
      fl4: fl4Spatial?.ok ? fl4Spatial.rows.map((r) => r.spatialMax_STEP_MS) : null,
    },
  },
  headLeft: spawnWin ? 'i32-19-13' : 'bigint64',
};
writeJson(path.join(outRoot, 'stress-ab.json'), report);
console.log(JSON.stringify({
  verdict: report.spawn.verdict,
  fl1: spawnBase,
  fl4: spawnHyp,
  deltaPct: spawnDelta,
  loadOk: load.ok,
  floorOk: floor.ok,
  spatialFl1: report.spatialPlay32.samples.fl1,
}, null, 2));
if (!spawnWin) console.log('FL4 did not win spawn; toggle restored to bigint64');
