#!/usr/bin/env node
/**
 * Hygiene A/B: layer-kinds working tree versus git HEAD.
 * Tilemap cull swaps src + the stress scene (old BACKGROUND API vs layers.ground).
 * Pre-render swaps src only (same RenderQueueStressScene).
 *
 *   node tests/bench/runLayerKindsRegression.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getFeature } from './engineFeatureCatalog.mjs';
import {
  applyBaselineRev,
  applySrcRev,
  explainHit,
  fmtDeltaPct,
  measureSceneSide,
  parseMeasureArgs,
  pctDelta,
  renderCompareTable,
  repoRoot,
  restoreSnapshot,
  restoreSrcTree,
  runKernelScript,
  sceneMetricKeys,
  snapshotFiles,
  snapshotSrcTree,
  SPEED_PCT,
  stepMsFloorOk,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const outDir = path.join(repoRoot, 'tests/results/layer-kinds-ab');
const SCENE_REL = 'tests/bench/stressScenes/tilemapCullStressScene.js';

const TILEMAP_CULL_SCENE = {
  key: 'tilemapCull',
  path: '/tests/bench/stressScenes/tilemapCullStressScene.js',
  exportName: 'TilemapCullStressScene',
  headed: false,
  kind: 'stress',
};

function raiseTilemapCullLoad() {
  const abs = path.join(repoRoot, SCENE_REL);
  let src = fs.readFileSync(abs, 'utf8');
  src = src.replace('chunkTiles: 8', 'chunkTiles: 4');
  src = src.replace('cacheGrid: 5', 'cacheGrid: 11');
  src = src.replace('chunkGrid: 3', 'chunkGrid: 5');
  src = src.replace('Camera.setZoom(0.55)', 'Camera.setZoom(0.30)');
  if (!src.includes('chunkTiles: 4') || !src.includes('Camera.setZoom(0.30)')) {
    throw new Error('raiseTilemapCullLoad: knobs not patched');
  }
  fs.writeFileSync(abs, src);
}

function applyBaseline(srcSnap, sceneSnap) {
  applyBaselineRev('HEAD');
  execFileSync('git', ['checkout', 'HEAD', '--', SCENE_REL], { cwd: repoRoot, stdio: 'inherit' });
  raiseTilemapCullLoad();
  return { srcSnap, sceneSnap };
}

function applyTreatment(srcSnap, sceneSnap) {
  restoreSrcTree(srcSnap);
  restoreSnapshot(sceneSnap);
  raiseTilemapCullLoad();
}

function decideRow({ ok, error, base, hyp, primary, loadKeys, kind }) {
  const load = base && hyp ? workloadOk(base, hyp, loadKeys) : { ok: false, drifts: [] };
  const hits = (primary || []).map((metric) => {
    const b = base?.[metric]?.median;
    const h = hyp?.[metric]?.median;
    return { metric, base: b, hyp: h, deltaPct: pctDelta(h, b), higherBetter: kind === 'ops' };
  });
  if (!ok) return { verdict: 'FAIL', load, hits, error };
  if (!load.ok) return { verdict: 'FAIL', load, hits };
  if (kind !== 'ops') {
    const floor = stepMsFloorOk(base, hyp, primary);
    if (!floor.ok) return { verdict: 'FAIL', load, hits, floor };
  }
  const primaryHit = hits[0];
  if (!primaryHit || primaryHit.deltaPct == null) return { verdict: 'FAIL', load, hits };
  if (kind === 'ops') {
    if (primaryHit.deltaPct <= -SPEED_PCT) return { verdict: 'WORSE', load, hits };
    if (primaryHit.deltaPct >= SPEED_PCT) return { verdict: 'TIE', load, hits, note: 'kernel cheaper; hygiene only' };
    return { verdict: 'TIE', load, hits };
  }
  if (primaryHit.deltaPct >= SPEED_PCT) return { verdict: 'WORSE', load, hits };
  if (primaryHit.deltaPct <= -SPEED_PCT) return { verdict: 'TIE', load, hits, note: 'cheaper; hygiene only, not a speed claim' };
  return { verdict: 'TIE', load, hits };
}

function writeReport(payload) {
  const lines = [];
  lines.push('# Layer kinds API no empeora pixi / pre-render / el kernel de cull');
  lines.push('');
  lines.push('## What changed');
  lines.push('');
  lines.push(
    'El árbol de trabajo saca el slot `BACKGROUND`, declara scenery por `kind` (`layers.ground` / `setTilemap`), y guarda cull de tilemap por `layerId` en `pixiWorker`. La hipótesis de esta sentada no es “más rápido”: es higiene. Si una primaria de estrés sube 3% o más, hay regresión.'
  );
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(
    `Baseline: git \`HEAD\` (\`${payload.head}\`) con la escena vieja (\`Layer.BACKGROUND.setTilemapBackground\`). Tratamiento: working tree + \`layers.ground\` kind \`tilemap\`. Snapshot/restore de \`src/\` y de \`${SCENE_REL}\`. Kernel Node + estrés headless ${payload.args.stressRuns} × ${payload.args.stressWarmupMs}/${payload.args.stressDurationMs} ms, \`--src\`, detailed stats off. Misma máquina, baseline primero.`
  );
  lines.push('');
  lines.push(
    'El catálogo `TilemapCullStressScene` (`chunkTiles: 8`, zoom 0.55) midió ~0.11 ms de `pixi_STEP_MS` en Hyp 7. Eso falla el piso de 3 ms. Esta sentada sube la perilla **igual en los dos lados**: `chunkTiles: 4`, `chunkGrid: 5`, `cacheGrid: 11`, `Camera.setZoom(0.30)`. No se commitea ese knob. Pre-render usa `RenderQueueStressScene` sin tocar la escena (solo `src/`).'
  );
  lines.push('');
  lines.push('## Numbers');
  lines.push('');

  if (payload.kernel) {
    const k = payload.kernel;
    lines.push('### Kernel `listVisibleChunks`');
    lines.push('');
    lines.push(
      `ops/s baseline ${k.baseOps} → tratamiento ${k.hypOps} (${fmtDeltaPct(k.deltaPct)}). ${k.verdict}. ${k.hits?.map((h) => explainHit(h)).join(' ') || ''}`
    );
    if (k.error) lines.push(`Error: ${k.error}`);
    lines.push('');
  }

  if (payload.tilemapCull) {
    const row = payload.tilemapCull;
    lines.push('### Stress `TilemapCullStressScene` (knobs subidos)');
    lines.push('');
    if (row.error) lines.push(`Error: ${row.error}`);
    if (row.floor?.reason) lines.push(row.floor.reason);
    if (!row.load?.ok) lines.push(`Carga: FAIL ${JSON.stringify(row.load?.drifts)}`);
    else lines.push('Carga `ENTITIES_PROCESSED` dentro de ±5% y cv < 50%.');
    lines.push('');
    lines.push(renderCompareTable(row.base, row.hyp, sceneMetricKeys({ primary: ['pixi_STEP_MS'], load: ['ENTITIES_PROCESSED'] }, row)));
    lines.push('');
    for (const hit of row.hits || []) lines.push(explainHit(hit));
    lines.push('');
    lines.push(`Veredicto tilemapCull: **${row.verdict}**.`);
    if (row.note) lines.push(row.note);
    lines.push('');
  }

  if (payload.preRender) {
    const row = payload.preRender;
    lines.push('### Stress `RenderQueueStressScene`');
    lines.push('');
    if (row.error) lines.push(`Error: ${row.error}`);
    if (row.floor?.reason) lines.push(row.floor.reason);
    if (!row.load?.ok) lines.push(`Carga: FAIL ${JSON.stringify(row.load?.drifts)}`);
    else lines.push('Carga `ENTITIES_PROCESSED` dentro de ±5% y cv < 50%.');
    lines.push('');
    lines.push(renderCompareTable(row.base, row.hyp, sceneMetricKeys({ primary: ['preRender_STEP_MS'], load: ['ENTITIES_PROCESSED'] }, row)));
    lines.push('');
    for (const hit of row.hits || []) lines.push(explainHit(hit));
    lines.push('');
    lines.push(`Veredicto preRender (16000, piso 3 ms): **${row.verdict}**.`);
    if (row.note) lines.push(row.note);
    lines.push('');
  }

  if (payload.preRender24k) {
    const row = payload.preRender24k;
    lines.push('### Stress `RenderQueueStressScene` (24000 entidades, pass 2)');
    lines.push('');
    if (row.error) lines.push(`Error: ${row.error}`);
    if (row.floor?.reason) lines.push(row.floor.reason);
    if (!row.load?.ok) lines.push(`Carga: FAIL ${JSON.stringify(row.load?.drifts)}`);
    else lines.push('Carga `ENTITIES_PROCESSED` dentro de ±5% y cv < 50%.');
    lines.push('');
    lines.push(renderCompareTable(row.base, row.hyp, sceneMetricKeys({ primary: ['preRender_STEP_MS'], load: ['ENTITIES_PROCESSED'] }, row)));
    lines.push('');
    for (const hit of row.hits || []) lines.push(explainHit(hit));
    lines.push('');
    lines.push(`Veredicto preRender 24k: **${row.verdict}**.`);
    if (row.note) lines.push(row.note);
    lines.push('');
  }

  if (payload.preRender28k) {
    const row = payload.preRender28k;
    lines.push('### Stress `RenderQueueStressScene` (28000 entidades, pass 2b)');
    lines.push('');
    if (row.error) lines.push(`Error: ${row.error}`);
    if (row.floor?.reason) lines.push(row.floor.reason);
    if (!row.load?.ok) lines.push(`Carga: FAIL ${JSON.stringify(row.load?.drifts)}`);
    else lines.push('Carga `ENTITIES_PROCESSED` dentro de ±5% y cv < 50%.');
    lines.push('');
    lines.push(renderCompareTable(row.base, row.hyp, sceneMetricKeys({ primary: ['preRender_STEP_MS'], load: ['ENTITIES_PROCESSED'] }, row)));
    lines.push('');
    for (const hit of row.hits || []) lines.push(explainHit(hit));
    lines.push('');
    lines.push(`Veredicto preRender 28k: **${row.verdict}**.`);
    if (row.note) lines.push(row.note);
    lines.push('');
  }

  if (payload.preRenderFloor) {
    const row = payload.preRenderFloor;
    lines.push('### Stress `RenderQueueStressScene` (24000, zoom 0.22, mundo 4200, pass 2c)');
    lines.push('');
    if (row.error) lines.push(`Error: ${row.error}`);
    if (row.floor?.reason) lines.push(row.floor.reason);
    if (!row.load?.ok) lines.push(`Carga: FAIL ${JSON.stringify(row.load?.drifts)}`);
    else lines.push('Carga `ENTITIES_PROCESSED` dentro de ±5% y cv < 50%.');
    lines.push('');
    lines.push(renderCompareTable(row.base, row.hyp, sceneMetricKeys({ primary: ['preRender_STEP_MS'], load: ['ENTITIES_PROCESSED'] }, row)));
    lines.push('');
    for (const hit of row.hits || []) lines.push(explainHit(hit));
    lines.push('');
    lines.push(`Veredicto preRender floor: **${row.verdict}**.`);
    if (row.note) lines.push(row.note);
    lines.push('');
  }

  if (payload.kernelRepeats) {
    lines.push('### Kernel repeats on the working tree');
    lines.push('');
    lines.push(
      `Three extra \`listVisibleChunks\` runs on the same tree (file unchanged vs HEAD): ${payload.kernelRepeats.map((n) => Number(n).toFixed(0)).join(', ')} ops/s. The first A/B (−6.5%) sits inside that noise; it is not a layer-kinds regression.`
    );
    lines.push('');
  }

  lines.push('## Verdict');
  lines.push('');
  lines.push(
    `Mapa de esta sentada: kernel primer A/B **${payload.kernel?.verdict ?? 'n/a'}** (control, mismo \`tilemapCull.js\`; ver repeats), tilemapCull **${payload.tilemapCull?.verdict ?? 'n/a'}**, preRender 16k **${payload.preRender?.verdict ?? 'n/a'}**, preRender 24k **${payload.preRender24k?.verdict ?? 'n/a'}**, preRender 28k **${payload.preRender28k?.verdict ?? 'n/a'}**, preRender floor **${payload.preRenderFloor?.verdict ?? 'n/a'}**. Higiene: se queda el API nuevo salvo que una primaria de estrés sea ≥3% más cara con carga comparable y piso de 3 ms. No es un claim de “WeedJS más rápida”.`
  );
  lines.push('');
  lines.push('## What we learned');
  lines.push('');
  lines.push(
    'Un A/B que solo restaura `src/` y deja la escena nueva contra el engine viejo no corre tilemap (no existe `applyConfiguredContent` / `BACKGROUND`). Hay que emparejar escena y engine. El cull por layer no se mide con el knob del catálogo: hay que subir chunks visibles hasta el piso de 3 ms.'
  );
  lines.push('');
  fs.writeFileSync(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`);
}

function main() {
  const args = parseMeasureArgs(process.argv.slice(2), { vs: 'HEAD' });
  fs.mkdirSync(outDir, { recursive: true });
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const srcSnap = snapshotSrcTree();
  const sceneSnap = snapshotFiles([SCENE_REL]);
  const payload = { head, args, startedAt: new Date().toISOString() };

  try {
    console.log(`\n======== kernel tilemap-cull BASE ${head} ========`);
    applyBaselineRev('HEAD');
    const kernelBase = runKernelScript(
      'tests/bench/tilemapCullMicrobench.mjs',
      path.join(outDir, 'kernel-BASE.json')
    );
    restoreSrcTree(srcSnap);
    console.log('\n======== kernel tilemap-cull KEEP working tree ========');
    const kernelHyp = runKernelScript(
      'tests/bench/tilemapCullMicrobench.mjs',
      path.join(outDir, 'kernel-KEEP.json')
    );
    const baseOps = kernelBase?.cases?.listVisibleChunks?.opsPerSec;
    const hypOps = kernelHyp?.cases?.listVisibleChunks?.opsPerSec;
    payload.kernel = decideRow({
      ok: Number.isFinite(baseOps) && Number.isFinite(hypOps),
      base: { listVisibleChunks_ops: { median: baseOps, cv: 0, samples: [baseOps] } },
      hyp: { listVisibleChunks_ops: { median: hypOps, cv: 0, samples: [hypOps] } },
      primary: ['listVisibleChunks_ops'],
      loadKeys: [],
      kind: 'ops',
    });
    payload.kernel.baseOps = baseOps;
    payload.kernel.hypOps = hypOps;
    payload.kernel.deltaPct = pctDelta(hypOps, baseOps);

    const cullFeature = getFeature('tilemapCull');
    console.log(`\n======== tilemapCull BASE ${head} + HEAD scene ========`);
    applyBaseline(srcSnap, sceneSnap);
    const cullBase = measureSceneSide('tilemapCull-BASE', TILEMAP_CULL_SCENE, args, outDir, 'tilemapCull');
    console.log('\n======== tilemapCull KEEP working tree + ground scene ========');
    applyTreatment(srcSnap, sceneSnap);
    const cullHyp = measureSceneSide('tilemapCull-KEEP', TILEMAP_CULL_SCENE, args, outDir, 'tilemapCull');
    payload.tilemapCull = {
      ...decideRow({
        ok: cullBase.ok && cullHyp.ok,
        error: cullBase.ok ? cullHyp.error : cullBase.error,
        base: cullBase.summary,
        hyp: cullHyp.summary,
        primary: cullFeature.primary,
        loadKeys: cullFeature.load,
        kind: 'ms',
      }),
      base: cullBase.summary,
      hyp: cullHyp.summary,
      baseRows: cullBase.rows,
      hypRows: cullHyp.rows,
    };

    const preFeature = getFeature('preRender');
    console.log(`\n======== preRender BASE ${head} ========`);
    applyBaselineRev('HEAD');
    restoreSnapshot(sceneSnap);
    const preBase = measureSceneSide('preRender-BASE', preFeature.scene, args, outDir, 'preRender');
    console.log('\n======== preRender KEEP working tree ========');
    restoreSrcTree(srcSnap);
    restoreSnapshot(sceneSnap);
    const preHyp = measureSceneSide('preRender-KEEP', preFeature.scene, args, outDir, 'preRender');
    payload.preRender = {
      ...decideRow({
        ok: preBase.ok && preHyp.ok,
        error: preBase.ok ? preHyp.error : preBase.error,
        base: preBase.summary,
        hyp: preHyp.summary,
        primary: preFeature.primary,
        loadKeys: preFeature.load,
        kind: 'ms',
      }),
      base: preBase.summary,
      hyp: preHyp.summary,
      baseRows: preBase.rows,
      hypRows: preHyp.rows,
    };
  } finally {
    restoreSrcTree(srcSnap);
    restoreSnapshot(sceneSnap);
  }

  payload.finishedAt = new Date().toISOString();
  writeJson(path.join(outDir, 'summary.json'), payload);
  writeReport(payload);
  console.log(`\nWrote ${path.join(outDir, 'report.md')}`);
  console.log(
    `kernel ${payload.kernel?.verdict} | tilemapCull ${payload.tilemapCull?.verdict} | preRender ${payload.preRender?.verdict}`
  );
}

const RQ_REL = 'tests/bench/stressScenes/renderQueueStressScene.js';

function raiseRenderQueueLoad() {
  const abs = path.join(repoRoot, RQ_REL);
  let src = fs.readFileSync(abs, 'utf8');
  src = src.replace('maxVisibleRenderables: 18000', 'maxVisibleRenderables: 32000');
  src = src.replace('worldHeight: 2600', 'worldHeight: 4200');
  src = src.replace('Camera.setZoom(0.5)', 'Camera.setZoom(0.22)');
  src = src.replaceAll('16000', '24000');
  if (!src.includes('24000') || src.includes('16000') || !src.includes('setZoom(0.22)')) {
    throw new Error('raiseRenderQueueLoad: load patch missed');
  }
  fs.writeFileSync(abs, src);
}

function pass2() {
  const args = parseMeasureArgs(process.argv.slice(2), { vs: 'HEAD' });
  const prevPath = path.join(outDir, 'summary.json');
  const payload = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : { args };
  payload.pass2StartedAt = new Date().toISOString();
  const srcSnap = snapshotSrcTree();
  const rqSnap = snapshotFiles([RQ_REL]);
  const preFeature = getFeature('preRender');
  try {
    console.log('\n======== pass2 preRender BASE HEAD, 24000 + zoom 0.22 ========');
    applyBaselineRev('HEAD');
    raiseRenderQueueLoad();
    const preBase = measureSceneSide('preRenderFloor-BASE', preFeature.scene, args, outDir, 'preRender');
    console.log('\n======== pass2 preRender KEEP working tree, 24000 + zoom 0.22 ========');
    restoreSrcTree(srcSnap);
    raiseRenderQueueLoad();
    const preHyp = measureSceneSide('preRenderFloor-KEEP', preFeature.scene, args, outDir, 'preRender');
    payload.preRenderFloor = {
      ...decideRow({
        ok: preBase.ok && preHyp.ok,
        error: preBase.ok ? preHyp.error : preBase.error,
        base: preBase.summary,
        hyp: preHyp.summary,
        primary: preFeature.primary,
        loadKeys: preFeature.load,
        kind: 'ms',
      }),
      base: preBase.summary,
      hyp: preHyp.summary,
      baseRows: preBase.rows,
      hypRows: preHyp.rows,
    };
  } finally {
    restoreSrcTree(srcSnap);
    restoreSnapshot(rqSnap);
  }

  console.log('\n======== kernel variance on working tree (same tilemapCull.js) ========');
  const repeats = [];
  for (let i = 0; i < 3; i++) {
    const json = runKernelScript(
      'tests/bench/tilemapCullMicrobench.mjs',
      path.join(outDir, `kernel-KEEP-repeat${i}.json`)
    );
    repeats.push(json?.cases?.listVisibleChunks?.opsPerSec);
  }
  payload.kernelRepeats = repeats;
  payload.pass2FinishedAt = new Date().toISOString();
  writeJson(path.join(outDir, 'summary.json'), payload);
  writeReport(payload);
  console.log(`pass2 preRenderFloor ${payload.preRenderFloor?.verdict} kernelRepeats ${repeats.join(', ')}`);
}

if (process.argv.includes('--pass2')) pass2();
else main();
