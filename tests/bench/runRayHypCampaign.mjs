#!/usr/bin/env node
/**
 * Ray hypothesis campaign — headless L1 micro + L2 RayStress + L3 Predator.
 *
 *   node tests/bench/run-ray-hyp-campaign.mjs
 *   node tests/bench/run-ray-hyp-campaign.mjs --only BASE,H1 --runs 1
 *   node tests/bench/run-ray-hyp-campaign.mjs --warmup-ms 5000 --duration-ms 6000
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { HYPS, applyHyp, restoreAll, PATHS } from './ray-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const microRunner = path.join(repoRoot, 'tests/bench/ray-microbench.mjs');
const outDir = path.join(repoRoot, 'tests/results/ray-hyps');
const summaryPath = path.join(outDir, 'campaign-summary.json');

const SCENES = [
  {
    key: 'rayStress',
    scene: '/tests/bench/stressScenes/RayStressScene.js',
    exportName: 'RayStressScene',
  },
  {
    key: 'predator',
    scene: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
  },
];

function parseArgs(argv) {
  const out = {
    runs: 2,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    only: null,
    skipL3: false,
    dryApply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || DEFAULT_WARMUP_MS;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || DEFAULT_DURATION_MS;
    else if (a === '--only' && argv[i + 1]) {
      out.only = String(argv[++i])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--skip-l3') out.skipL3 = true;
    else if (a === '--dry-apply') out.dryApply = true;
  }
  return out;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function seriesStats(values) {
  return {
    median: median(values),
    mean: mean(values),
    samples: values,
  };
}

function logicFromReport(j) {
  const logic = (j.workers || []).find((w) => w.id === 'logic0' || w.type === 'logic');
  const avg = logic?.statsSamplesAverage || {};
  return {
    STEP_MS: avg.STEP_MS ?? 0,
    RAYCAST_MS: avg.RAYCAST_MS ?? 0,
    RAYCAST_COUNT: avg.RAYCAST_COUNT ?? 0,
    ENTITY_MS: avg.ENTITY_MS ?? 0,
    TICK_MS: avg.TICK_MS ?? 0,
    ENTITIES_PROCESSED: avg.ENTITIES_PROCESSED ?? 0,
    averageFPS: logic?.averageFPS ?? 0,
    loadPct: workerLoadPct(avg.STEP_MS ?? 0),
  };
}

function runMicro(hypId, runIndex) {
  const out = path.join(outDir, `${hypId}-l1-r${runIndex}.json`);
  execFileSync(process.execPath, [microRunner, '--output', out], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function runIntegrated(scene, hypId, runIndex, warmupMs, durationMs) {
  const out = path.join(outDir, `${hypId}-${scene.key}-r${runIndex}.json`);
  execFileSync(
    process.execPath,
    [
      integratedRunner,
      '--scene',
      scene.scene,
      '--scene-export',
      scene.exportName,
      '--warmup-ms',
      String(warmupMs),
      '--duration-ms',
      String(durationMs),
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function dryApplyAll() {
  for (const h of HYPS) {
    restoreAll();
    h.apply();
    try {
      execFileSync(process.execPath, ['--check', PATHS.ray], { stdio: 'pipe' });
    } catch (e) {
      restoreAll();
      throw new Error(`Syntax fail on ${h.id}: ${e.stderr?.toString?.() || e.message}`);
    }
  }
  restoreAll();
  console.log('Dry-apply: all ray hyps syntax OK');
}

function verdictVsBase(base, hyp, keyPath) {
  const b = keyPath(base);
  const h = keyPath(hyp);
  if (b == null || h == null || !(b > 0)) return 'n/a';
  const pct = ((h - b) / b) * 100;
  // For ops/s higher is better; for ms lower is better — caller passes signed sense
  return { base: b, hyp: h, pctChange: pct };
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

if (args.dryApply) {
  dryApplyAll();
  process.exit(0);
}

const hypList = args.only
  ? args.only.map((id) => {
      const h = HYPS.find((x) => x.id === id);
      if (!h) throw new Error(`Unknown hyp id: ${id}`);
      return h;
    })
  : HYPS;

const scenes = args.skipL3 ? SCENES.filter((s) => s.key !== 'predator') : SCENES;

const campaign = {
  meta: {
    generatedAt: new Date().toISOString(),
    runs: args.runs,
    warmupMs: args.warmupMs,
    durationMs: args.durationMs,
    headless: true,
    hyps: hypList.map((h) => h.id),
    scenes: scenes.map((s) => s.key),
  },
  results: {},
};

try {
  dryApplyAll();

  for (const hyp of hypList) {
    console.log(`\n======== ${hyp.id} ========`);
    restoreAll();
    hyp.apply();

    const entry = { l1: [], l2: [], l3: [] };

    for (let r = 0; r < args.runs; r++) {
      console.log(`\n--- ${hyp.id} L1 run ${r + 1}/${args.runs} ---`);
      const micro = runMicro(hyp.id, r);
      entry.l1.push({
        castOps: micro.cases?.cast?.opsPerSec ?? 0,
        castAllOps: micro.cases?.castAll?.opsPerSec ?? 0,
        losOps: micro.cases?.hasLineOfSight?.opsPerSec ?? 0,
        linecastOps: micro.cases?.linecastBetweenEntities?.opsPerSec ?? 0,
        castMaskedOps: micro.cases?.castMasked?.opsPerSec ?? 0,
      });

      for (const scene of scenes) {
        console.log(`\n--- ${hyp.id} ${scene.key} run ${r + 1}/${args.runs} ---`);
        const report = runIntegrated(scene, hyp.id, r, args.warmupMs, args.durationMs);
        const logic = logicFromReport(report);
        if (scene.key === 'rayStress') entry.l2.push(logic);
        else entry.l3.push(logic);
      }
    }

    const summarizeLogic = (rows) => {
      if (!rows.length) return null;
      return {
        RAYCAST_MS: seriesStats(rows.map((x) => x.RAYCAST_MS)),
        STEP_MS: seriesStats(rows.map((x) => x.STEP_MS)),
        RAYCAST_COUNT: seriesStats(rows.map((x) => x.RAYCAST_COUNT)),
        ENTITIES_PROCESSED: seriesStats(rows.map((x) => x.ENTITIES_PROCESSED)),
      };
    };

    campaign.results[hyp.id] = {
      l1: {
        castOps: seriesStats(entry.l1.map((x) => x.castOps)),
        castAllOps: seriesStats(entry.l1.map((x) => x.castAllOps)),
        losOps: seriesStats(entry.l1.map((x) => x.losOps)),
        linecastOps: seriesStats(entry.l1.map((x) => x.linecastOps)),
      },
      l2: summarizeLogic(entry.l2),
      l3: summarizeLogic(entry.l3),
      runs: entry,
    };
  }

  // Verdicts vs BASE (ops/s up = good; ms down = good)
  const base = campaign.results.BASE;
  const verdicts = {};
  for (const hyp of hypList) {
    if (hyp.id === 'BASE' || !base) continue;
    const r = campaign.results[hyp.id];
    verdicts[hyp.id] = {
      l1_castAll_opsPct:
        base.l1 && r.l1
          ? ((r.l1.castAllOps.median - base.l1.castAllOps.median) / base.l1.castAllOps.median) * 100
          : null,
      l1_cast_opsPct:
        base.l1 && r.l1
          ? ((r.l1.castOps.median - base.l1.castOps.median) / base.l1.castOps.median) * 100
          : null,
      l1_los_opsPct:
        base.l1 && r.l1
          ? ((r.l1.losOps.median - base.l1.losOps.median) / base.l1.losOps.median) * 100
          : null,
      l2_RAYCAST_MS_pct:
        base.l2 && r.l2
          ? ((r.l2.RAYCAST_MS.median - base.l2.RAYCAST_MS.median) / base.l2.RAYCAST_MS.median) * 100
          : null,
      l3_RAYCAST_MS_pct:
        base.l3 && r.l3
          ? ((r.l3.RAYCAST_MS.median - base.l3.RAYCAST_MS.median) / base.l3.RAYCAST_MS.median) * 100
          : null,
    };
  }
  campaign.verdictsVsBase = verdicts;

  if (verdicts.H1 && base) {
    const v = verdicts.H1;
    const castAllUp = v.l1_castAll_opsPct != null && v.l1_castAll_opsPct > 2;
    const l2Down = v.l2_RAYCAST_MS_pct != null && v.l2_RAYCAST_MS_pct < -2;
    const castOk = v.l1_cast_opsPct == null || v.l1_cast_opsPct > -5;
    // H1 does not touch LOS; large single-run LOS swings are noise, not a reject signal.
    let decision = 'reject_or_noise';
    if (castAllUp && castOk && l2Down) decision = 'accept';
    else if (castAllUp && castOk) decision = 'accept_partial_l1';
    campaign.verdictsVsBase.H1_decision = decision;
    campaign.verdictsVsBase.H1_notes =
      'H1 targets castAll early-out only. Judge castAll + L2 RAYCAST_MS; ignore LOS/cast jitter on n=1.';
  }

  fs.writeFileSync(summaryPath, JSON.stringify(campaign, null, 2) + '\n');
  console.log(`\nWrote ${summaryPath}`);
  if (campaign.verdictsVsBase) {
    console.log('Verdicts vs BASE:', JSON.stringify(campaign.verdictsVsBase, null, 2));
  }
} finally {
  restoreAll();
  console.log('Restored Ray.js / utils.js baselines');
}
