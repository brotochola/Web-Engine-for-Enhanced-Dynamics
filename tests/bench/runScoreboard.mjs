#!/usr/bin/env node
/**
 * Engine feature scoreboard: current src tree versus a git rev (default 0695a8d).
 *
 *   pnpm bench:scoreboard --vs 0695a8d
 *   pnpm bench:scoreboard --only box2d,emit,spatial --smoke
 *   pnpm bench:scoreboard --vs 0695a8d --headed-only box2d,visPoly,steadyCombat
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENGINE_FEATURES, filterFeatures, getFeature } from './engineFeatureCatalog.mjs';
import {
  SPEED_PCT,
  applyBaselineRev,
  explainHit,
  fmtDeltaPct,
  fmtStat,
  measureSceneSide,
  parseMeasureArgs,
  pctDelta,
  pickOpsWithKey,
  renderCompareTable,
  repoRoot,
  restoreSrcTree,
  runKernelScript,
  sceneMetricKeys,
  sceneWantsHeaded,
  snapshotSrcTree,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const outRoot = path.join(repoRoot, 'tests/results/scoreboard');

function runNodeTests() {
  execFileSync('pnpm', ['test:node'], { cwd: repoRoot, stdio: 'inherit', shell: true });
}

function runLockstep() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'tests/bench/runLockstepVisual.mjs'),
      '--headless',
      '--scene',
      'balls,liquidfun,lfstress,particles',
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
}

function decideRow(feature, kernel, scenePair) {
  const reasons = [];
  if (kernel && kernel.error) reasons.push(`kernel failed: ${kernel.error}`);
  if (scenePair && !scenePair.ok) reasons.push(`scene failed: ${scenePair.error || 'unknown'}`);
  if (scenePair?.workload && !scenePair.workload.ok) {
    reasons.push(
      `load not comparable: ${scenePair.workload.drifts
        .map((d) => (d.reason ? `${d.key} ${d.reason}` : `${d.key} ${d.pct?.toFixed?.(1)}%`))
        .join(', ')}`
    );
  }

  const hits = [];
  if (kernel?.baseOps != null && kernel?.hypOps != null) {
    const d = pctDelta(kernel.hypOps, kernel.baseOps);
    hits.push({
      metric: 'kernel',
      base: kernel.baseOps,
      hyp: kernel.hypOps,
      deltaPct: d,
      higherBetter: feature.kernel?.higherBetter !== false,
    });
  }
  if (scenePair?.ok && scenePair.workload?.ok) {
    for (const metric of feature.primary) {
      const b = scenePair.base[metric]?.median;
      const h = scenePair.hyp[metric]?.median;
      const d = pctDelta(h, b);
      if (d == null) continue;
      hits.push({ metric, base: b, hyp: h, deltaPct: d, higherBetter: false });
    }
  }

  if (
    reasons.some(
      (r) =>
        r.startsWith('load') ||
        r.startsWith('scene failed') ||
        r.startsWith('kernel failed') ||
        r.includes('BODY_COUNT')
    )
  ) {
    return { verdict: 'FAIL', reasons, hits };
  }
  const regress = hits.filter((h) => (h.higherBetter ? h.deltaPct <= -SPEED_PCT : h.deltaPct >= SPEED_PCT));
  const wins = hits.filter((h) => (h.higherBetter ? h.deltaPct >= SPEED_PCT : h.deltaPct <= -SPEED_PCT));
  if (regress.length) return { verdict: 'WORSE', reasons: [...reasons, 'primary ≥3% worse'], hits };
  if (wins.length) return { verdict: 'KEPT', reasons: [...reasons, 'primary ≥3% better, load OK'], hits };
  if (hits.length) return { verdict: 'TIE', reasons: [...reasons, 'within 3%'], hits };
  return { verdict: 'NA', reasons: reasons.length ? reasons : ['no comparable metric'], hits };
}

function productVerdict(rows, gates) {
  if (gates?.node && gates.node !== 'ok' && gates.node !== 'skipped') {
    return { fasterThanMain: false, text: `No. test:node falló (${gates.node}). La velocidad no cuenta.` };
  }
  if (gates?.lockstep && gates.lockstep !== 'ok' && gates.lockstep !== 'skipped') {
    return { fasterThanMain: false, text: `No. Lockstep falló (${gates.lockstep}). La velocidad no cuenta.` };
  }
  const usable = rows.filter((r) => r.decision.verdict !== 'NA');
  const fails = rows.filter((r) => r.decision.verdict === 'FAIL' || r.decision.verdict === 'WORSE');
  const keeps = rows.filter((r) => r.decision.verdict === 'KEPT');
  if (fails.length) {
    return {
      fasterThanMain: false,
      text: `No. ${fails.length} fila(s) FAIL/WORSE. No se afirma mejor WeedJS.`,
    };
  }
  if (!usable.length) {
    return { fasterThanMain: false, text: 'No. No hay filas comparables.' };
  }
  if (keeps.length && !fails.length) {
    return {
      fasterThanMain: true,
      text: `Sí, en las filas medidas: ${keeps.map((r) => r.id).join(', ')} kept y ninguna peor.`,
    };
  }
  return { fasterThanMain: false, text: 'Empate: ninguna fila ≥3% mejor y ninguna peor.' };
}

function describeFeature(feature) {
  if (!feature) return 'Feature sin entrada de catálogo.';
  const bits = [`Módulo caliente: \`${feature.module}\`.`];
  if (feature.kernel) {
    bits.push(
      `Kernel Node: \`${feature.kernel.script}\` (clave ${feature.kernel.opsKey || 'ops/s'}; ${
        feature.kernel.higherBetter === false ? 'menos ms es mejor' : 'más ops/s es mejor'
      }).`
    );
  } else {
    bits.push('No hay kernel Node para esta fila: se mide solo la escena que ejecuta el código.');
  }
  if (feature.scene) {
    bits.push(
      `Escena: \`${feature.scene.path}\` (${feature.scene.exportName}), ${
        feature.scene.kind === 'gameplay' ? 'gameplay headed' : 'stress'
      }, ${feature.scene.headed ? 'ventana visible' : 'headless'}.`
    );
  } else {
    bits.push('No hay escena Chromium: el claim de esta fila es solo de kernel.');
  }
  if (feature.primary?.length) bits.push(`Primarias: ${feature.primary.join(', ')}.`);
  if (feature.load?.length) bits.push(`Claves de carga: ${feature.load.join(', ')}.`);
  return bits.join(' ');
}

function writeFeatureSection(row, payload) {
  const feature = getFeature(row.id);
  const lines = [];
  lines.push(`### ${row.id} — ${row.name || feature?.name || row.id}`);
  lines.push('');
  lines.push(describeFeature(feature));
  lines.push('');
  lines.push(`**Veredicto: ${row.decision.verdict}.**`);
  lines.push('');

  if (row.kernel?.error) {
    lines.push(`El kernel falló: ${row.kernel.error}`);
    lines.push('');
  } else if (row.kernel && (row.kernel.baseOps != null || row.kernel.hypOps != null)) {
    const d = row.kernel.deltaPct;
    const higherBetter = feature?.kernel?.higherBetter !== false;
    lines.push(
      `Kernel: baseline ${Number.isFinite(row.kernel.baseOps) ? row.kernel.baseOps.toFixed(higherBetter ? 0 : 3) : 'n/a'}${
        higherBetter ? ' ops/s' : ' ms'
      }, árbol actual ${Number.isFinite(row.kernel.hypOps) ? row.kernel.hypOps.toFixed(higherBetter ? 0 : 3) : 'n/a'}${
        higherBetter ? ' ops/s' : ' ms'
      } (${fmtDeltaPct(d)}).`
    );
    lines.push('');
  }

  if (row.scene && !row.scene.ok) {
    lines.push(`La escena falló: ${row.scene.error || 'error desconocido'}. Sin números de worker.`);
    lines.push('');
  } else if (row.scene?.base || row.scene?.hyp) {
    const keys = sceneMetricKeys(feature, row.scene);
    lines.push(renderCompareTable(row.scene.base, row.scene.hyp, keys));
    lines.push('');
    if (row.scene.workload?.ok) {
      lines.push('Carga comparable: las claves de esta fila quedaron dentro de ±5% y el cv de cada una fue menor a 50%. El par existe.');
    } else if (row.scene.workload) {
      const drifts = (row.scene.workload.drifts || [])
        .map((d) => (d.reason ? `${d.key}: ${d.reason}` : `${d.key} ${fmtDeltaPct(d.pct)}`))
        .join('; ');
      lines.push(`Carga no comparable. El par no existe. Detalle: ${drifts || 'sin drifts anotados'}.`);
    }
    lines.push('');
  }

  const hits = row.decision.hits || [];
  if (hits.length) {
    lines.push('Por qué el veredicto:');
    lines.push('');
    for (const hit of hits) lines.push(`- ${explainHit(hit)}`);
    lines.push('');
  } else if (row.decision.reasons?.length) {
    lines.push(`Motivo: ${row.decision.reasons.join(' ')}`);
    lines.push('');
  }

  if (payload.args?.smoke) {
    lines.push(
      'Esta fila se midió en smoke (una sola corrida por lado). El cv sale 0% porque no hay serie. Un KEPT o WORSE de smoke es una pantalla, no un claim para mergear.'
    );
    lines.push('');
  }
  if (row.id === 'box2d' && payload.args?.smoke) {
    lines.push(
      'Contexto de la misma campaña: el confirm headed 5-run de Balls (`tests/results/product-confirm/report.md`) midió physics 6.911 → 6.554 ms (−5.2%) con `BODY_COUNT` 9004/9004. Este smoke de 4 s no anula ese confirm: no tocamos el WASM de Box2D; `physics_STEP_MS` es el worker de física de Balls, y n=1 de 4 s se mueve varios por ciento solo por ruido de máquina.'
    );
    lines.push('');
  }
  return lines.join('\n');
}

export function writeReport(payload) {
  const lines = [];
  lines.push('# Scoreboard de features del motor');
  lines.push('');
  lines.push(
    `Hipótesis: el árbol de trabajo actual es más rápido que \`${payload.vs}\` en las filas del catálogo que se midieron.`
  );
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(
    `Se midieron ${payload.rows.length} de ${payload.catalogSize} filas del catálogo: ${payload.rows.map((r) => r.id).join(', ')}.`
  );
  lines.push(
    `Correctness: test:node ${payload.gates?.node ?? 'n/a'}; lockstep balls/liquidfun/lfstress/particles ${payload.gates?.lockstep ?? 'n/a'}. Si alguno falla, la velocidad no cuenta.`
  );
  lines.push(
    `Gameplay headed ${payload.args.runs} × ${payload.args.warmupMs}/${payload.args.durationMs} ms. Stress headless ${payload.args.stressRuns} × ${payload.args.stressWarmupMs}/${payload.args.stressDurationMs} ms.`
  );
  if (payload.args?.headedOnly) {
    lines.push(
      `Esta corrida usó \`--headed-only ${payload.args.headedOnly.join(',')}\`: solo esas filas abren ventana y corren el protocolo de cinco corridas. El resto de escenas (aunque el catálogo marque headed) usan el protocolo de estrés sin ventana.`
    );
  } else if (payload.args.headlessAll) {
    lines.push('Esta corrida usó `--headless`: ninguna escena abre ventana.');
  }
  if (payload.args?.detailedStats) {
    lines.push('Esta corrida pidió `--detailed-stats`: sub-timers (`VISIBILITY_MS`, etc.) encendidos. No es un confirm de producto.');
  }
  lines.push(
    'Stats detalladas apagadas (los contadores de carga sí se publican). Carga comparable si la mediana queda en ±5% y el cv de cada clave es menor a 50%. Velocidad keep si una primaria baja al menos 3% en ms (o el kernel sube 3% en ops/s) y ninguna primaria de la fila empeora 3%.'
  );
  lines.push(
    `Baseline: git \`${payload.vs}\` más el parche de contadores de carga (misma visibilidad, velocidad de ese rev). Tratamiento: árbol de trabajo actual. Snapshot/restore de \`src/\`, no \`git checkout\` sobre un árbol sucio.`
  );
  if (payload.args.smoke) {
    lines.push(
      'Corrida smoke (n=1). Sirve para ver si la plataforma cierra carga y escribe números. No alcanza para afirmar que una feature es más barata o más cara.'
    );
  }
  lines.push('');
  lines.push('## Resumen');
  lines.push('');
  lines.push('| Feature | Veredicto | Primaria | Carga |');
  lines.push('|---------|-----------|----------|-------|');
  for (const row of payload.rows) {
    const hit = (row.decision.hits || [])
      .map((h) => `${h.metric} ${fmtDeltaPct(h.deltaPct)}`)
      .join('; ') || '—';
    const load = row.scene?.workload?.ok ? 'OK' : row.scene?.workload ? 'NO' : '—';
    lines.push(`| ${row.id} | ${row.decision.verdict} | ${hit} | ${load} |`);
  }
  lines.push('');
  lines.push('## Números por feature');
  lines.push('');
  for (const row of payload.rows) {
    lines.push(writeFeatureSection(row, payload));
  }
  lines.push('## Veredicto de producto');
  lines.push('');
  lines.push(payload.product.text);
  lines.push('');
  lines.push('## Qué se aprendió');
  lines.push('');
  lines.push(
    'WORSE no significa “Box2D está roto”. Significa que la primaria de esa fila (en box2d: `physics_STEP_MS` de Balls) fue al menos 3% más cara en esta corrida, con carga comparable. Una tabla de signos no alcanza: el informe tiene que decir qué escena, qué worker, ambos lados en ms, y si n=1 o n=5. Predator artístico no entra. Vis-poly usa `visPolyStressScene` con `raycasted: true`. Combate estable usa `steadyCombatScene`. No se afirma “mejor WeedJS” hasta que todas las filas del catálogo sean KEPT o empate y ninguna WORSE/FAIL.'
  );
  lines.push('');
  const md = lines.join('\n');
  fs.writeFileSync(path.join(outRoot, 'report.md'), md);
  return md;
}

function updateHypothesisLog(payload) {
  const logPath = path.join(repoRoot, 'docs/HYPOTHESIS_LOG.md');
  if (!fs.existsSync(logPath)) return;
  let text = fs.readFileSync(logPath, 'utf8');
  const stamp = new Date().toISOString().slice(0, 10);
  const ids = payload.rows.map((r) => `${r.id}:${r.decision.verdict}`).join(', ');
  const block = `| Scoreboard platform vs \`${payload.vs}\` | Catalog runner can compare every engine feature with load gates. | kept | ${stamp} | Scoreboard ${payload.args.smoke ? 'smoke' : 'full'}; ${payload.rows.length} rows | ${ids}. ${payload.product.text} | Platform shipped. Do not claim best WeedJS unless every catalog row is KEPT or TIE and none WORSE/FAIL. | [\`tests/results/scoreboard/report.md\`](../tests/results/scoreboard/report.md) |\n`;
  const marker = '| Always-on load counts |';
  if (text.includes('| Scoreboard platform vs')) {
    text = text.replace(/\| Scoreboard platform vs[^\n]*\n/, block);
  } else if (text.includes(marker)) {
    text = text.replace(marker, `${block}${marker}`);
  } else {
    text += `\n${block}`;
  }
  fs.writeFileSync(logPath, text);
}

function main() {
  const args = parseMeasureArgs(process.argv.slice(2));
  const features = filterFeatures(args.only);
  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotSrcTree();
  const rows = [];
  const sceneCache = new Map();

  const gates = { node: args.skipNode ? 'skipped' : null, lockstep: args.skipLockstep ? 'skipped' : null };
  try {
    if (!args.skipNode) {
      console.log('\n======== correctness: pnpm test:node ========');
      try {
        runNodeTests();
        gates.node = 'ok';
      } catch (e) {
        gates.node = String(e.message || e);
        console.error('test:node failed; speed rows still run but product cannot be kept.');
      }
    }
    if (!args.skipLockstep) {
      console.log('\n======== correctness: lockstep visual ========');
      try {
        runLockstep();
        gates.lockstep = 'ok';
      } catch (e) {
        gates.lockstep = String(e.message || e);
        console.error('lockstep failed; speed rows still run but product cannot be kept.');
      }
    }

    for (const feature of features) {
      console.log(`\n################ ${feature.id} ################`);
      const row = { id: feature.id, name: feature.name };
      if (!args.skipKernels && feature.kernel) {
        const kdir = path.join(outRoot, feature.id);
        fs.mkdirSync(kdir, { recursive: true });
        try {
          console.log(`kernel BASE ${feature.kernel.script}`);
          applyBaselineRev(args.vs);
          const baseJson = runKernelScript(feature.kernel.script, path.join(kdir, 'kernel-BASE.json'));
          restoreSrcTree(snap);
          console.log(`kernel KEEP ${feature.kernel.script}`);
          const hypJson = runKernelScript(feature.kernel.script, path.join(kdir, 'kernel-KEEP.json'));
          row.kernel = {
            baseOps: pickOpsWithKey(baseJson, feature.kernel.opsKey),
            hypOps: pickOpsWithKey(hypJson, feature.kernel.opsKey),
          };
          row.kernel.deltaPct = pctDelta(row.kernel.hypOps, row.kernel.baseOps);
        } catch (e) {
          restoreSrcTree(snap);
          row.kernel = { error: String(e.message || e) };
        }
      }

      if (!args.skipScenes && feature.scene) {
        const headed = sceneWantsHeaded(feature.scene, args, feature.id);
        const cacheKey = `${feature.scene.key}|${headed ? 1 : 0}|${args.smoke}`;
        if (!sceneCache.has(cacheKey)) {
          const sdir = path.join(outRoot, feature.scene.key);
          fs.mkdirSync(sdir, { recursive: true });
          applyBaselineRev(args.vs);
          const base = measureSceneSide(`${feature.scene.key}-BASE`, feature.scene, args, sdir, feature.id);
          restoreSrcTree(snap);
          const hyp = measureSceneSide(`${feature.scene.key}-KEEP`, feature.scene, args, sdir, feature.id);
          sceneCache.set(cacheKey, {
            ok: base.ok && hyp.ok,
            error: base.ok ? hyp.error : base.error,
            base: base.summary,
            hyp: hyp.summary,
          });
        }
        const cached = sceneCache.get(cacheKey);
        row.scene = {
          ...cached,
          workload:
            cached.ok && cached.base && cached.hyp
              ? workloadOk(cached.base, cached.hyp, feature.load)
              : { ok: false, drifts: [] },
        };
      }

      row.decision = decideRow(feature, row.kernel, row.scene);
      rows.push(row);
      fs.mkdirSync(path.join(outRoot, feature.id), { recursive: true });
      writeJson(path.join(outRoot, feature.id, 'verdict.json'), row);
      console.log(`${feature.id} => ${row.decision.verdict}`);
    }
  } finally {
    restoreSrcTree(snap);
  }

  const payload = {
    vs: args.vs,
    args,
    catalogSize: ENGINE_FEATURES.length,
    rows,
    gates,
    product: productVerdict(rows, gates),
  };
  writeJson(path.join(outRoot, 'summary.json'), payload);
  writeReport(payload);
  updateHypothesisLog(payload);
  console.log('\n======== SCOREBOARD ========');
  console.log(payload.product.text);
  console.log(`Wrote ${path.join(outRoot, 'report.md')}`);
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) main();
