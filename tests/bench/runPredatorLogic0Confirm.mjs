#!/usr/bin/env node
/**
 * PredatorScene logic0 confirm versus a git rev (default main).
 * Headless, 3 × 8 s / 10 s. Not a product-headed claim.
 *
 *   node tests/bench/runPredatorLogic0Confirm.mjs --vs main
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SPEED_PCT,
  applyBaselineRev,
  fmtDeltaPct,
  measureSceneSide,
  pctDelta,
  repoRoot,
  restoreSrcTree,
  snapshotSrcTree,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const outRoot = path.join(repoRoot, 'tests/results/new-hyps-vs-main/predator-logic0');

const SCENE = {
  key: 'predator',
  path: '/demos/predatorScene/predatorScene.js',
  exportName: 'PredatorScene',
  headed: false,
  kind: 'gameplay',
};

const LOAD = ['BODY_COUNT', 'ACTIVE_PARTICLES', 'AWAKE_COUNT', 'ENTITIES_PROCESSED', 'ACTIVE_BULLETS'];
const WATCH = [
  'logic0_STEP_MS',
  'AWAKE_COUNT',
  'ENTITIES_PROCESSED',
  'ACTIVE_BULLETS',
  'BODY_COUNT',
  'ACTIVE_PARTICLES',
  'physics_STEP_MS',
  'particle_STEP_MS',
  'spatialMax_STEP_MS',
  'pixi_STEP_MS',
];

function parseArgs(argv) {
  let vs = 'main';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vs' && argv[i + 1]) vs = String(argv[++i]);
  }
  return { vs };
}

function fmtStat(stat) {
  if (!stat) return 'n/a';
  const cv = stat.cv ? ` cv=${(stat.cv * 100).toFixed(1)}%` : '';
  const samples = Array.isArray(stat.samples) ? ` samples=[${stat.samples.map((n) => Number(n).toFixed(3)).join(', ')}]` : '';
  return `${Number(stat.median).toFixed(3)}${cv}${samples}`;
}

function main() {
  const { vs } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotSrcTree();
  const measureArgs = {
    runs: 3,
    stressRuns: 3,
    warmupMs: 8000,
    durationMs: 10000,
    stressWarmupMs: 8000,
    stressDurationMs: 10000,
    headlessAll: true,
    detailedStats: false,
  };

  try {
    console.log(`\n======== predator BASE ${vs} 3 × 8s/10s headless ========`);
    applyBaselineRev(vs);
    const base = measureSceneSide('predator-BASE', SCENE, measureArgs, outRoot);
    restoreSrcTree(snap);

    console.log(`\n======== predator KEEP 3 × 8s/10s headless ========`);
    const hyp = measureSceneSide('predator-KEEP', SCENE, measureArgs, outRoot);

    const pair = {
      vs,
      ok: Boolean(base.ok && hyp.ok),
      error: base.ok ? hyp.error : base.error,
      base: base.summary,
      hyp: hyp.summary,
      workload: base.ok && hyp.ok && base.summary && hyp.summary
        ? workloadOk(base.summary, hyp.summary, LOAD)
        : { ok: false, drifts: [] },
    };
    writeJson(path.join(outRoot, 'pair.json'), pair);

    if (!pair.ok) {
      console.error(`pair failed: ${pair.error || 'unknown'}`);
      process.exitCode = 1;
      return;
    }

    console.log('\n======== predator logic0 confirm ========');
    for (const key of WATCH) {
      const b = pair.base[key];
      const h = pair.hyp[key];
      const d = pctDelta(h?.median, b?.median);
      console.log(`${key}: ${fmtStat(b)} -> ${fmtStat(h)} (${fmtDeltaPct(d)})`);
    }
    console.log(`load: ${pair.workload.ok ? 'OK' : 'DRIFT'} ${JSON.stringify(pair.workload.drifts)}`);
    const logicD = pctDelta(pair.hyp.logic0_STEP_MS?.median, pair.base.logic0_STEP_MS?.median);
    const worse = logicD != null && logicD >= SPEED_PCT;
    console.log(`logic0 vs main: ${fmtDeltaPct(logicD)} ${worse ? 'WORSE (>=3%)' : 'not >=3% worse'}`);
  } finally {
    restoreSrcTree(snap);
  }
}

main();
