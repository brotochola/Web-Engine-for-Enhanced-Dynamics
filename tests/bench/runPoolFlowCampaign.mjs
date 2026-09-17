#!/usr/bin/env node
/**
 * Pool-flow campaign from the current tree. Never restoreMain.
 *
 *   pnpm bench:pool-flow
 *   pnpm bench:pool-flow --smoke
 *   pnpm bench:pool-flow --skip-ab --only bullets --workers 1
 *
 * Kernels → smoke n=1 → characterize 2×8/10 → A/B faces → headed 5×25/18 only on KEEP.
 */
import fs from 'node:fs';
import path from 'node:path';

import { applyBullet, applyBulletTwoPass, applyDecoScan } from './micro-opts-hyps/hypPatches.mjs';
import {
  SPEED_PCT,
  explainHit,
  measureSceneSide,
  parseMeasureArgs,
  pctDelta,
  renderCompareTable,
  repoRoot,
  restoreSnapshot,
  runKernelScript,
  snapshotFiles,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const outRoot = path.join(repoRoot, 'tests/results/pool-flow');

/** Only files the A/B faces patch. Do not snapshot/restore all of src (vendor + wasm). */
const HYP_FILES = [
  'src/core/bulletPool.js',
  'src/workers/particleWorker.js',
  'src/workers/abstractWorker.js',
  'src/util/sceneSharedBuffers.js',
  'src/util/sceneWorkerBootstrap.js',
  'src/util/bulletTick.js',
];

const CELLS = [
  {
    id: 'bullets-1w',
    flow: 'bullets',
    workers: 1,
    load: ['ACTIVE_BULLETS'],
    primary: 'particle_STEP_MS',
    secondary: ['logic0_STEP_MS'],
    scene: {
      key: 'bulletStorm1W',
      path: '/tests/bench/stressScenes/bulletStormScene.js',
      exportName: 'BulletStormScene1W',
      headed: false,
    },
  },
  {
    id: 'bullets-3w',
    flow: 'bullets',
    workers: 3,
    load: ['ACTIVE_BULLETS'],
    primary: 'particle_STEP_MS',
    secondary: ['logic0_STEP_MS'],
    scene: {
      key: 'bulletStorm3W',
      path: '/tests/bench/stressScenes/bulletStormScene.js',
      exportName: 'BulletStormScene3W',
      headed: false,
    },
  },
  {
    id: 'deco-fixed-1w',
    flow: 'deco-fixed',
    workers: 1,
    load: ['ACTIVE_DECORATIONS'],
    primary: 'particle_STEP_MS',
    secondary: ['pixi_STEP_MS', 'logic0_STEP_MS'],
    scene: {
      key: 'decoFixed1W',
      path: '/tests/bench/stressScenes/decoFixedStressScene.js',
      exportName: 'DecoFixedStressScene1W',
      headed: false,
    },
  },
  {
    id: 'deco-fixed-3w',
    flow: 'deco-fixed',
    workers: 3,
    load: ['ACTIVE_DECORATIONS'],
    primary: 'particle_STEP_MS',
    secondary: ['pixi_STEP_MS', 'logic0_STEP_MS'],
    scene: {
      key: 'decoFixed3W',
      path: '/tests/bench/stressScenes/decoFixedStressScene.js',
      exportName: 'DecoFixedStressScene3W',
      headed: false,
    },
  },
  {
    id: 'deco-churn-1w',
    flow: 'deco-churn',
    workers: 1,
    load: ['ACTIVE_DECORATIONS'],
    primary: 'particle_STEP_MS',
    secondary: ['pixi_STEP_MS', 'logic0_STEP_MS'],
    scene: {
      key: 'decoChurn1W',
      path: '/tests/bench/stressScenes/decoChurnStressScene.js',
      exportName: 'DecoChurnStressScene1W',
      headed: false,
    },
  },
  {
    id: 'deco-churn-3w',
    flow: 'deco-churn',
    workers: 3,
    load: ['ACTIVE_DECORATIONS'],
    primary: 'particle_STEP_MS',
    secondary: ['pixi_STEP_MS', 'logic0_STEP_MS'],
    scene: {
      key: 'decoChurn3W',
      path: '/tests/bench/stressScenes/decoChurnStressScene.js',
      exportName: 'DecoChurnStressScene3W',
      headed: false,
    },
  },
  {
    id: 'emit-1w',
    flow: 'emit',
    workers: 1,
    load: ['ACTIVE_PARTICLES'],
    primary: 'logic0_STEP_MS',
    secondary: ['particle_STEP_MS'],
    scene: {
      key: 'particleEmit1W',
      path: '/tests/bench/stressScenes/particleEmitStressScene.js',
      exportName: 'ParticleEmitStressScene',
      headed: false,
    },
  },
  {
    id: 'emit-3w',
    flow: 'emit',
    workers: 3,
    load: ['ACTIVE_PARTICLES'],
    primary: 'logic0_STEP_MS',
    secondary: ['particle_STEP_MS'],
    scene: {
      key: 'particleEmit3W',
      path: '/tests/bench/stressScenes/particleEmitStressScene.js',
      exportName: 'ParticleEmitStressScene3W',
      headed: false,
    },
  },
];

function parseArgv(argv) {
  const out = parseMeasureArgs(argv);
  out.skipAb = false;
  out.skipSmoke = false;
  out.skipCharacterize = false;
  out.workers = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-ab') out.skipAb = true;
    else if (argv[i] === '--skip-smoke') out.skipSmoke = true;
    else if (argv[i] === '--skip-characterize') out.skipCharacterize = true;
    else if (argv[i] === '--workers' && argv[i + 1]) {
      out.workers = String(argv[++i])
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => n === 1 || n === 3);
    }
  }
  if (out.smoke) {
    out.skipAb = true;
    out.skipCharacterize = true;
    out.skipKernels = out.skipKernels || false;
  }
  return out;
}

function selectedCells(args) {
  return CELLS.filter((c) => {
    if (args.only && !args.only.includes(c.flow) && !args.only.includes(c.id)) return false;
    if (args.workers && !args.workers.includes(c.workers)) return false;
    return true;
  });
}

function decideMs(baseStat, hypStat, metric) {
  const base = baseStat?.median;
  const hyp = hypStat?.median;
  const deltaPct = pctDelta(hyp, base);
  const hit = { metric, base, hyp, deltaPct, higherBetter: false };
  if (deltaPct == null) return { verdict: 'FAIL', hit, reason: `${metric}: no hay mediana comparable.` };
  if (deltaPct <= -SPEED_PCT) return { verdict: 'KEEP', hit, reason: explainHit(hit) };
  if (deltaPct >= SPEED_PCT) return { verdict: 'WORSE', hit, reason: explainHit(hit) };
  return { verdict: 'TIE', hit, reason: explainHit(hit) };
}

function fmtDrift(work) {
  if (!work?.drifts?.length) return 'carga OK';
  return work.drifts
    .map((d) => (d.reason ? `${d.key} ${d.reason}` : `${d.key} ${d.pct?.toFixed?.(1)}%`))
    .join(', ');
}

function fmtStat(stat) {
  if (!stat || !Number.isFinite(stat.median)) return 'n/a';
  const cv = Number.isFinite(stat.cv) ? ` (cv ${(stat.cv * 100).toFixed(1)}%)` : '';
  return `${stat.median.toFixed(3)}${cv}`;
}

function loadOkSingle(summary, keys) {
  return workloadOk(summary, summary, keys);
}

function applyFace(id) {
  if (id === 'BASE') return;
  if (id === 'BTWOPASS') applyBulletTwoPass();
  else if (id === 'BULLET') applyBullet({ overlay: false });
  else if (id === 'DECOSCAN') applyDecoScan();
  else throw new Error(`unknown face ${id}`);
}

function measureCurrent(label, cell, args, dir) {
  return measureSceneSide(label, cell.scene, args, dir, cell.flow);
}

function measurePair(tag, cell, args, snap, applyHypFace) {
  const dir = path.join(outRoot, tag, cell.id);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n======== ${tag} ${cell.id} BASE ========`);
  restoreSnapshot(snap);
  const baseSide = measureCurrent(`${tag}-${cell.id}-BASE`, cell, args, dir);
  if (!baseSide.ok) return { ok: false, error: baseSide.error, cell: cell.id, tag };

  console.log(`\n======== ${tag} ${cell.id} HYP ========`);
  restoreSnapshot(snap);
  applyHypFace();
  const hypSide = measureCurrent(`${tag}-${cell.id}-HYP`, cell, args, dir);
  restoreSnapshot(snap);
  if (!hypSide.ok) return { ok: false, error: hypSide.error, cell: cell.id, tag };

  const work = workloadOk(baseSide.summary, hypSide.summary, cell.load);
  const speed = decideMs(baseSide.summary[cell.primary], hypSide.summary[cell.primary], cell.primary);
  let secondary = null;
  const secKey = cell.secondary?.[0];
  if (secKey) {
    secondary = decideMs(baseSide.summary[secKey], hypSide.summary[secKey], secKey);
  }
  let verdict = 'FAIL';
  if (!work.ok) verdict = 'FAIL';
  else if (speed.verdict === 'KEEP' && secondary && secondary.verdict === 'WORSE') {
    verdict = 'TIE';
  } else verdict = speed.verdict;
  return {
    ok: true,
    tag,
    cell: cell.id,
    flow: cell.flow,
    workers: cell.workers,
    headed: baseSide.headed,
    runs: baseSide.runs,
    warmupMs: baseSide.warmupMs,
    durationMs: baseSide.durationMs,
    base: baseSide.summary,
    hyp: hypSide.summary,
    workload: work,
    speed,
    secondary,
    verdict,
  };
}

function kernelTwoPassKeep(kernelJson) {
  const pairs = kernelJson?.occupancyPairs || {};
  return Object.values(pairs).some(
    (row) => row && row.occPct <= 10 && typeof row.twoPassVsFused === 'number' && row.twoPassVsFused >= SPEED_PCT
  );
}

function pairSection(title, pair, extraKeys) {
  if (!pair) return `## ${title}\n\nNo se midió.\n`;
  if (!pair.ok) return `## ${title}\n\nFalló: ${pair.error}\n`;
  const keys = [
    'ACTIVE_BULLETS',
    'ACTIVE_DECORATIONS',
    'ACTIVE_PARTICLES',
    'particle_STEP_MS',
    'logic0_STEP_MS',
    'pixi_STEP_MS',
    ...extraKeys,
  ];
  const lines = [
    `## ${title}`,
    '',
    `${pair.headed ? 'Headed' : 'Headless'} ${pair.runs} × ${pair.warmupMs} / ${pair.durationMs} ms. Detailed stats off.`,
    '',
    renderCompareTable(pair.base, pair.hyp, keys),
    '',
    `Carga: ${fmtDrift(pair.workload)}.`,
    '',
    pair.verdict === 'FAIL'
      ? `Veredicto de esta cara: **FAIL**. ${fmtDrift(pair.workload)}. No se usa el delta como keep/drop.`
      : `Veredicto de esta cara: **${pair.verdict}**. ${pair.speed?.reason || ''}`,
    '',
  ];
  return lines.join('\n');
}

function characterizeSection(cells, results) {
  const lines = [
    '## Caracterización (árbol actual, sin A/B)',
    '',
    'Headless 2 × 8 s / 10 s salvo `--smoke`. BASE = HEAD. Pregunta: ¿tres logic workers encarecen `particle_STEP_MS` o `logic0_STEP_MS` con la misma mediana de carga?',
    '',
  ];
  for (const cell of cells) {
    const row = results[cell.id];
    lines.push(`### ${cell.id}`);
    lines.push('');
    if (!row) {
      lines.push('No se midió.');
      lines.push('');
      continue;
    }
    if (!row.ok) {
      lines.push(`Falló: ${row.error}`);
      lines.push('');
      continue;
    }
    const s = row.summary;
    const load = cell.load.map((k) => `${k} ${fmtStat(s[k])}`).join(', ');
    const work = loadOkSingle(s, cell.load);
    lines.push(
      `- ${cell.primary}: ${fmtStat(s[cell.primary])}. logic0: ${fmtStat(s.logic0_STEP_MS)}. particle: ${fmtStat(s.particle_STEP_MS)}. pixi: ${fmtStat(s.pixi_STEP_MS)}.`
    );
    lines.push(`- Carga: ${load}. ${work.ok ? 'OK' : fmtDrift(work)}.`);
    lines.push(`- Corridas ${row.runs} × ${row.warmupMs}/${row.durationMs} ms.`);
    lines.push('');
  }
  for (const flow of ['bullets', 'deco-fixed', 'deco-churn', 'emit']) {
    const one = results[`${flow}-1w`];
    const three = results[`${flow}-3w`];
    const a = one?.ok ? one.summary : null;
    const b = three?.ok ? three.summary : null;
    if (!a || !b) continue;
    const pKey = CELLS.find((c) => c.flow === flow)?.primary || 'particle_STEP_MS';
    const dP = pctDelta(b[pKey]?.median, a[pKey]?.median);
    const dL = pctDelta(b.logic0_STEP_MS?.median, a.logic0_STEP_MS?.median);
    const dPa = pctDelta(b.particle_STEP_MS?.median, a.particle_STEP_MS?.median);
    lines.push(
      `1W vs 3W **${flow}**: primaria ${pKey} ${dP == null ? 'n/a' : `${dP.toFixed(1)}%`}; logic0 ${dL == null ? 'n/a' : `${dL.toFixed(1)}%`}; particle ${dPa == null ? 'n/a' : `${dPa.toFixed(1)}%`} (positivo = 3W más caro).`
    );
    lines.push('');
  }
  return lines.join('\n');
}

function writeReport(doc) {
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'report.md'), doc);
}

function buildReport({
  args,
  cells,
  kernels,
  smoke,
  characterize,
  ab,
  headed,
}) {
  const lines = [
    '# Campaña de flujos de pool (balas, decoraciones, partículas)',
    '',
    'Esto no afirma que WeedJS sea más rápida. Compact+lock de balas sigue dropped en el log histórico (+1.9% isolation, +7.6% estrés). Speed-cache ya kept en kernel. Predator no entra. `SharedAtomicPool` sigue siendo la pila de huecos, no la lista viva.',
    '',
    `Fecha: ${new Date().toISOString().slice(0, 10)}. Árbol actual. Headless ${args.smoke ? 'smoke 1×4/4' : '2×8/10'}. Detailed stats off.`,
    '',
    '## Kernels de ocupación',
    '',
  ];
  if (kernels.bullets) {
    lines.push('### Balas (`tickBulletsBuffers`)');
    lines.push('');
    lines.push(
      'Tres algoritmos, mismo checksum (`x += vx/60` y suma de x de vivas): fused (prod), dos pases (scan `active[]` → `liveIndices`), live-given (lista ya armada).'
    );
    lines.push('');
    const pairs = kernels.bullets.occupancyPairs || {};
    for (const [key, row] of Object.entries(pairs)) {
      lines.push(
        `- ${key}: fused→two-pass ${row.twoPassVsFused?.toFixed?.(1)}%, fused→given ${row.givenVsFused?.toFixed?.(1)}% (${row.liveCount}/${row.poolSize}).`
      );
    }
    lines.push('');
    lines.push(
      `Two-pass keep de kernel en ocupación 10%: **${kernelTwoPassKeep(kernels.bullets) ? 'SÍ' : 'NO'}**. Compact live-given no mergea solo.`
    );
    lines.push('');
  } else {
    lines.push('Kernel de balas no corrido.');
    lines.push('');
  }
  if (kernels.particles) {
    lines.push('### Partículas (`buildActiveListBuffers` + physics)');
    lines.push('');
    const occ = kernels.particles.occupancy || {};
    for (const [key, row] of Object.entries(occ)) {
      lines.push(
        `- ${key}: build ${Math.round(row.buildOps || 0)} ops/s, build+physics ${Math.round(row.integrateOps || 0)} ops/s (${row.liveCount}/${row.pool}).`
      );
    }
    lines.push('');
  }
  if (kernels.deco) {
    lines.push('### Decoraciones (sway scan vs snapshot)');
    lines.push('');
    const pairs = kernels.deco.snapshotVsScanPct || {};
    for (const [key, d] of Object.entries(pairs)) {
      lines.push(`- ${key}: snapshot vs scan ${typeof d === 'number' ? `${d.toFixed(1)}%` : 'n/a'} ops/s (positivo = snapshot más barato).`);
    }
    lines.push('');
  }

  lines.push(characterizeSection(cells, characterize));
  lines.push('');
  lines.push('## Smoke de carga');
  lines.push('');
  if (!Object.keys(smoke).length) {
    lines.push('Smoke no corrido.');
    lines.push('');
  } else {
    for (const cell of cells) {
      const row = smoke[cell.id];
      if (!row) continue;
      if (!row.ok) {
        lines.push(`- ${cell.id}: FALLÓ ${row.error}`);
        continue;
      }
      const work = loadOkSingle(row.summary, cell.load);
      const load = cell.load.map((k) => `${k} ${fmtStat(row.summary[k])}`).join(', ');
      lines.push(`- ${cell.id}: ${work.ok ? 'carga OK' : fmtDrift(work)}. ${load}.`);
    }
    lines.push('');
  }

  lines.push('## A/B de caras');
  lines.push('');
  lines.push(pairSection('BTWOPASS kernel está en el JSON de ocupación. Estrés 1W', ab.btwopass1w, []));
  lines.push(pairSection('BTWOPASS estrés 3W', ab.btwopass3w, []));
  lines.push(pairSection('BULLET compact+lock 1W', ab.bullet1w, []));
  lines.push(pairSection('BULLET compact+lock 3W', ab.bullet3w, []));
  lines.push(pairSection('DECOSCAN fija 1W', ab.decoscanFixed1w, []));
  lines.push(pairSection('DECOSCAN fija 3W', ab.decoscanFixed3w, []));
  lines.push(pairSection('DECOSCAN churn 1W', ab.decoscanChurn1w, []));
  lines.push(pairSection('DECOSCAN churn 3W', ab.decoscanChurn3w, []));

  lines.push('## Headed');
  lines.push('');
  if (!headed.length) {
    lines.push('No hubo KEEP headless, o se saltó headed. Predator no entra.');
    lines.push('');
  } else {
    for (const h of headed) {
      lines.push(pairSection(`Headed ${h.tag} ${h.cell}`, h, []));
    }
  }

  lines.push('## Veredictos');
  lines.push('');
  const compact1 = ab.bullet1w?.verdict;
  const compact3 = ab.bullet3w?.verdict;
  lines.push(
    `- Compact+lock: 1W **${compact1 || 'n/a'}**, 3W **${compact3 || 'n/a'}**. Keep solo si estrés −3% con carga OK. Si 1W KEEP y 3W WORSE, el lock es el techo y no entra a \`src/\`.`
  );
  const two1 = ab.btwopass1w?.verdict;
  const two3 = ab.btwopass3w?.verdict;
  const twoK = kernels.bullets ? kernelTwoPassKeep(kernels.bullets) : false;
  lines.push(
    `- Two-pass: kernel sparse ≥3% ops/s **${twoK ? 'SÍ' : 'NO'}**. Storm 1W **${two1 || 'n/a'}**, 3W **${two3 || 'n/a'}**. Candidato a merge solo si kernel sparse gana y storm no empeora ≥3%. Compact+lock no viaja de regalo.`
  );
  lines.push(
    `- DECOSCAN: si scan es ≥3% peor, el snapshot de producción se confirma. Fija 1W **${ab.decoscanFixed1w?.verdict || 'n/a'}**, churn 1W **${ab.decoscanChurn1w?.verdict || 'n/a'}**.`
  );
  lines.push('');
  lines.push('PACT no se reabre. Compact viejo +1.9% y WORSE +7.6% no se borran del log.');
  lines.push('');
  return lines.join('\n');
}

function byId(cells, id) {
  return cells.find((c) => c.id === id);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  args.headlessAll = true;
  const cells = selectedCells(args);
  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotFiles(HYP_FILES);
  const kernels = {};
  const smoke = {};
  const characterize = {};
  const ab = {};
  const headed = [];

  try {
    if (!args.skipKernels) {
      console.log('\n======== kernels ========');
      kernels.bullets = runKernelScript(
        'tests/bench/bulletTickMicrobench.mjs',
        path.join(outRoot, 'bullet-tick-kernel.json')
      );
      kernels.particles = runKernelScript(
        'tests/bench/particleIntegrateMicrobench.mjs',
        path.join(outRoot, 'particle-integrate-kernel.json')
      );
      kernels.deco = runKernelScript(
        'tests/bench/decorationSwayMicrobench.mjs',
        path.join(outRoot, 'deco-sway-kernel.json')
      );
      writeJson(path.join(outRoot, 'kernels.json'), {
        twoPassSparseKeep: kernelTwoPassKeep(kernels.bullets),
        occupancyPairs: kernels.bullets.occupancyPairs,
        particleOccupancy: kernels.particles.occupancy,
        decoSnapshotVsScan: kernels.deco.snapshotVsScanPct,
      });
    }

    const smokeArgs = { ...args, smoke: true, stressRuns: 1, stressWarmupMs: 4000, stressDurationMs: 4000, runs: 1 };
    if (!args.skipSmoke) {
      for (const cell of cells) {
        console.log(`\n======== smoke ${cell.id} ========`);
        const dir = path.join(outRoot, 'smoke', cell.id);
        fs.mkdirSync(dir, { recursive: true });
        restoreSnapshot(snap);
        const side = measureCurrent(`smoke-${cell.id}`, cell, smokeArgs, dir);
        smoke[cell.id] = side;
        if (side.ok) {
          const work = loadOkSingle(side.summary, cell.load);
          console.log(`smoke ${cell.id}: ${work.ok ? 'carga OK' : fmtDrift(work)}`);
        } else {
          console.log(`smoke ${cell.id}: FAIL ${side.error}`);
        }
      }
      writeJson(path.join(outRoot, 'smoke.json'), smoke);
    }

    if (!args.skipCharacterize && !args.smoke) {
      for (const cell of cells) {
        console.log(`\n======== characterize ${cell.id} ========`);
        const dir = path.join(outRoot, 'characterize', cell.id);
        fs.mkdirSync(dir, { recursive: true });
        restoreSnapshot(snap);
        const side = measureCurrent(`char-${cell.id}`, cell, args, dir);
        characterize[cell.id] = side;
      }
      writeJson(path.join(outRoot, 'characterize.json'), characterize);
    }

    const smokeLoadOk = (id) => {
      const row = smoke[id];
      if (!row) return true;
      if (!row.ok) return false;
      const cell = byId(CELLS, id);
      return loadOkSingle(row.summary, cell.load).ok;
    };

    if (!args.skipAb && !args.smoke) {
      const storm1 = byId(cells, 'bullets-1w');
      const storm3 = byId(cells, 'bullets-3w');
      const fixed1 = byId(cells, 'deco-fixed-1w');
      const fixed3 = byId(cells, 'deco-fixed-3w');
      const churn1 = byId(cells, 'deco-churn-1w');
      const churn3 = byId(cells, 'deco-churn-3w');

      if (storm1 && smokeLoadOk('bullets-1w')) {
        ab.btwopass1w = measurePair('BTWOPASS', storm1, args, snap, applyBulletTwoPass);
      }
      if (storm3 && smokeLoadOk('bullets-3w')) {
        ab.btwopass3w = measurePair('BTWOPASS', storm3, args, snap, applyBulletTwoPass);
      }
      if (storm1 && smokeLoadOk('bullets-1w')) {
        ab.bullet1w = measurePair('BULLET', storm1, args, snap, () => applyBullet({ overlay: false }));
      }
      if (storm3 && smokeLoadOk('bullets-3w')) {
        ab.bullet3w = measurePair('BULLET', storm3, args, snap, () => applyBullet({ overlay: false }));
      }
      if (fixed1 && smokeLoadOk('deco-fixed-1w')) {
        ab.decoscanFixed1w = measurePair('DECOSCAN', fixed1, args, snap, applyDecoScan);
      }
      if (fixed3 && smokeLoadOk('deco-fixed-3w')) {
        ab.decoscanFixed3w = measurePair('DECOSCAN', fixed3, args, snap, applyDecoScan);
      }
      if (churn1 && smokeLoadOk('deco-churn-1w')) {
        ab.decoscanChurn1w = measurePair('DECOSCAN', churn1, args, snap, applyDecoScan);
      }
      if (churn3 && smokeLoadOk('deco-churn-3w')) {
        ab.decoscanChurn3w = measurePair('DECOSCAN', churn3, args, snap, applyDecoScan);
      }
      writeJson(path.join(outRoot, 'ab.json'), ab);

      const keepPairs = Object.values(ab).filter((p) => p && p.ok && p.verdict === 'KEEP');
      if (keepPairs.length) {
        const headedArgs = {
          ...args,
          headlessAll: false,
          runs: 5,
          warmupMs: 25000,
          durationMs: 18000,
        };
        for (const keep of keepPairs) {
          const cell = byId(CELLS, keep.cell);
          if (!cell) continue;
          const headedScene = { ...cell, scene: { ...cell.scene, headed: true } };
          const applyHypFace =
            keep.tag === 'BTWOPASS'
              ? applyBulletTwoPass
              : keep.tag === 'BULLET'
                ? () => applyBullet({ overlay: false })
                : applyDecoScan;
          console.log(`\n======== headed ${keep.tag} ${cell.id} ========`);
          const pair = measurePair(`${keep.tag}-headed`, headedScene, headedArgs, snap, applyHypFace);
          headed.push(pair);
        }
        writeJson(path.join(outRoot, 'headed.json'), headed);
      }
    }
  } finally {
    restoreSnapshot(snap);
  }

  const md = buildReport({ args, cells, kernels, smoke, characterize, ab, headed });
  writeReport(md);
  writeJson(path.join(outRoot, 'verdict.json'), {
    twoPassSparseKeep: kernels.bullets ? kernelTwoPassKeep(kernels.bullets) : null,
    ab: Object.fromEntries(Object.entries(ab).map(([k, v]) => [k, v && { ok: v.ok, verdict: v.verdict, error: v.error }])),
    headed: headed.map((h) => ({ ok: h.ok, verdict: h.verdict, cell: h.cell, tag: h.tag })),
  });
  console.log(`\nWrote ${path.join(outRoot, 'report.md')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
