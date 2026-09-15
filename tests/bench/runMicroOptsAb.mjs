#!/usr/bin/env node
/**
 * A/B each more_micro_opts runtime change against main (0695a8d).
 *
 *   node tests/bench/runMicroOptsAb.mjs --dry-apply
 *   node tests/bench/runMicroOptsAb.mjs
 *   node tests/bench/runMicroOptsAb.mjs --only HYGIENE,TICK --runs 1
 *
 * L3 is headed Chromium + live /src. Keep the window visible; do not minimize.
 * FPS@60 is not a keep/drop metric.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/util/workersUtils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { median, pctDelta, writeJson } from './featureTournamentLib.mjs';
import {
  CANONICAL_ORDER,
  HYP_CATALOG,
  STACK_META,
  applyHyp,
  applyKeepIds,
  dryApplyAll,
  restoreHead,
} from './micro-opts-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
const outRoot = path.join(repoRoot, 'tests/results/micro-opts-ab');

const SCENES = {
  balls: {
    key: 'balls',
    scene: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
    layer: 'l3',
    headed: true,
    workload: ['BODY_COUNT'],
  },
  predator: {
    key: 'predator',
    scene: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    layer: 'l3',
    headed: true,
    workload: ['BODY_COUNT', 'ACTIVE_PARTICLES'],
  },
  queryAabb: {
    key: 'queryAabb',
    scene: '/tests/bench/stressScenes/queryAabbStressScene.js',
    exportName: 'QueryAabbStressScene',
    layer: 'l2',
    headed: false,
    workload: ['BODY_COUNT'],
  },
  zenithal: {
    key: 'zenithal',
    scene: '/demos/zenithalParticleTestScene/zenithalParticleTestScene.js',
    exportName: 'ZenithalParticleTestScene',
    layer: 'l2',
    headed: false,
    workload: ['BODY_COUNT'],
  },
  spawnStorm: {
    key: 'spawnStorm',
    scene: '/tests/bench/stressScenes/spawnStormScene.js',
    exportName: 'SpawnStormScene',
    layer: 'l2',
    headed: false,
    workload: ['BODY_COUNT'],
  },
  queryChurn: {
    key: 'queryChurn',
    scene: '/tests/bench/stressScenes/queryChurnScene.js',
    exportName: 'QueryChurnScene',
    layer: 'l2',
    headed: false,
    workload: ['BODY_COUNT'],
  },
};

function parseArgs(argv) {
  const out = {
    runs: 5,
    l2Runs: 2,
    confirmRuns: 2,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    l2WarmupMs: 8000,
    l2DurationMs: 10000,
    only: null,
    skipL3: false,
    skipL2: false,
    skipL1: false,
    dryApply: false,
    skipConfirm: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === '--l2-runs' && argv[i + 1]) out.l2Runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || DEFAULT_WARMUP_MS;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || DEFAULT_DURATION_MS;
    else if (a === '--only' && argv[i + 1]) {
      out.only = String(argv[++i])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--skip-l3') out.skipL3 = true;
    else if (a === '--skip-l2') out.skipL2 = true;
    else if (a === '--skip-l1') out.skipL1 = true;
    else if (a === '--dry-apply') out.dryApply = true;
    else if (a === '--skip-confirm') out.skipConfirm = true;
  }
  return out;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdevSample(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function cv(arr) {
  const m = mean(arr);
  return m > 0 ? stdevSample(arr) / m : 0;
}

function seriesStats(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return {
    median: median(nums),
    mean: mean(nums),
    cv: cv(nums),
    samples: nums,
  };
}

function avgOf(worker) {
  return worker?.statsSamplesAverage || {};
}

export function extractMetrics(report) {
  const workers = report.workers || [];
  const pick = (pred) => workers.find(pred);
  const physics = avgOf(pick((w) => w.id === 'physics' || w.type === 'physics'));
  const logic0 = avgOf(pick((w) => w.id === 'logic0'));
  const particle = avgOf(pick((w) => w.id === 'particle' || w.type === 'particle'));
  const preRender = avgOf(pick((w) => w.id === 'preRender' || w.type === 'preRender'));
  const pixi = avgOf(
    pick((w) => w.id === 'renderer' || w.type === 'pixi' || w.id === 'pixi' || w.type === 'renderer')
  );
  let spatialMax = null;
  for (const w of workers) {
    if (!String(w.id || '').startsWith('spatial')) continue;
    const step = avgOf(w).STEP_MS ?? 0;
    if (!spatialMax || step > spatialMax.STEP_MS) {
      spatialMax = { id: w.id, STEP_MS: step, NEIGHBOR_MS: avgOf(w).NEIGHBOR_MS ?? 0 };
    }
  }
  return {
    BODY_COUNT: physics.BODY_COUNT ?? 0,
    ACTIVE_PARTICLES: particle.ACTIVE_PARTICLES ?? 0,
    physics_STEP_MS: physics.STEP_MS ?? 0,
    logic0_STEP_MS: logic0.STEP_MS ?? 0,
    particle_STEP_MS: particle.STEP_MS ?? 0,
    PARTICLE_PHYSICS_MS: particle.PARTICLE_PHYSICS_MS ?? 0,
    BUILD_ACTIVE_VISIBLE_MS: particle.BUILD_ACTIVE_VISIBLE_MS ?? 0,
    preRender_STEP_MS: preRender.STEP_MS ?? 0,
    VISIBILITY_MS: preRender.VISIBILITY_MS ?? 0,
    pixi_STEP_MS: pixi.STEP_MS ?? 0,
    LIGHTS_MS: pixi.LIGHTS_MS ?? 0,
    spatialMax_STEP_MS: spatialMax?.STEP_MS ?? 0,
    spatialMax_NEIGHBOR_MS: spatialMax?.NEIGHBOR_MS ?? 0,
    spatialMax_id: spatialMax?.id ?? null,
    physics_loadPct: workerLoadPct(physics.STEP_MS ?? 0),
  };
}

function runIntegratedOnce(scene, outPath, opts) {
  const args = [
    integratedRunner,
    '--src',
    '--scene',
    scene.scene,
    '--scene-export',
    scene.exportName,
    '--warmup-ms',
    String(opts.warmupMs),
    '--duration-ms',
    String(opts.durationMs),
    '--output',
    outPath,
  ];
  if (opts.headed) args.push('--headed');
  if (!opts.detailedStats) args.push('--no-collect-detailed-stats');
  execFileSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

function runIntegratedWithRetry(scene, outPath, opts) {
  try {
    return { ok: true, report: runIntegratedOnce(scene, outPath, opts) };
  } catch (e) {
    console.warn(`Playwright fail; retry 1x (${e.message || e})`);
    try {
      return { ok: true, report: runIntegratedOnce(scene, outPath, opts), retried: true };
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2), retried: true };
    }
  }
}

function summarizeRuns(rows) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'number');
  return Object.fromEntries(keys.map((k) => [k, seriesStats(rows.map((r) => r[k]))]));
}

function workloadOk(baseSum, hypSum, keys) {
  const drifts = [];
  for (const key of keys) {
    const b = baseSum[key]?.median;
    const h = hypSum[key]?.median;
    const d = pctDelta(h, b);
    if (d == null) continue;
    if (Math.abs(d) > 5) drifts.push({ key, pct: d });
  }
  return { ok: drifts.length === 0, drifts };
}

function measurePairWithApplies(tag, scene, args, detailedStats, applyA, applyB) {
  const dir = path.join(outRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  const runs = scene.layer === 'l3' ? args.runs : args.l2Runs;
  const warmupMs = scene.layer === 'l3' ? args.warmupMs : args.l2WarmupMs;
  const durationMs = scene.layer === 'l3' ? args.durationMs : args.l2DurationMs;
  const benchOpts = { warmupMs, durationMs, headed: scene.headed, detailedStats };

  console.log(`\n======== ${tag} ${scene.key} BASE (${runs} × ${warmupMs}/${durationMs}ms) ========`);
  applyA();
  const baseRows = [];
  for (let r = 0; r < runs; r++) {
    const out = path.join(dir, `${tag}-${scene.key}-BASE-r${r}.json`);
    const res = runIntegratedWithRetry(scene, out, benchOpts);
    if (!res.ok) return { ok: false, error: res.error, scene: scene.key };
    baseRows.push(extractMetrics(res.report));
  }

  console.log(`\n======== ${tag} ${scene.key} HYP (${runs} × ${warmupMs}/${durationMs}ms) ========`);
  applyB();
  const hypRows = [];
  for (let r = 0; r < runs; r++) {
    const out = path.join(dir, `${tag}-${scene.key}-HYP-r${r}.json`);
    const res = runIntegratedWithRetry(scene, out, benchOpts);
    if (!res.ok) return { ok: false, error: res.error, scene: scene.key };
    hypRows.push(extractMetrics(res.report));
  }

  const base = summarizeRuns(baseRows);
  const hyp = summarizeRuns(hypRows);
  const work = workloadOk(base, hyp, scene.workload);
  return { ok: true, scene: scene.key, layer: scene.layer, base, hyp, workload: work, baseRows, hypRows };
}

function measureScenePair(hypId, scene, args, detailedStats) {
  return measurePairWithApplies(
    hypId,
    scene,
    args,
    detailedStats,
    () => applyHyp('BASE'),
    () => applyHyp(hypId)
  );
}

function runL1(hypId, kind) {
  const dir = path.join(outRoot, hypId);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${hypId}-l1-${kind}.json`);
  const runners = {
    emit: path.join(repoRoot, 'tests/bench/particleEmitMicrobench.mjs'),
    integrate: path.join(repoRoot, 'tests/bench/particleIntegrateMicrobench.mjs'),
    treiber: path.join(repoRoot, 'tests/bench/treiberMicrobench.mjs'),
    spatial: path.join(repoRoot, 'tests/bench/spatialMicrobench.mjs'),
  };
  const runner = runners[kind];
  if (!runner) throw new Error(`unknown L1 ${kind}`);
  try {
    execFileSync(process.execPath, [runner, '--output', out], { cwd: repoRoot, stdio: 'inherit' });
    return { ok: true, json: JSON.parse(fs.readFileSync(out, 'utf8')) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function l1Ops(json, kind) {
  if (!json) return null;
  if (kind === 'emit') return json.cases?.emitFlat_burst?.opsPerSec ?? null;
  if (kind === 'treiber') return json.cases?.batchPop?.opsPerSec ?? json.cases?.popFreeIndices_32?.opsPerSec ?? null;
  if (kind === 'spatial') return json.cases?.c17_hash?.opsPerSec ?? null;
  if (kind === 'integrate') {
    const c = json.cases || {};
    return c.buildActiveAndVisible?.opsPerSec ?? c.buildActiveListBuffers?.opsPerSec ?? null;
  }
  return null;
}

function decideHyp(meta, sceneResults, l1) {
  const reasons = [];
  const primaryHits = [];
  let anyValidScene = false;

  for (const row of sceneResults) {
    if (!row.ok) {
      reasons.push(`${row.scene} failed: ${row.error || 'unknown'}`);
      continue;
    }
    if (!row.workload.ok) {
      reasons.push(
        `${row.scene} workload drift ${row.workload.drifts.map((d) => `${d.key} ${d.pct.toFixed(1)}%`).join(', ')}`
      );
      continue;
    }
    anyValidScene = true;
    const metric = meta.primary?.[row.scene];
    if (!metric) continue;
    const b = row.base[metric]?.median;
    const h = row.hyp[metric]?.median;
    const d = pctDelta(h, b);
    const cvB = row.base[metric]?.cv ?? 0;
    const cvH = row.hyp[metric]?.cv ?? 0;
    primaryHits.push({ scene: row.scene, metric, base: b, hyp: h, deltaPct: d, cvBase: cvB, cvHyp: cvH });
  }

  for (const [kind, pair] of Object.entries(l1 || {})) {
    if (!pair?.baseOk && !pair?.hypOk) continue;
    if (kind === 'spatial' || kind === 'integrate') continue;
    const b = pair.baseOps;
    const h = pair.hypOps;
    const d = pctDelta(h, b);
    if (b && h) primaryHits.push({ scene: `l1-${kind}`, metric: 'opsPerSec', base: b, hyp: h, deltaPct: d, higherBetter: true });
  }

  if (!anyValidScene && !(l1 && Object.values(l1).some((x) => x.hypOk && x.baseOk && x.kind !== 'spatial' && x.kind !== 'integrate'))) {
    return { verdict: 'NA', reasons: reasons.length ? reasons : ['no valid scene'], primaryHits };
  }

  const msWins = primaryHits.filter((p) => !p.higherBetter && p.deltaPct != null && p.deltaPct <= -3);
  const opsWins = primaryHits.filter((p) => p.higherBetter && p.deltaPct != null && p.deltaPct >= 3);
  const msRegress = primaryHits.filter((p) => !p.higherBetter && p.deltaPct != null && p.deltaPct >= 3);

  if (meta.kind === 'hygiene' || meta.kind === 'bugfix') {
    if (msRegress.length) {
      return { verdict: 'DROP', reasons: [`regression ≥3% on ${msRegress.map((p) => p.scene).join(',')}`, ...reasons], primaryHits };
    }
    return { verdict: 'KEEP', reasons: ['bugfix/hygiene: keep unless ≥3% regression', ...reasons], primaryHits };
  }

  if (meta.kind === 'stack') {
    if (msRegress.length) {
      return { verdict: 'DROP', reasons: [`product regression ≥3% on ${msRegress.map((p) => p.scene).join(',')}`, ...reasons], primaryHits };
    }
    return { verdict: 'KEEP', reasons: ['product: no ≥3% STEP regression vs main', ...reasons], primaryHits };
  }

  if (msWins.length || opsWins.length) {
    return { verdict: 'KEEP', reasons: [`primary improved ≥3% (${[...msWins, ...opsWins].map((p) => p.scene).join(',')})`, ...reasons], primaryHits };
  }
  return { verdict: 'DROP', reasons: ['primary did not improve ≥3% (or L3/L2 blind + L1 noise)', ...reasons], primaryHits };
}

function printTable(results) {
  console.log('\n======== KEEP / DROP / NA ========');
  for (const row of results) {
    const bits = (row.decision.primaryHits || [])
      .map((p) => {
        const d = p.deltaPct == null ? 'n/a' : `${p.deltaPct >= 0 ? '+' : ''}${p.deltaPct.toFixed(1)}%`;
        return `${p.scene} ${p.metric} ${p.base?.toFixed?.(3) ?? p.base}→${p.hyp?.toFixed?.(3) ?? p.hyp} (${d})`;
      })
      .join('; ');
    console.log(`${row.id.padEnd(8)} ${row.decision.verdict.padEnd(4)}  ${row.decision.reasons[0] || ''}  ${bits}`);
  }
}

function catalogPlusStack(only) {
  const list = [...HYP_CATALOG, STACK_META];
  if (!only) return list;
  return list.filter((h) => only.includes(h.id));
}

function measureL1Pair(hypId, kinds) {
  const out = {};
  for (const kind of kinds) {
    console.log(`\n======== ${hypId} L1 ${kind} BASE ========`);
    applyHyp('BASE');
    const base = runL1(hypId, kind);
    console.log(`\n======== ${hypId} L1 ${kind} HYP ========`);
    applyHyp(hypId);
    const hyp = runL1(hypId, kind);
    out[kind] = {
      kind,
      baseOk: base.ok,
      hypOk: hyp.ok,
      baseOps: base.ok ? l1Ops(base.json, kind) : null,
      hypOps: hyp.ok ? l1Ops(hyp.json, kind) : null,
      baseError: base.ok ? null : base.error,
      hypError: hyp.ok ? null : hyp.error,
    };
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outRoot, { recursive: true });

  if (args.dryApply) {
    const checked = dryApplyAll();
    console.log('Dry-apply: all hyps syntax OK');
    console.log(checked.map((c) => `${c.id}:${c.files}`).join(' '));
    return;
  }

  const targets = catalogPlusStack(args.only);
  const results = [];
  let leaveKeepTree = false;

  try {
    for (const meta of targets) {
      console.log(`\n################ ${meta.id} (${meta.kind}) ################`);
      const sceneResults = [];
      if (!args.skipL3) {
        for (const key of meta.l3 || []) {
          sceneResults.push(measureScenePair(meta.id, SCENES[key], args, meta.detailedStats));
        }
      }
      if (!args.skipL2) {
        for (const key of meta.l2 || []) {
          sceneResults.push(measureScenePair(meta.id, SCENES[key], args, meta.detailedStats));
        }
      }
      let l1 = {};
      if (!args.skipL1 && meta.l1?.length) {
        l1 = measureL1Pair(meta.id, meta.l1);
      }
      const decision = decideHyp(meta, sceneResults, l1);
      const row = { id: meta.id, kind: meta.kind, scenes: sceneResults, l1, decision };
      results.push(row);
      writeJson(path.join(outRoot, meta.id, 'verdict.json'), row);
      console.log(`${meta.id} => ${decision.verdict}: ${decision.reasons[0]}`);
    }

    printTable(results);
    const summary = {
      main: '0695a8d',
      protocol: {
        l3: { runs: args.runs, warmupMs: args.warmupMs, durationMs: args.durationMs, headed: true, src: true },
        l2: { runs: args.l2Runs, warmupMs: args.l2WarmupMs, durationMs: args.l2DurationMs, headed: false, src: true },
        thresholdPct: 3,
        workloadPct: 5,
      },
      results,
    };
    writeJson(path.join(outRoot, 'campaign-verdict.json'), summary);

    const drops = results.filter((r) => r.decision.verdict === 'DROP' && r.id !== 'STACK').map((r) => r.id);
    const measuredIds = results.filter((r) => r.id !== 'STACK').map((r) => r.id);
    const ranFull = CANONICAL_ORDER.every((id) => measuredIds.includes(id));
    const keepIds = CANONICAL_ORDER.filter((id) => {
      const row = results.find((r) => r.id === id);
      if (!row) return true;
      return row.decision.verdict !== 'DROP';
    });

    if (drops.length && !args.skipConfirm && ranFull) {
      console.log(`\nReverting DROPs: ${drops.join(', ')}`);
      console.log(`Keeping: ${keepIds.join(', ')}`);
      leaveKeepTree = true;
      const confirm = { drops, keeps: keepIds, scenes: [] };
      const confirmArgs = { ...args, runs: args.confirmRuns };
      for (const key of ['balls', 'predator']) {
        confirm.scenes.push(
          measurePairWithApplies(
            'STACK_KEEP',
            SCENES[key],
            confirmArgs,
            false,
            () => applyHyp('BASE'),
            () => applyKeepIds(keepIds)
          )
        );
      }
      writeJson(path.join(outRoot, 'stack-after-revert.json'), confirm);
      console.log('Re-measured STACK_KEEP (2-run headed Balls+Predator) after DROP reverts.');
    } else if (drops.length && !ranFull) {
      console.log(`Partial campaign; not rewriting src. DROPs: ${drops.join(', ')}`);
    }
  } finally {
    if (!leaveKeepTree) restoreHead();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(repoRoot, 'tests/bench/runMicroOptsAb.mjs')) {
  main();
}
