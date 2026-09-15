#!/usr/bin/env node
/**
 * Wave C formal tournament — current Verlet + stagger only.
 * Does NOT apply H1–H15 / S2–S3 / scan-partition patches (closed).
 * L1 compares C16 cache layouts and C17 dead hash; L2 is production src.
 *
 *   node tests/bench/runSpatialHypTournament.mjs --skip-l3
 *   node tests/bench/runSpatialHypTournament.mjs --round 1 --runs 2
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTournamentArgs,
  measureEntrant,
  writeJson,
} from './featureTournamentLib.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
const microRunner = path.join(repoRoot, 'tests/bench/spatialMicrobench.mjs');
const outDir = path.join(repoRoot, 'tests/results/spatial-hyps/tournament');

const SCENES_ALL = [
  {
    key: 'stationary',
    scene: '/tests/bench/stressScenes/stationarySpatialScene.js',
    exportName: 'StationarySpatialScene',
  },
  {
    key: 'balls',
    scene: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
  },
];

function summarizeL1Run(micro) {
  const c = micro.cases || {};
  return {
    rebuildOps: c.rebuild?.opsPerSec ?? 0,
    neighborOps: c.neighbor?.opsPerSec ?? 0,
    c16MapOps: c.c16_map?.opsPerSec ?? 0,
    c16FlatOps: c.c16_flat?.opsPerSec ?? 0,
    c17HashOps: c.c17_hash?.opsPerSec ?? 0,
  };
}

const args = parseTournamentArgs(process.argv.slice(2), { skipL3: false });
const l1Only = process.argv.includes('--l1-only');
const scenes = l1Only
  ? []
  : args.skipL3
    ? SCENES_ALL.filter((s) => s.key !== 'balls')
    : SCENES_ALL;

fs.mkdirSync(outDir, { recursive: true });

const result = measureEntrant({
  repoRoot,
  integratedRunner,
  microRunner,
  outDir,
  tag: 'BASE',
  runs: args.runs,
  scenes,
  warmupMs: args.warmupMs,
  durationMs: args.durationMs,
  workerPreferIds: ['spatial0', 'spatial1'],
  applyEntrant: () => {},
  summarizeL1Run,
});

const l1 = result.l1 || {};
const mapOps = l1.c16MapOps?.median ?? l1.c16MapOps ?? 0;
const flatOps = l1.c16FlatOps?.median ?? l1.c16FlatOps ?? 0;
const c16Delta = mapOps > 0 ? ((flatOps - mapOps) / mapOps) * 100 : null;

const summary = {
  note: 'Production already has Verlet skin + stagger. H1–H15 / S2–S3 / scan partition stay closed. C16/C17 stay L1-only (flat table not merged; dep-hash removed from src as dead).',
  result,
  c16FlatVsMapPct: c16Delta,
};
writeJson(path.join(outDir, 'tournament-leaderboard.json'), summary);
console.log('Wave C BASE captured. C16 flat vs Map L1:', c16Delta == null ? 'n/a' : `${c16Delta.toFixed(1)}%`);
