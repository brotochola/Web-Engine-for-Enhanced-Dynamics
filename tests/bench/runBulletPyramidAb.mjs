#!/usr/bin/env node
/**
 * Bullet tick pyramid A/B from the current tree (scan + speed-cache).
 *
 *   node tests/bench/runBulletPyramidAb.mjs
 *   node tests/bench/runBulletPyramidAb.mjs --skip-predator
 *
 * Compact: BASE = scan (HEAD), HYP = compact list + CAS lock.
 * Speed-cache: BASE = cached speed (HEAD), HYP = hypot + Set (inverse of e736f2e).
 * Compact does not merge unless stress or Predator keep. Kernel-only is not enough.
 */
import fs from 'node:fs';
import path from 'node:path';

import { applyHyp, restoreHead } from './micro-opts-hyps/hypPatches.mjs';
import {
  SPEED_PCT,
  explainHit,
  measureSceneSide,
  parseMeasureArgs,
  pctDelta,
  renderCompareTable,
  repoRoot,
  restoreSrcTree,
  runKernelScript,
  snapshotSrcTree,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const outRoot = path.join(repoRoot, 'tests/results/bullet-tick');

const STRESS = {
  key: 'bulletStress',
  path: '/tests/bench/stressScenes/bulletStressScene.js',
  exportName: 'BulletStressScene',
  headed: false,
};

const PREDATOR = {
  key: 'predator',
  path: '/demos/predatorScene/predatorScene.js',
  exportName: 'PredatorScene',
  headed: true,
};

function parseArgv(argv) {
  const out = parseMeasureArgs(argv);
  out.skipPredator = false;
  out.skipStress = false;
  out.skipKernel = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-predator') out.skipPredator = true;
    else if (argv[i] === '--skip-stress') out.skipStress = true;
    else if (argv[i] === '--skip-kernel') out.skipKernel = true;
  }
  return out;
}

function compactKernelKeep(kernelJson) {
  if (!kernelJson?.compactPairs) return false;
  return Object.values(kernelJson.compactPairs).some((d) => typeof d === 'number' && d >= SPEED_PCT);
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

function measurePair(tag, scene, args, applyBase, applyHypFace) {
  const dir = path.join(outRoot, tag, scene.key);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n======== ${tag} ${scene.key} BASE ========`);
  applyBase();
  const baseSide = measureSceneSide(`${tag}-${scene.key}-BASE`, scene, args, dir, tag);
  if (!baseSide.ok) return { ok: false, error: baseSide.error, scene: scene.key, tag };

  console.log(`\n======== ${tag} ${scene.key} HYP ========`);
  applyHypFace();
  const hypSide = measureSceneSide(`${tag}-${scene.key}-HYP`, scene, args, dir, tag);
  if (!hypSide.ok) return { ok: false, error: hypSide.error, scene: scene.key, tag };

  const loadKeys = scene.key === 'predator' ? ['ACTIVE_BULLETS', 'BODY_COUNT'] : ['ACTIVE_BULLETS'];
  const work = workloadOk(baseSide.summary, hypSide.summary, loadKeys);
  const speed = decideMs(baseSide.summary.particle_STEP_MS, hypSide.summary.particle_STEP_MS, 'particle_STEP_MS');
  let verdict = 'FAIL';
  if (!work.ok) verdict = 'FAIL';
  else verdict = speed.verdict;
  return {
    ok: true,
    tag,
    scene: scene.key,
    headed: baseSide.headed,
    runs: baseSide.runs,
    warmupMs: baseSide.warmupMs,
    durationMs: baseSide.durationMs,
    base: baseSide.summary,
    hyp: hypSide.summary,
    workload: work,
    speed,
    verdict,
  };
}

function fmtDrift(work) {
  if (!work?.drifts?.length) return 'carga OK';
  return work.drifts
    .map((d) => (d.reason ? `${d.key} ${d.reason}` : `${d.key} ${d.pct?.toFixed?.(1)}%`))
    .join(', ');
}

function pairSection(title, pair, extraKeys) {
  if (!pair) return `## ${title}\n\nNo se midió.\n`;
  if (!pair.ok) return `## ${title}\n\nFalló: ${pair.error}\n`;
  const keys = [
    'ACTIVE_BULLETS',
    'BODY_COUNT',
    'ACTIVE_PARTICLES',
    'particle_STEP_MS',
    'logic0_STEP_MS',
    'physics_STEP_MS',
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
      ? `Veredicto de esta cara: **FAIL**. ${fmtDrift(pair.workload)}. No se usa el delta de \`particle_STEP_MS\` como keep/drop.`
      : `Veredicto de esta cara: **${pair.verdict}**. ${pair.speed?.reason || ''}`,
    '',
  ];
  return lines.join('\n');
}

function writeReport({ kernel, compactStress, compactPredator, hypotPredator, compactKernelKeepFlag }) {
  const compactStressKeep = compactStress?.verdict === 'KEEP';
  const compactPredatorKeep = compactPredator?.verdict === 'KEEP';
  const compactMerge = compactStressKeep || compactPredatorKeep;
  const speedGameplay = hypotPredator?.verdict;

  const kernelLines = [];
  if (kernel) {
    const p = kernel.compactPairs || {};
    kernelLines.push(
      'Kernel Node, un proceso, mismo `tickBulletsBuffers`. Scan = `for i < maxBullets`. Compact = lista de índices vivos, sin lock. Checksum: tras un step `x += vx/60` y la suma de x de las vivas coincide scan vs compact.',
      '',
      `- hypot→cached ` +
        `tickOpen ${Math.round(kernel.cases.tickOpenHypot.opsPerSec)} → ${Math.round(kernel.cases.tickOpen.opsPerSec)} ops/s; ` +
        `tickCrowded ${Math.round(kernel.cases.tickCrowdedHypot.opsPerSec)} → ${Math.round(kernel.cases.tickCrowded.opsPerSec)} ops/s.`,
      `- dense 2048/2048 scan→compact ${Math.round(kernel.cases.tickCrowdedScan.opsPerSec)} → ${Math.round(kernel.cases.tickCrowdedCompact.opsPerSec)} ops/s (${p.denseCrowded?.toFixed?.(1)}%).`,
      `- sparse 256/2048 open ${p.sparseOpen2048?.toFixed?.(1)}%; crowded ${p.sparseCrowded2048?.toFixed?.(1)}%.`,
      `- sparse 256/8192 open ${p.sparseOpen8192?.toFixed?.(1)}%; crowded ${p.sparseCrowded8192?.toFixed?.(1)}%.`,
      `- Compact kernel ≥3% ops/s en algún par: **${compactKernelKeepFlag ? 'sí' : 'no'}**.`
    );
  }

  const body = [
    '# Pirámide del tick de balas: scan vs compact, y speed-cache en Predator',
    '',
    '## Qué se midió',
    '',
    'El árbol ya tiene `tickBulletsBuffers` con scan de `maxBullets` y `len = speed * dt`. Esta corrida completa la pirámide: kernel scan vs compact (índices vivos, sin lock), `BulletStressScene` headless con 3 logic workers y 8 shooters (320 spawn/tick partidos), y Predator headed 5×25/18.',
    '',
    'Compact en el motor es el hyp `BULLET`: lista viva en spawn/despawn + CAS `activeBulletsLock`. No entra a `src/` salvo keep en estrés o Predator. El kernel solo no basta para mergear el lock.',
    '',
    'Speed-cache ya está en producción. La cara de Predator aplica el parche invertido (hypot + `Set`) para ver si el keep de kernel se ve en juego.',
    '',
    'Primaria `particle_STEP_MS`. Carga `ACTIVE_BULLETS` (±5%, cv < 50%). FPS a 60 no cuenta. Compact viejo de Predator isolation (+1.9%) no se borra del log; este es protocolo nuevo, pedido explícito.',
    '',
    '## Setup',
    '',
    ...kernelLines,
    '',
    'Estrés: `BulletStressScene`, Chromium headless, `--src`, 2 × 8 s / 10 s. 3 logic workers, 8 drivers × 40 spawn/tick, pool 2048, paredes. BASE scan vs HYP compact+lock.',
    '',
    'Predator: ventana visible, 5 × 25 s / 18 s, detailed stats off. `maxBullets` 2048, 3 logic workers. No es fila de scoreboard de combate (`steadyCombat` sigue para eso). Si `ACTIVE_BULLETS` cv ≥ 50%, el par FAIL.

Compact BASE r3 de Predator se cayó: Chromium `net::ERR_NETWORK_CHANGED` al cargar módulos de `127.0.0.1`, workers muertos, `Target page ... has been closed`. El harness reintentó 1× y r3 salió (FPS 60). Las cinco corridas HYP de compact corrieron después a ~41 FPS; el par no es comparable.',
    '',
    pairSection('Estrés: scan vs compact+lock', compactStress, []),
    pairSection(
      'Predator: speed-cache (BASE) vs hypot+Set (HYP)',
      hypotPredator
        ? { ...hypotPredator, speed: hypotPredator.speed, verdict: hypotPredator.verdict }
        : null,
      ['ACTIVE_PARTICLES']
    ),
    pairSection('Predator: scan vs compact+lock', compactPredator, ['ACTIVE_PARTICLES']),
    '## Verdict',
    '',
  ];

  if (compactMerge) {
    body.push(
      `**Compact KEPT** para merge: ${compactStressKeep ? 'estrés' : ''}${compactStressKeep && compactPredatorKeep ? ' y ' : ''}${compactPredatorKeep ? 'Predator' : ''} cruzó −3% en \`particle_STEP_MS\` con carga OK.`
    );
  } else if (compactKernelKeepFlag && compactStress && compactStress.verdict !== 'KEEP') {
    body.push(
      '**Compact no entra a `src/`.** El kernel sparse ganó ops/s, pero el estrés y/o Predator no cruzaron −3% con carga OK. Kernel solo no mergea lock+lista.'
    );
  } else {
    body.push(
      '**Compact sigue dropped** para el motor. No hay keep de estrés ni de Predator. El scan de `maxBullets` se queda.'
    );
  }
  body.push('');

  if (!hypotPredator) {
    body.push('Speed-cache en Predator: no se midió.');
  } else if (hypotPredator.verdict === 'FAIL') {
    body.push(
      `Speed-cache en Predator: **FAIL**. ${fmtDrift(hypotPredator.workload)}. No se inventa el delta. El keep de kernel no se vende como Predator.`
    );
  } else if (hypotPredator.verdict === 'WORSE') {
    body.push(
      'Speed-cache en Predator: hypot+Set fue ≥3% más barato que el cache. El keep de kernel no se confirma en juego; el árbol sigue con cache hasta un retest. No se afirma Predator más rápido por este hyp.'
    );
  } else if (hypotPredator.verdict === 'KEEP') {
    body.push(
      'Speed-cache en Predator: **KEPT** como gameplay. `particle_STEP_MS` del árbol (cache) es ≥3% más barato que hypot+Set, con carga OK.'
    );
  } else {
    body.push(
      'Speed-cache en Predator: **TIE** (dentro de 3%). Sigue en el árbol como higiene del kernel keep; no se vende como Predator más rápido.'
    );
  }
  body.push('');
  body.push('No se afirma “WeedJS más rápida”. Compact no se afirma kept salvo el párrafo de merge de arriba.');
  body.push('');
  body.push('## What we learned');
  body.push('');
  body.push(
    compactKernelKeepFlag
      ? 'En pool sparse el scan de huecos se ve en ops/s. Con el pool lleno (~2048 vivas) scan y compact son casi el mismo loop; el lock y el snapshot son costo extra que el estrés/Predator tienen que pagar.'
      : 'Compact ni siquiera ganó 3% ops/s en sparse. El `continue` de slots vacíos es barato frente al linecast; no vale el lock en el motor.'
  );
  body.push('');

  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'report.md'), body.join('\n'), 'utf8');
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotSrcTree();
  const summary = {
    protocol: {
      stress: { runs: args.stressRuns, warmupMs: args.stressWarmupMs, durationMs: args.stressDurationMs, headed: false },
      predator: { runs: args.runs, warmupMs: args.warmupMs, durationMs: args.durationMs, headed: true },
      thresholdPct: SPEED_PCT,
    },
  };

  try {
    let kernel = null;
    if (!args.skipKernel) {
      console.log('\n======== kernel bulletTickMicrobench ========');
      kernel = runKernelScript(
        'tests/bench/bulletTickMicrobench.mjs',
        path.join(outRoot, 'kernel.json')
      );
    } else {
      const kernelPath = path.join(outRoot, 'kernel.json');
      if (fs.existsSync(kernelPath)) {
        kernel = JSON.parse(fs.readFileSync(kernelPath, 'utf8'));
        console.log('Loaded existing kernel.json (--skip-kernel)');
      }
    }
    if (kernel) {
      summary.kernel = {
        compactPairs: kernel.compactPairs,
        compactKernelKeep: kernel.compactKernelKeep,
        cases: kernel.cases,
      };
    }
    const compactKernelKeepFlag = kernel ? compactKernelKeep(kernel) : false;

    let compactStress = null;
    if (!args.skipStress) {
      compactStress = measurePair(
        'compact',
        STRESS,
        args,
        () => restoreSrcTree(snap),
        () => {
          restoreSrcTree(snap);
          applyHyp('BULLET', { reset: false });
        }
      );
      summary.compactStress = compactStress;
    } else {
      const prevPath = path.join(outRoot, 'pyramid-verdict.json');
      if (fs.existsSync(prevPath)) {
        const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
        compactStress = prev.compactStress || null;
        if (compactStress) {
          summary.compactStress = compactStress;
          console.log(`Loaded previous compact stress verdict: ${compactStress.verdict}`);
        }
      }
    }

    const compactAlive =
      compactKernelKeepFlag || compactStress?.verdict === 'KEEP' || compactStress?.verdict === 'TIE';

    let hypotPredator = null;
    let compactPredator = null;
    if (!args.skipPredator) {
      const rawHypot = measurePair(
        'bhypot',
        PREDATOR,
        args,
        () => restoreSrcTree(snap),
        () => {
          restoreSrcTree(snap);
          applyHyp('BHYPOT', { reset: false });
        }
      );
      if (!rawHypot.ok) {
        hypotPredator = rawHypot;
      } else {
        const cacheCheaper = decideMs(rawHypot.hyp.particle_STEP_MS, rawHypot.base.particle_STEP_MS, 'particle_STEP_MS');
        hypotPredator = {
          ...rawHypot,
          tag: 'speed-cache',
          speed: cacheCheaper,
          verdict: rawHypot.workload.ok ? cacheCheaper.verdict : 'FAIL',
        };
      }
      summary.hypotPredator = hypotPredator;

      if (compactAlive) {
        compactPredator = measurePair(
          'compact',
          PREDATOR,
          args,
          () => restoreSrcTree(snap),
          () => {
            restoreSrcTree(snap);
            applyHyp('BULLET', { reset: false });
          }
        );
        summary.compactPredator = compactPredator;
      } else if (!compactAlive) {
        console.log('Compact killed by kernel sparse + stress; skip Predator compact face.');
      }
    }

    writeJson(path.join(outRoot, 'pyramid-verdict.json'), summary);
    writeReport({
      kernel,
      compactStress,
      compactPredator,
      hypotPredator,
      compactKernelKeepFlag,
    });
    console.log(`\nWrote ${path.join(outRoot, 'report.md')}`);
    console.log(`compact kernel keep: ${compactKernelKeepFlag}`);
    if (compactStress) console.log(`compact stress: ${compactStress.verdict}`);
    if (hypotPredator) console.log(`speed-cache predator: ${hypotPredator.verdict}`);
    if (compactPredator) console.log(`compact predator: ${compactPredator.verdict}`);
  } finally {
    restoreSrcTree(snap);
    restoreHead();
  }
}

main();
