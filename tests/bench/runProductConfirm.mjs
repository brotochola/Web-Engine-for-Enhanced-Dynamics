#!/usr/bin/env node
/**
 * Headed product confirm: main 0695a8d + always-on load counts
 * versus the current keep tree (HASH, P2, P6, HYGIENE, COLLIDE).
 *
 * Snapshots working src first so restoreMain cannot eat uncommitted work.
 *
 *   node tests/bench/runProductConfirm.mjs
 *   node tests/bench/runProductConfirm.mjs --runs 5
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { pctDelta, writeJson } from './featureTournamentLib.mjs';
import { MAIN_REV } from './micro-opts-hyps/hypPatches.mjs';
import {
  applyBaselineRev,
  fmtDeltaPct,
  measureSceneSide,
  renderCompareTable,
  restoreSrcTree,
  snapshotSrcTree,
  workloadOk,
} from './measureLib.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const emitMicro = path.join(repoRoot, 'tests/bench/particleEmitMicrobench.mjs');
const outRoot = path.join(repoRoot, 'tests/results/product-confirm');

const KEEP_IDS = ['HASH', 'P2', 'P6', 'HYGIENE', 'COLLIDE'];
const PRODUCT_WORKERS = [
  'physics_STEP_MS',
  'logic0_STEP_MS',
  'particle_STEP_MS',
  'spatialMax_STEP_MS',
  'pixi_STEP_MS',
];

const SCENES = {
  balls: {
    key: 'balls',
    path: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
    headed: true,
    workload: ['BODY_COUNT'],
  },
  predator: {
    key: 'predator',
    path: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    headed: true,
    workload: ['BODY_COUNT', 'ACTIVE_PARTICLES'],
  },
};

function parseArgs(argv) {
  const out = {
    runs: 5,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    skipScenes: false,
    skipKernels: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || DEFAULT_WARMUP_MS;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || DEFAULT_DURATION_MS;
    else if (a === '--skip-scenes') out.skipScenes = true;
    else if (a === '--skip-kernels') out.skipKernels = true;
  }
  return out;
}

function applyBaseline() {
  applyBaselineRev(MAIN_REV);
}

function measureScene(tag, scene, args, applyA, applyB) {
  const dir = path.join(outRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  const measureArgs = {
    runs: args.runs,
    stressRuns: args.runs,
    warmupMs: args.warmupMs,
    durationMs: args.durationMs,
    stressWarmupMs: args.warmupMs,
    stressDurationMs: args.durationMs,
    headlessAll: false,
  };

  console.log(`\n======== ${tag} BASE (${args.runs} × ${args.warmupMs}/${args.durationMs}ms) ========`);
  applyA();
  const base = measureSceneSide(`${tag}-BASE`, scene, measureArgs, dir);
  if (!base.ok) return { ok: false, error: base.error, scene: scene.key };

  console.log(`\n======== ${tag} KEEP (${args.runs} × ${args.warmupMs}/${args.durationMs}ms) ========`);
  applyB();
  const hyp = measureSceneSide(`${tag}-KEEP`, scene, measureArgs, dir);
  if (!hyp.ok) return { ok: false, error: hyp.error, scene: scene.key };

  return {
    ok: true,
    scene: scene.key,
    base: base.summary,
    hyp: hyp.summary,
    workload: workloadOk(base.summary, hyp.summary, scene.workload),
    baseRows: base.rows,
    hypRows: hyp.rows,
  };
}

function runEmitKernel(label, outPath) {
  execFileSync(process.execPath, [emitMicro, '--output', outPath], { cwd: repoRoot, stdio: 'inherit' });
  const json = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  return { ok: true, ops: json.cases?.emitFlat_burst?.opsPerSec ?? null, json };
}

function decideProduct(scenes, kernel) {
  const reasons = [];
  let ballsBody = scenes.balls?.base?.BODY_COUNT?.median;
  if (scenes.balls?.ok && !(ballsBody > 0)) {
    return {
      verdict: 'FAIL',
      fasterThanMain: false,
      reasons: [`Balls median BODY_COUNT is ${ballsBody}. The report is invalid.`],
    };
  }

  const workerHits = [];
  for (const scene of Object.values(scenes)) {
    if (!scene || scene.skipped) continue;
    if (!scene.ok) {
      reasons.push(`${scene.scene} failed: ${scene.error || 'unknown'}`);
      continue;
    }
    if (!scene.workload.ok) {
      reasons.push(
        `${scene.scene} load not comparable: ${scene.workload.drifts
          .map((d) => (d.pct == null ? `${d.key} (${d.reason})` : `${d.key} ${d.pct.toFixed(1)}%`))
          .join(', ')}`
      );
      continue;
    }
    for (const metric of PRODUCT_WORKERS) {
      const b = scene.base[metric]?.median;
      const h = scene.hyp[metric]?.median;
      const d = pctDelta(h, b);
      if (d == null) continue;
      workerHits.push({ scene: scene.scene, metric, base: b, hyp: h, deltaPct: d });
    }
  }

  if (kernel?.baseOps && kernel?.hypOps) {
    const d = pctDelta(kernel.hypOps, kernel.baseOps);
    kernel.deltaPct = d;
    reasons.push(
      `Kernel emitFlat ${kernel.baseOps.toFixed(0)} → ${kernel.hypOps.toFixed(0)} ops/s (${d == null ? 'n/a' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`}). P6 is a kernel claim.`
    );
  }

  const loadFailed = reasons.some((r) => r.includes('load not comparable') || r.includes('BODY_COUNT is'));
  if (loadFailed) {
    return {
      verdict: 'NOT_FASTER',
      fasterThanMain: false,
      reasons: [
        'Product confirm requires comparable load on every gameplay scene. At least one scene failed that gate, so the pair does not exist.',
        ...reasons,
      ],
      workerHits,
    };
  }

  if (!workerHits.length) {
    return { verdict: 'NA', fasterThanMain: false, reasons: reasons.length ? reasons : ['no comparable workers'], workerHits };
  }

  const wins = workerHits.filter((p) => p.deltaPct <= -3);
  const regress = workerHits.filter((p) => p.deltaPct >= 3);
  const fasterThanMain = wins.length > 0 && regress.length === 0;
  return {
    verdict: fasterThanMain ? 'FASTER' : regress.length ? 'NOT_FASTER' : 'NOT_FASTER',
    fasterThanMain,
    reasons: [
      fasterThanMain
        ? `Load OK. At least one primary worker is 3% cheaper (${wins.map((p) => `${p.scene} ${p.metric}`).join(', ')}) and none is 3% worse.`
        : regress.length
          ? `Not faster than main: ${regress.map((p) => `${p.scene} ${p.metric} +${p.deltaPct.toFixed(1)}%`).join(', ')}`
          : `Load OK but no primary worker is 3% cheaper.`,
      ...reasons,
    ],
    workerHits,
    wins,
    regress,
  };
}

function writeSpanishReport(payload) {
  const { args, scenes, kernel, decision } = payload;
  const lines = [];
  lines.push('# Confirmación de producto: keep set versus main');
  lines.push('');
  lines.push('Este informe está escrito en prosa. La hipótesis es: el keep set de esta rama (HASH, P2, P6, HYGIENE, COLLIDE; sin PACT ni LIGHT), con contadores de carga siempre visibles, es más rápido que `main` `' + MAIN_REV + '` en las demos que ejecutan ese código.');
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(`- Capas: kernel Node \`emitFlat\` y escenas de gameplay headed (Balls y Predator).`);
  lines.push(`- Corridas: ${args.runs}. Warmup ${args.warmupMs} ms. Medida ${args.durationMs} ms.`);
  lines.push('- Ventana visible. Stats detalladas apagadas. Reintento de Playwright: 1.');
  lines.push(`- Baseline: \`${MAIN_REV}\` más el parche de contadores de carga (mismos contadores, velocidad de main).`);
  lines.push(`- Tratamiento: árbol keep actual. IDs: ${KEEP_IDS.join(', ')}.`);
  lines.push('- Carga válida si `BODY_COUNT` (Balls) y `BODY_COUNT` + `ACTIVE_PARTICLES` (Predator) quedan en ±5% y el cv de cada clave de carga es menor a 50%. Si Balls tiene `BODY_COUNT` mediano 0, el informe falla.');
  lines.push('');
  lines.push('## Números');
  lines.push('');
  for (const key of ['balls', 'predator']) {
    const row = scenes[key];
    lines.push(`### ${key}`);
    lines.push('');
    if (!row) {
      lines.push('No se midió.');
      lines.push('');
      continue;
    }
    if (!row.ok) {
      lines.push(`Falló: ${row.error || 'error desconocido'}`);
      lines.push('');
      continue;
    }
    const keys = ['BODY_COUNT', 'ACTIVE_PARTICLES', ...PRODUCT_WORKERS];
    lines.push(renderCompareTable(row.base, row.hyp, keys));
    lines.push('');
    lines.push(row.workload.ok
      ? 'Carga comparable (dentro de 5%).'
      : `Carga no comparable: ${row.workload.drifts.map((d) => d.key).join(', ')}.`);
    lines.push('');
  }
  if (kernel) {
    lines.push('### Kernel emitFlat');
    lines.push('');
    if (kernel.baseOps != null && kernel.hypOps != null) {
      const d = kernel.deltaPct;
      lines.push(`ops/s main ${kernel.baseOps.toFixed(0)}, keep ${kernel.hypOps.toFixed(0)} (${fmtDeltaPct(d)}). P6 se vende solo como win de kernel.`);
    } else {
      lines.push(`Kernel incompleto: ${kernel.error || 'sin ops'}`);
    }
    lines.push('');
  }
  lines.push('## Veredicto');
  lines.push('');
  lines.push(decision.fasterThanMain
    ? 'Sí: más rápido que main bajo las reglas de producto.'
    : 'No: no se puede afirmar que esta rama sea más rápida que main.');
  lines.push('');
  for (const r of decision.reasons) lines.push(`- ${r}`);
  lines.push('');
  lines.push('## Qué se aprendió');
  lines.push('');
  lines.push('Los contadores tienen que escribirse y el camino rápido de física tiene que llamar a writePhysicsStats. Si una escena de gameplay no cierra carga ±5%, el producto no es “más rápido que main” aunque otra escena gane. P6 se vende solo como win de kernel.');
  lines.push('');
  const md = lines.join('\n');
  fs.writeFileSync(path.join(outRoot, 'report.md'), md);
  return md;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotSrcTree();
  const scenes = {};
  let kernel = null;
  try {
    if (!args.skipKernels) {
      console.log('\n======== kernel emitFlat BASE ========');
      applyBaseline();
      const baseK = runEmitKernel('BASE', path.join(outRoot, 'emit-BASE.json'));
      console.log('\n======== kernel emitFlat KEEP ========');
      restoreSrcTree(snap);
      const hypK = runEmitKernel('KEEP', path.join(outRoot, 'emit-KEEP.json'));
      kernel = { baseOps: baseK.ops, hypOps: hypK.ops };
      kernel.deltaPct = pctDelta(kernel.hypOps, kernel.baseOps);
    }
    if (!args.skipScenes) {
      scenes.balls = measureScene('balls', SCENES.balls, args, applyBaseline, () => restoreSrcTree(snap));
      scenes.predator = measureScene('predator', SCENES.predator, args, applyBaseline, () => restoreSrcTree(snap));
    }
  } finally {
    restoreSrcTree(snap);
  }

  const decision = decideProduct(scenes, kernel);
  const payload = {
    main: MAIN_REV,
    keepIds: KEEP_IDS,
    protocol: {
      runs: args.runs,
      warmupMs: args.warmupMs,
      durationMs: args.durationMs,
      headed: true,
      collectDetailedStats: false,
      workloadPct: 5,
      thresholdPct: 3,
    },
    scenes,
    kernel,
    decision,
    args,
  };
  writeJson(path.join(outRoot, 'summary.json'), payload);
  const report = writeSpanishReport(payload);
  console.log('\n======== PRODUCT CONFIRM ========');
  console.log(decision.verdict);
  for (const r of decision.reasons) console.log(`- ${r}`);
  console.log(`\nWrote ${path.join(outRoot, 'report.md')}`);
  console.log(report.split('\n').slice(0, 8).join('\n'));
}

main();
