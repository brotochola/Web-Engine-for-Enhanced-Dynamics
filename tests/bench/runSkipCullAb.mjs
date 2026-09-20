#!/usr/bin/env node
/**
 * skipCull isolation: three controls, one variable each.
 *
 *   node tests/bench/runSkipCullAb.mjs
 *   node tests/bench/runSkipCullAb.mjs --vs HEAD --only hygiene
 *   node tests/bench/runSkipCullAb.mjs --only allOnScreen,highReject --smoke
 *
 * Control 0: src HEAD vs working tree, skipCull stays false (Balls, steadyCombat, RenderQueue).
 * Control 1: same tree, bunny C 65k, skipCull off vs on. Detailed stats on.
 * Control 2: same tree, RenderQueue zoom 3, skipCull off vs on. Queue size is the treatment.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SPEED_PCT,
  applyBaselineRev,
  explainHit,
  fmtDeltaPct,
  fmtStat,
  measureSceneSide,
  metricKind,
  parseMeasureArgs,
  pctDelta,
  renderCompareTable,
  repoRoot,
  restoreSrcTree,
  sceneMetricKeys,
  snapshotSrcTree,
  stepMsFloorOk,
  usesStressStepFloor,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const outRoot = path.join(repoRoot, 'tests/results/skip-cull');
const CAMPAIGN_MS_FLOOR = 8;

const HYGIENE = [
  {
    id: 'balls',
    name: 'Balls',
    scene: {
      key: 'balls',
      path: '/demos/ballsScene/ballsScene.js',
      exportName: 'BallsScene',
      headed: true,
      kind: 'gameplay',
    },
    primary: ['physics_STEP_MS', 'preRender_STEP_MS', 'pixi_STEP_MS'],
    load: ['BODY_COUNT'],
  },
  {
    id: 'steadyCombat',
    name: 'Steady combat',
    scene: {
      key: 'steadyCombat',
      path: '/tests/bench/stressScenes/steadyCombatScene.js',
      exportName: 'SteadyCombatScene',
      headed: true,
      kind: 'gameplay',
    },
    primary: ['particle_STEP_MS', 'spatialMax_STEP_MS', 'logic0_STEP_MS', 'preRender_STEP_MS'],
    load: ['BODY_COUNT', 'ACTIVE_PARTICLES'],
  },
  {
    id: 'renderQueue',
    name: 'RenderQueue catalog',
    scene: {
      key: 'renderQueue',
      path: '/tests/bench/stressScenes/renderQueueStressScene.js',
      exportName: 'RenderQueueStressScene',
      headed: false,
      kind: 'stress',
    },
    primary: ['preRender_STEP_MS'],
    load: ['ENTITIES_PROCESSED'],
  },
];

const ALL_ON_SCREEN = {
  id: 'allOnScreen',
  name: 'Bunny C 65k, todos en cámara',
  baseScene: {
    key: 'bunnyCSkipOff',
    path: '/tests/bench/stressScenes/bunnyMarkStressScene.js',
    exportName: 'BunnyMarkStressCSkipCullOffScene',
    headed: false,
    kind: 'stress',
  },
  hypScene: {
    key: 'bunnyCSkipOn',
    path: '/tests/bench/stressScenes/bunnyMarkStressScene.js',
    exportName: 'BunnyMarkStressCSkipCullOnScene',
    headed: false,
    kind: 'stress',
  },
  primary: ['preRender_STEP_MS'],
  load: ['MARK_ACTIVE', 'RENDER_QUEUE_SIZE'],
};

const HIGH_REJECT = {
  id: 'highReject',
  name: 'RenderQueue zoom 3',
  baseScene: {
    key: 'rqRejectOff',
    path: '/tests/bench/stressScenes/renderQueueStressScene.js',
    exportName: 'RenderQueueHighRejectStressScene',
    headed: false,
    kind: 'stress',
  },
  hypScene: {
    key: 'rqRejectOn',
    path: '/tests/bench/stressScenes/renderQueueStressScene.js',
    exportName: 'RenderQueueHighRejectSkipCullScene',
    headed: false,
    kind: 'stress',
  },
  primary: ['preRender_STEP_MS', 'pixi_STEP_MS'],
  load: ['ENTITIES_PROCESSED'],
};

function parseArgv(argv) {
  const out = parseMeasureArgs(argv, { vs: 'HEAD' });
  out.only = out.only || null;
  return out;
}

function hygieneDecide(feature, scenePair) {
  const reasons = [];
  if (scenePair && !scenePair.ok) reasons.push(`scene failed: ${scenePair.error || 'unknown'}`);
  if (scenePair?.workload && !scenePair.workload.ok) {
    reasons.push(
      `load not comparable: ${scenePair.workload.drifts
        .map((d) => (d.reason ? `${d.key} ${d.reason}` : `${d.key} ${d.pct?.toFixed?.(1)}%`))
        .join(', ')}`
    );
  }
  if (usesStressStepFloor(feature.scene) && scenePair?.ok && scenePair.base && scenePair.hyp) {
    const floor = stepMsFloorOk(scenePair.base, scenePair.hyp, feature.primary);
    if (!floor.ok) reasons.push(floor.reason);
  }

  const hits = [];
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
        r.startsWith('step floor:')
    )
  ) {
    return { verdict: 'FAIL', reasons, hits };
  }
  const regress = hits.filter((h) => h.deltaPct >= SPEED_PCT);
  const wins = hits.filter((h) => h.deltaPct <= -SPEED_PCT);
  if (regress.length) return { verdict: 'WORSE', reasons: [...reasons, 'primary ≥3% worse'], hits };
  if (wins.length) return { verdict: 'KEPT', reasons: [...reasons, 'primary ≥3% better, load OK'], hits };
  if (hits.length) return { verdict: 'TIE', reasons: [...reasons, 'within 3%'], hits };
  return { verdict: 'NA', reasons: reasons.length ? reasons : ['no comparable metric'], hits };
}

function campaignFloor(baseSum, hypSum, keys) {
  const hits = [];
  for (const key of keys) {
    const b = baseSum?.[key]?.median;
    const h = hypSum?.[key]?.median;
    if (Number.isFinite(b) && b < CAMPAIGN_MS_FLOOR) hits.push({ side: 'baseline', key, median: b });
    if (Number.isFinite(h) && h < CAMPAIGN_MS_FLOOR) hits.push({ side: 'hyp', key, median: h });
  }
  return {
    ok: hits.length === 0,
    hits,
    reason: hits.length
      ? `campaign floor: primaria bajo ${CAMPAIGN_MS_FLOOR} ms (${hits
          .map((h) => `${h.side} ${h.key}=${h.median.toFixed(3)}`)
          .join('; ')}). FAIL / sin señal de velocidad.`
      : '',
  };
}

function sameTreeDecide(feature, scenePair, { treatQueueAsLoad }) {
  const reasons = [];
  if (!scenePair.ok) return { verdict: 'FAIL', reasons: [`scene failed: ${scenePair.error || 'unknown'}`], hits: [] };
  if (scenePair.workload && !scenePair.workload.ok) {
    reasons.push(
      `load not comparable: ${scenePair.workload.drifts
        .map((d) => (d.reason ? `${d.key} ${d.reason}` : `${d.key} ${d.pct?.toFixed?.(1)}%`))
        .join(', ')}`
    );
  }
  const harness = stepMsFloorOk(scenePair.base, scenePair.hyp, feature.primary);
  if (!harness.ok) reasons.push(harness.reason);
  const camp = campaignFloor(scenePair.base, scenePair.hyp, ['preRender_STEP_MS']);
  if (!camp.ok) reasons.push(camp.reason);

  const hits = [];
  for (const metric of feature.primary) {
    const b = scenePair.base[metric]?.median;
    const h = scenePair.hyp[metric]?.median;
    const d = pctDelta(h, b);
    if (d == null) continue;
    hits.push({ metric, base: b, hyp: h, deltaPct: d, higherBetter: false });
  }

  if (!treatQueueAsLoad) {
    const bq = scenePair.base.RENDER_QUEUE_SIZE?.median;
    const hq = scenePair.hyp.RENDER_QUEUE_SIZE?.median;
    const qd = pctDelta(hq, bq);
    if (qd != null) {
      hits.push({ metric: 'RENDER_QUEUE_SIZE', base: bq, hyp: hq, deltaPct: qd, higherBetter: false });
    }
    if (reasons.some((r) => r.startsWith('scene failed'))) {
      return { verdict: 'FAIL', reasons, hits };
    }
    const pre = hits.find((h) => h.metric === 'preRender_STEP_MS');
    const pixi = hits.find((h) => h.metric === 'pixi_STEP_MS');
    const queueGrew = qd != null && qd >= SPEED_PCT;
    const costUp =
      (pre && pre.deltaPct >= SPEED_PCT) || (pixi && pixi.deltaPct >= SPEED_PCT);
    if (queueGrew && costUp) {
      return {
        verdict: 'CULL_PAYS',
        reasons: [...reasons, 'skipCull agranda la cola y encarece pre-render o pixi. No default true.'],
        hits,
      };
    }
    if (harness.ok === false || camp.ok === false) return { verdict: 'FAIL', reasons, hits };
    return { verdict: 'OBSERVED', reasons: [...reasons, 'par de reject: la cola distinta es el tratamiento'], hits };
  }

  if (
    reasons.some(
      (r) =>
        r.startsWith('load') ||
        r.startsWith('scene failed') ||
        r.startsWith('step floor:') ||
        r.startsWith('campaign floor:')
    )
  ) {
    return { verdict: 'FAIL', reasons, hits };
  }
  const pre = hits.find((h) => h.metric === 'preRender_STEP_MS');
  if (!pre) return { verdict: 'NA', reasons: [...reasons, 'sin preRender_STEP_MS'], hits };
  if (pre.deltaPct <= -SPEED_PCT) {
    return { verdict: 'KEPT', reasons: [...reasons, 'skipCull ≥3% más barato, cola igual'], hits };
  }
  if (pre.deltaPct >= SPEED_PCT) {
    return { verdict: 'WORSE', reasons: [...reasons, 'skipCull ≥3% más caro con cola igual'], hits };
  }
  return { verdict: 'TIE', reasons: [...reasons, 'cull no era el costo (dentro de 3%)'], hits };
}

function pairFromSides(base, hyp, loadKeys, gateLoad) {
  return {
    ok: Boolean(base.ok && hyp.ok),
    error: base.ok ? hyp.error : base.error,
    base: base.summary,
    hyp: hyp.summary,
    workload:
      gateLoad && base.ok && hyp.ok && base.summary && hyp.summary
        ? workloadOk(base.summary, hyp.summary, loadKeys)
        : { ok: true, drifts: [] },
    headed: base.headed,
    runs: base.runs,
    warmupMs: base.warmupMs,
    durationMs: base.durationMs,
  };
}

function writeRowSection(lines, row) {
  lines.push(`### ${row.id} — ${row.name}`);
  lines.push('');
  const sceneLabel = row.scene
    ? `\`${row.scene.path}\` (${row.scene.exportName})`
    : `\`${row.baseScene.exportName}\` vs \`${row.hypScene.exportName}\``;
  lines.push(
    `Escena ${sceneLabel}. Primarias: ${row.primary.join(', ')}. Carga: ${row.load.join(', ')}.`
  );
  lines.push('');
  lines.push(`**Veredicto: ${row.decision.verdict}.**`);
  lines.push('');
  if (!row.scenePair?.ok) {
    lines.push(`La escena falló: ${row.scenePair?.error || 'error desconocido'}.`);
    lines.push('');
    return;
  }
  const keys = sceneMetricKeys(row, row.scenePair);
  lines.push(renderCompareTable(row.scenePair.base, row.scenePair.hyp, keys));
  lines.push('');
  if (row.scenePair.workload?.ok) {
    lines.push('Carga comparable: ±5% y cv < 50%. El par existe.');
  } else if (row.scenePair.workload) {
    const drifts = (row.scenePair.workload.drifts || [])
      .map((d) => (d.reason ? `${d.key}: ${d.reason}` : `${d.key} ${fmtDeltaPct(d.pct)}`))
      .join('; ');
    lines.push(`Carga no comparable. El par no existe. Detalle: ${drifts || 'sin drifts'}.`);
  }
  lines.push('');
  if (row.decision.reasons?.length) {
    lines.push(`Motivo: ${row.decision.reasons.join(' ')}`);
    lines.push('');
  }
  for (const hit of row.decision.hits || []) lines.push(`- ${explainHit(hit)}`);
  if (row.decision.hits?.length) lines.push('');
}

function writeReport(payload) {
  const reportPath = path.join(outRoot, 'report.md');
  const lines = [];
  lines.push('# skipCull: ¿el AABB de cámara cuesta más que no hacerlo?');
  lines.push('');
  lines.push(
    'Hipótesis: `preRender.skipCull` (default false) no empeora las escenas que no lo prenden. Cuando todo el mundo cabe en cámara, saltar el AABB es ≥3% más barato en `preRender_STEP_MS` con la misma cola. Cuando el cull sí recorta, skipCull agranda `RENDER_QUEUE_SIZE` y no puede ser el default.'
  );
  lines.push('');
  lines.push('## What changed');
  lines.push('');
  lines.push(
    'Flag `preRender.skipCull` en `PRE_RENDER_DEFAULTS` (false). Rama por frame en `collectVisibleEntities` / adobe. Bunny playable lo prende. El emit default no cambió. `poseSkip` sigue dropped.'
  );
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(
    `Git: control 0 intercambia \`src/\` (\`${payload.vs}\` vs árbol de trabajo). Controles 1 y 2 usan el mismo árbol y solo cambian el flag. Gameplay headed ${payload.args.runs} × ${payload.args.warmupMs}/${payload.args.durationMs} ms, stats de producto off. Estrés headless ${payload.args.stressRuns} × ${payload.args.stressWarmupMs}/${payload.args.stressDurationMs} ms. Controles 1 y 2 con \`collectDetailedStats\` on (COLLECT_MS, EMIT_MS, cola). Piso de harness 3 ms; piso de campaña 8 ms en la primaria de pre-render.`
  );
  lines.push('');
  lines.push('## Numbers');
  lines.push('');
  lines.push('### Control 0 — higiene, flag off');
  lines.push('');
  for (const row of payload.hygiene) writeRowSection(lines, row);
  lines.push('### Control 1 — todos en cámara');
  lines.push('');
  if (payload.allOnScreen) writeRowSection(lines, payload.allOnScreen);
  else lines.push('No se corrió.');
  lines.push('');
  lines.push('### Control 2 — muchos off-screen');
  lines.push('');
  if (payload.highReject) writeRowSection(lines, payload.highReject);
  else lines.push('No se corrió.');
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(payload.summary);
  lines.push('');
  lines.push('## What we learned');
  lines.push('');
  lines.push(payload.learned);
  lines.push('');
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
  return reportPath;
}

function summarize(payload) {
  const hy = payload.hygiene || [];
  const fails = hy.filter((r) => r.decision.verdict === 'FAIL' || r.decision.verdict === 'WORSE');
  const bits = [];
  if (hy.length) {
    bits.push(
      `Higiene: ${hy.map((r) => `${r.id}=${r.decision.verdict}`).join(', ')}.`
    );
  }
  if (payload.allOnScreen) bits.push(`Todos en cámara: ${payload.allOnScreen.decision.verdict}.`);
  if (payload.highReject) bits.push(`High reject: ${payload.highReject.decision.verdict}.`);
  if (fails.some((r) => r.id === 'balls' || r.id === 'steadyCombat')) {
    bits.push('No mergear: Balls o steadyCombat empeoraron o el par no existe.');
  }
  return bits.join(' ') || 'Sin filas.';
}

function learnedText(payload) {
  const c1 = payload.allOnScreen;
  const c2 = payload.highReject;
  const emit = c1?.scenePair?.base?.EMIT_MS?.median;
  const collect = c1?.scenePair?.base?.COLLECT_MS?.median;
  const step = c1?.scenePair?.base?.preRender_STEP_MS?.median;
  const parts = [];
  if (Number.isFinite(emit) && Number.isFinite(step) && step > 0 && emit / step > 0.5) {
    parts.push(
      `En bunny 65k, EMIT_MS (${emit.toFixed(3)} ms) es la mayor parte de STEP_MS (${step.toFixed(3)} ms). El cull no es el techo.`
    );
  } else if (Number.isFinite(collect) && Number.isFinite(step)) {
    parts.push(
      `Collect ${collect.toFixed(3)} ms / step ${step?.toFixed?.(3)} ms. Ver si el AABB era el costo.`
    );
  }
  if (c2?.decision.verdict === 'CULL_PAYS') {
    parts.push('Con zoom alto skipCull agranda la cola: el AABB paga cuando hay reject. Default sigue false.');
  }
  parts.push('Buffer persistente / solo pose queda para otra sentada. No se mezcló fast-path de emit.');
  return parts.join(' ');
}

function logPair(id, scenePair, keys) {
  if (!scenePair.ok) {
    console.log(`${id} FAIL ${scenePair.error}`);
    return;
  }
  for (const key of keys) {
    const b = scenePair.base[key];
    const h = scenePair.hyp[key];
    const d = pctDelta(h?.median, b?.median);
    console.log(`  ${key}: ${fmtStat(b, metricKind(key))} -> ${fmtStat(h, metricKind(key))} (${fmtDeltaPct(d)})`);
  }
}

function measureHygiene(args, snap) {
  const rows = [];
  const hygieneArgs = { ...args, detailedStats: false };
  for (const feature of HYGIENE) {
    console.log(`\n################ hygiene ${feature.id} ################`);
    const sdir = path.join(outRoot, 'hygiene', feature.scene.key);
    fs.mkdirSync(sdir, { recursive: true });

    console.log(`\n======== ${feature.id} BASE ${args.vs} ========`);
    applyBaselineRev(args.vs);
    const base = measureSceneSide(`${feature.scene.key}-BASE`, feature.scene, hygieneArgs, sdir, feature.id);
    restoreSrcTree(snap);

    console.log(`\n======== ${feature.id} KEEP working tree ========`);
    const hyp = measureSceneSide(`${feature.scene.key}-KEEP`, feature.scene, hygieneArgs, sdir, feature.id);

    const scenePair = pairFromSides(base, hyp, feature.load, true);
    const row = { ...feature, scenePair, decision: hygieneDecide(feature, scenePair) };
    rows.push(row);
    writeJson(path.join(outRoot, 'hygiene', feature.id, 'verdict.json'), row);
    console.log(`${feature.id} => ${row.decision.verdict}`);
    logPair(feature.id, scenePair, [...feature.load, ...feature.primary]);
  }
  return rows;
}

function measureSameTree(spec, args, treatQueueAsLoad) {
  console.log(`\n################ ${spec.id} ################`);
  const sdir = path.join(outRoot, spec.id);
  fs.mkdirSync(sdir, { recursive: true });
  const detailArgs = { ...args, detailedStats: true };

  console.log(`\n======== ${spec.id} BASE skipCull false ========`);
  const base = measureSceneSide(`${spec.id}-BASE`, spec.baseScene, detailArgs, sdir, spec.id);
  console.log(`\n======== ${spec.id} HYP skipCull true ========`);
  const hyp = measureSceneSide(`${spec.id}-HYP`, spec.hypScene, detailArgs, sdir, spec.id);

  const scenePair = pairFromSides(base, hyp, spec.load, treatQueueAsLoad);
  const row = {
    ...spec,
    scenePair,
    decision: sameTreeDecide(spec, scenePair, { treatQueueAsLoad }),
  };
  writeJson(path.join(sdir, 'verdict.json'), row);
  console.log(`${spec.id} => ${row.decision.verdict}`);
  logPair(spec.id, scenePair, [
    ...spec.load,
    ...spec.primary,
    'COLLECT_MS',
    'EMIT_MS',
    'RENDER_QUEUE_SIZE',
    'VISIBLE_ENTITIES',
  ]);
  return row;
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  const want = new Set(args.only || ['hygiene', 'allOnScreen', 'highReject']);
  fs.mkdirSync(outRoot, { recursive: true });
  const snap = snapshotSrcTree();
  const payload = { vs: args.vs, args, hygiene: [], allOnScreen: null, highReject: null };

  try {
    if (want.has('hygiene')) payload.hygiene = measureHygiene(args, snap);
    if (want.has('allOnScreen')) payload.allOnScreen = measureSameTree(ALL_ON_SCREEN, args, true);
    if (want.has('highReject')) payload.highReject = measureSameTree(HIGH_REJECT, args, false);
  } finally {
    restoreSrcTree(snap);
  }

  payload.summary = summarize(payload);
  payload.learned = learnedText(payload);
  writeJson(path.join(outRoot, 'summary.json'), payload);
  const reportPath = writeReport(payload);
  console.log(`\n${payload.summary}`);
  console.log(`report ${reportPath}`);
}

main();
