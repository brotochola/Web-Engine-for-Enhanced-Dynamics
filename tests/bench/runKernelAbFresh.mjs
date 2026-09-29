#!/usr/bin/env node
/**
 * Fair kernel A/B after src-tree swap: each side is a fresh Node process, then
 * one throwaway warmup process, then the timed process. Avoids the scoreboard
 * contamination where the first timed case after applySrcRev looks "slower"
 * while heavier cases (and solo KEEP repeats) match main.
 *
 *   node tests/bench/runKernelAbFresh.mjs --vs main --only compute,decorations,liquidfun,emit
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENGINE_FEATURES } from './engineFeatureCatalog.mjs';
import { pctDelta, writeJson } from './featureTournamentLib.mjs';
import {
  applySrcRev,
  parseMeasureArgs,
  pickOpsWithKey,
  repoRoot,
  restoreSrcTree,
  snapshotSrcTree,
} from './measureLib.mjs';

const outRoot = path.join(repoRoot, 'tests/results/scoreboard/_kernels-fresh');

function filterFeatures(only) {
  if (!only?.length) return ENGINE_FEATURES.filter((f) => f.kernel);
  const want = new Set(only);
  return ENGINE_FEATURES.filter((f) => f.kernel && want.has(f.id));
}

function runOnce(script, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(process.execPath, [path.join(repoRoot, script), '--output', outPath], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

function measureSide(label, feature, dir) {
  const warm = path.join(dir, `${label}-warm.json`);
  const timed = path.join(dir, `${label}.json`);
  console.log(`  ${label}: warmup process…`);
  runOnce(feature.kernel.script, warm);
  console.log(`  ${label}: timed process…`);
  return runOnce(feature.kernel.script, timed);
}

function main() {
  const args = parseMeasureArgs(process.argv.slice(2));
  const vs = args.vs || 'main';
  const features = filterFeatures(args.only);
  if (!features.length) {
    console.error('No kernel features matched --only');
    process.exit(1);
  }
  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotSrcTree();
  const rows = [];
  try {
    for (const feature of features) {
      console.log(`\n################ ${feature.id} ################`);
      const dir = path.join(outRoot, feature.id);
      fs.mkdirSync(dir, { recursive: true });

      console.log(`BASE src=${vs}`);
      applySrcRev(vs);
      const baseJson = measureSide('BASE', feature, dir);

      console.log('KEEP src=snapshot');
      restoreSrcTree(snap);
      const hypJson = measureSide('KEEP', feature, dir);

      const baseOps = pickOpsWithKey(baseJson, feature.kernel.opsKey);
      const hypOps = pickOpsWithKey(hypJson, feature.kernel.opsKey);
      const deltaPct = pctDelta(hypOps, baseOps);
      const higherBetter = feature.kernel.higherBetter !== false;
      const win = higherBetter ? deltaPct >= 3 : deltaPct <= -3;
      const lose = higherBetter ? deltaPct <= -3 : deltaPct >= 3;
      const verdict = lose ? 'WORSE' : win ? 'KEPT' : 'TIE';
      const row = {
        id: feature.id,
        opsKey: feature.kernel.opsKey,
        higherBetter,
        baseOps,
        hypOps,
        deltaPct,
        verdict,
      };
      // Extra compute cases for the report (opsKey may still be results.0).
      if (feature.id === 'compute' && baseJson.results && hypJson.results) {
        row.cases = baseJson.results.map((b, i) => {
          const h = hypJson.results[i];
          return {
            n: b.n,
            sweep: b.sweep,
            baseOps: b.opsPerSec,
            hypOps: h.opsPerSec,
            deltaPct: pctDelta(h.opsPerSec, b.opsPerSec),
          };
        });
      }
      rows.push(row);
      writeJson(path.join(dir, 'verdict.json'), row);
      console.log(
        `${feature.id} => ${verdict}  ${baseOps?.toFixed?.(higherBetter ? 0 : 3)} → ${hypOps?.toFixed?.(
          higherBetter ? 0 : 3
        )} (${deltaPct?.toFixed?.(2)}%)`
      );
      if (row.cases) {
        for (const c of row.cases) {
          console.log(
            `  case n=${c.n} sweep=${c.sweep}: ${c.baseOps.toFixed(1)} → ${c.hypOps.toFixed(1)} (${c.deltaPct.toFixed(2)}%)`
          );
        }
      }
    }
  } finally {
    restoreSrcTree(snap);
  }
  const summary = { vs, protocol: 'fresh-process-after-warmup', rows };
  writeJson(path.join(outRoot, 'summary.json'), summary);
  console.log(`\nWrote ${path.join(outRoot, 'summary.json')}`);
  const worse = rows.filter((r) => r.verdict === 'WORSE');
  process.exitCode = worse.length ? 1 : 0;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
