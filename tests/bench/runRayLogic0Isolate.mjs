#!/usr/bin/env node
/**
 * Isolate ray-stress logic0 vs main: same scene/driver (branch tests/), swap src only.
 * Detailed stats ON (screened) to split RAYCAST_MS / COUNT vs STEP_MS and preRender load.
 *
 *   node tests/bench/runRayLogic0Isolate.mjs --vs main
 */
import fs from 'node:fs';
import path from 'node:path';

import { ENGINE_FEATURES } from './engineFeatureCatalog.mjs';
import { pctDelta, writeJson } from './featureTournamentLib.mjs';
import {
  applySrcRev,
  extractMetrics,
  measureSceneSide,
  parseMeasureArgs,
  repoRoot,
  restoreSrcTree,
  snapshotSrcTree,
  summarizeRuns,
} from './measureLib.mjs';

const outRoot = path.join(repoRoot, 'tests/results/ray-logic0-isolate');

function printSide(label, summary) {
  const keys = [
    'logic0_STEP_MS',
    'logic0_RAYCAST_MS',
    'logic0_RAYCAST_COUNT',
    'ENTITIES_PROCESSED',
    'BODY_COUNT',
    'preRender_STEP_MS',
    'pixi_STEP_MS',
    'physics_STEP_MS',
    'spatialMax_STEP_MS',
    'VISIBLE_ENTITIES',
  ];
  console.log(`\n=== ${label} ===`);
  for (const k of keys) {
    const s = summary[k];
    if (!s || !Number.isFinite(s.median)) continue;
    console.log(
      `  ${k}: ${s.median.toFixed(3)}  cv=${((s.cv || 0) * 100).toFixed(1)}%  n=${s.n ?? '?'}`
    );
  }
}

function main() {
  const args = parseMeasureArgs(process.argv.slice(2), {
    vs: 'main',
    stressRuns: 2,
    stressWarmupMs: 8000,
    stressDurationMs: 10000,
    detailedStats: true,
    headlessAll: true,
  });
  // Force detailed + headless for this isolation (screened, not product verdict).
  args.detailedStats = true;
  args.headlessAll = true;

  const feature = ENGINE_FEATURES.find((f) => f.id === 'ray');
  if (!feature?.scene) {
    console.error('ray feature missing from catalog');
    process.exit(1);
  }

  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotSrcTree();
  const payload = { vs: args.vs, args, sides: {} };

  try {
    console.log(`BASE src=${args.vs} (detailed stats ON, headless)`);
    applySrcRev(args.vs);
    const base = measureSceneSide('BASE', feature.scene, args, outRoot, feature.id);
    if (!base.ok) throw new Error(base.error || 'BASE failed');
    payload.sides.BASE = { summary: base.summary, rows: base.rows };
    printSide('BASE (main src)', base.summary);

    console.log('\nKEEP src=working-tree snapshot');
    restoreSrcTree(snap);
    const hyp = measureSceneSide('KEEP', feature.scene, args, outRoot, feature.id);
    if (!hyp.ok) throw new Error(hyp.error || 'KEEP failed');
    payload.sides.KEEP = { summary: hyp.summary, rows: hyp.rows };
    printSide('KEEP (branch src)', hyp.summary);

    const stepB = base.summary.logic0_STEP_MS?.median;
    const stepK = hyp.summary.logic0_STEP_MS?.median;
    const rayB = base.summary.logic0_RAYCAST_MS?.median;
    const rayK = hyp.summary.logic0_RAYCAST_MS?.median;
    const cntB = base.summary.logic0_RAYCAST_COUNT?.median;
    const cntK = hyp.summary.logic0_RAYCAST_COUNT?.median;
    const preB = base.summary.preRender_STEP_MS?.median;
    const preK = hyp.summary.preRender_STEP_MS?.median;

    const stepPct = pctDelta(stepK, stepB);
    const rayPct = pctDelta(rayK, rayB);
    const cntPct = pctDelta(cntK, cntB);
    const prePct = pctDelta(preK, preB);

    payload.compare = {
      logic0_STEP_MS: { base: stepB, keep: stepK, deltaPct: stepPct },
      logic0_RAYCAST_MS: { base: rayB, keep: rayK, deltaPct: rayPct },
      logic0_RAYCAST_COUNT: { base: cntB, keep: cntK, deltaPct: cntPct },
      preRender_STEP_MS: { base: preB, keep: preK, deltaPct: prePct },
    };

    console.log('\n=== COMPARE (KEEP vs BASE) ===');
    console.log(
      `logic0_STEP_MS:     ${stepB?.toFixed(3)} → ${stepK?.toFixed(3)} (${stepPct?.toFixed(1)}%)`
    );
    console.log(
      `logic0_RAYCAST_MS:  ${rayB?.toFixed(3)} → ${rayK?.toFixed(3)} (${rayPct?.toFixed(1)}%)`
    );
    console.log(
      `logic0_RAYCAST_COUNT: ${cntB?.toFixed(1)} → ${cntK?.toFixed(1)} (${cntPct?.toFixed(1)}%)`
    );
    console.log(
      `preRender_STEP_MS:  ${preB?.toFixed(3)} → ${preK?.toFixed(3)} (${prePct?.toFixed(1)}%)`
    );

    // Heuristic note (not a product verdict — detailed stats on).
    let note = 'inconclusive';
    if (Number.isFinite(cntPct) && Math.abs(cntPct) >= 5) {
      note = 'cast-count-drift (different work per frame — not algorithm)';
    } else if (Number.isFinite(rayPct) && rayPct >= 3 && Number.isFinite(stepPct) && stepPct >= 3) {
      note = 'ray-work-slower (RAYCAST_MS and STEP_MS both up — real cast path cost outside ray.js?)';
    } else if (
      Number.isFinite(stepPct) &&
      stepPct >= 3 &&
      Number.isFinite(rayPct) &&
      Math.abs(rayPct) < 3
    ) {
      note = 'non-ray-logic-overhead (STEP up, RAYCAST flat — worker/frame confound)';
    } else if (
      Number.isFinite(prePct) &&
      prePct >= 10 &&
      Number.isFinite(stepPct) &&
      stepPct >= 3 &&
      Number.isFinite(rayPct) &&
      rayPct < stepPct
    ) {
      note = 'possible-cpu-contention (preRender much heavier; logic step inflated)';
    } else if (Number.isFinite(stepPct) && Math.abs(stepPct) < 3) {
      note = 'tie-within-3pct (prior +28% may have been noisy/cold)';
    }
    payload.note = note;
    console.log(`\nnote: ${note}`);
  } finally {
    restoreSrcTree(snap);
  }

  writeJson(path.join(outRoot, 'isolate.json'), payload);
  console.log(`\nwrote ${path.join(outRoot, 'isolate.json')}`);
}

main();
