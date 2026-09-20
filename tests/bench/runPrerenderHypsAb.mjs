#!/usr/bin/env node
/**
 * Isolated pre-render hyps: DRY, then B, then A, then C (C only if emit still large).
 *
 *   node tests/bench/runPrerenderHypsAb.mjs --hyp dry
 *   node tests/bench/runPrerenderHypsAb.mjs --hyp b
 *   node tests/bench/runPrerenderHypsAb.mjs --hyp a
 *   node tests/bench/runPrerenderHypsAb.mjs --hyp c
 *
 * Swaps only src/workers/preRenderWorker.js between snapshot files.
 * Three headed playable demos. skipCull stays as each scene already has it.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SPEED_PCT,
  explainHit,
  fmtDeltaPct,
  fmtStat,
  measureSceneSide,
  metricKind,
  parseMeasureArgs,
  pctDelta,
  renderCompareTable,
  repoRoot,
  sceneMetricKeys,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const WORKER_REL = 'src/workers/preRenderWorker.js';
const SNAP_DIR = path.join(repoRoot, 'tests/bench/prerender-hyps/snapshots');
const CAMPAIGN_MS_FLOOR = 8;
const EMIT_STILL_LARGE_MS = 1.5;

const HYPS = {
  dry: {
    id: 'dry',
    name: 'DRY un loop + sombras extraídas',
    baseSnap: '00-dual-loop.js',
    hypSnap: '01-dry.js',
    kind: 'hygiene',
    claim:
      'Un solo walk de collect (if skipCull) y _writeFusedSunShadow extraído no empeoran ≥3% las primarias de bunny playable, Balls o Predator frente al árbol skipCull con dos fors.',
  },
  b: {
    id: 'b',
    name: 'B no escribir campos muertos',
    baseSnap: '01-dry.js',
    hypSnap: '02-dry-b.js',
    kind: 'speed',
    claim:
      'No escribir SpriteRenderer.screenX/Y, ni tile fields si repeat==0, ni sortKey si el layer no y-sortea, baja preRender_STEP_MS ≥3% en bunny playable (MARK_ACTIVE ±5%, baseline ≥8 ms) sin empeorar Balls/Predator 3%.',
  },
  a: {
    id: 'a',
    name: 'A un pase type 0',
    baseSnap: null, // filled at run: 02 if B kept, else 01
    hypSnap: '03-fuse-type0.js',
    kind: 'speed',
    claim:
      'Escribir la fila SoA type 0 en collect (sin re-emitir en buildRenderQueue) baja EMIT_MS / preRender_STEP_MS ≥3% en bunny playable vs el campeón DRY+B (o DRY), misma cola, pixi igual.',
  },
  c: {
    id: 'c',
    name: 'C persistir columnas estáticas',
    baseSnap: null,
    hypSnap: '04-persist-static.js',
    kind: 'speed',
    claim:
      'Si count + entityIndex coinciden y no hay renderDirty/cambio de frame, escribir solo x/y (y rot) es ≥3% más barato en bunny playable. Full rewrite si cambia el set.',
  },
};

const SCENES = [
  {
    id: 'bunny',
    name: 'Bunny Mark playable',
    scene: {
      key: 'bunny',
      path: '/demos/bunnyMarkScene/bunnyMarkScene.js',
      exportName: 'BunnyMarkScene',
      headed: true,
      kind: 'gameplay',
    },
    primary: ['preRender_STEP_MS'],
    load: ['MARK_ACTIVE'],
    detailedStats: true,
    speedScene: true,
  },
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
    primary: ['physics_STEP_MS', 'logic0_STEP_MS', 'preRender_STEP_MS'],
    load: ['BODY_COUNT'],
    detailedStats: false,
    speedScene: false,
    revertPrimaries: ['physics_STEP_MS', 'logic0_STEP_MS'],
  },
  {
    id: 'predator',
    name: 'Predator',
    scene: {
      key: 'predator',
      path: '/demos/predatorScene/predatorScene.js',
      exportName: 'PredatorScene',
      headed: true,
      kind: 'gameplay',
    },
    primary: ['particle_STEP_MS', 'logic0_STEP_MS', 'spatialMax_STEP_MS', 'preRender_STEP_MS'],
    load: ['BODY_COUNT', 'ACTIVE_PARTICLES'],
    detailedStats: false,
    speedScene: false,
  },
];

function installWorker(snapName) {
  const src = path.join(SNAP_DIR, snapName);
  if (!fs.existsSync(src)) throw new Error(`missing snapshot ${src}`);
  fs.copyFileSync(src, path.join(repoRoot, WORKER_REL));
}

function pairFromSides(base, hyp, loadKeys) {
  return {
    ok: Boolean(base.ok && hyp.ok),
    error: base.ok ? hyp.error : base.error,
    base: base.summary,
    hyp: hyp.summary,
    workload:
      base.ok && hyp.ok && base.summary && hyp.summary
        ? workloadOk(base.summary, hyp.summary, loadKeys)
        : { ok: false, drifts: [] },
    headed: base.headed,
    runs: base.runs,
    warmupMs: base.warmupMs,
    durationMs: base.durationMs,
  };
}

function campaignFloor(baseSum, hypSum, keys) {
  const hits = [];
  for (const key of keys) {
    const b = baseSum?.[key]?.median;
    if (Number.isFinite(b) && b < CAMPAIGN_MS_FLOOR) hits.push({ side: 'baseline', key, median: b });
  }
  return {
    ok: hits.length === 0,
    hits,
    reason: hits.length
      ? `campaign floor: baseline bajo ${CAMPAIGN_MS_FLOOR} ms (${hits
          .map((h) => `${h.side} ${h.key}=${h.median.toFixed(3)}`)
          .join('; ')}). FAIL / sin señal de velocidad.`
      : '',
  };
}

function hitsFor(scenePair, metrics) {
  const hits = [];
  if (!scenePair?.ok || !scenePair.workload?.ok) return hits;
  for (const metric of metrics) {
    const b = scenePair.base[metric]?.median;
    const h = scenePair.hyp[metric]?.median;
    const d = pctDelta(h, b);
    if (d == null) continue;
    hits.push({ metric, base: b, hyp: h, deltaPct: d, higherBetter: false });
  }
  return hits;
}

function decideRow(feature, scenePair, hypKind) {
  const reasons = [];
  if (!scenePair?.ok) {
    return { verdict: 'FAIL', reasons: [`scene failed: ${scenePair?.error || 'unknown'}`], hits: [] };
  }
  if (scenePair.workload && !scenePair.workload.ok) {
    reasons.push(
      `load not comparable: ${scenePair.workload.drifts
        .map((d) => (d.reason ? `${d.key} ${d.reason}` : `${d.key} ${d.pct?.toFixed?.(1)}%`))
        .join(', ')}`
    );
    return { verdict: 'FAIL', reasons, hits: [] };
  }

  const hits = hitsFor(scenePair, feature.primary);
  const camp = campaignFloor(scenePair.base, scenePair.hyp, ['preRender_STEP_MS']);

  if (feature.speedScene && hypKind === 'speed') {
    if (!camp.ok) {
      const pre = hits.find((h) => h.metric === 'preRender_STEP_MS');
      const regress = pre && pre.deltaPct >= SPEED_PCT;
      return {
        verdict: regress ? 'WORSE' : 'FAIL',
        reasons: [...reasons, camp.reason, regress ? 'preRender ≥3% worse under floor' : 'sin señal de velocidad'],
        hits,
      };
    }
    const pre = hits.find((h) => h.metric === 'preRender_STEP_MS');
    if (!pre) return { verdict: 'NA', reasons: [...reasons, 'sin preRender_STEP_MS'], hits };
    if (pre.deltaPct <= -SPEED_PCT) {
      return { verdict: 'KEPT', reasons: [...reasons, 'preRender ≥3% más barato, carga OK, ≥8 ms'], hits };
    }
    if (pre.deltaPct >= SPEED_PCT) {
      return { verdict: 'WORSE', reasons: [...reasons, 'preRender ≥3% más caro'], hits };
    }
    return { verdict: 'TIE', reasons: [...reasons, 'dentro de 3%'], hits };
  }

  // Hygiene: Balls/Predator, or DRY on bunny. Sub-8ms preRender/logic is not speed.
  const hygieneHits = feature.speedScene
    ? hits
    : hits.filter((h) => {
        if (
          (h.metric === 'preRender_STEP_MS' || h.metric === 'logic0_STEP_MS') &&
          h.base < CAMPAIGN_MS_FLOOR &&
          h.hyp < CAMPAIGN_MS_FLOOR
        ) {
          return false;
        }
        return true;
      });
  const regress = hygieneHits.filter((h) => h.deltaPct >= SPEED_PCT);
  const wins = hygieneHits.filter((h) => h.deltaPct <= -SPEED_PCT);
  if (feature.speedScene && !camp.ok) {
    if (regress.length) return { verdict: 'WORSE', reasons: [...reasons, camp.reason, 'primary ≥3% worse'], hits };
    return { verdict: 'FAIL', reasons: [...reasons, camp.reason], hits };
  }
  if (regress.length) return { verdict: 'WORSE', reasons: [...reasons, 'primary ≥3% worse'], hits };
  if (wins.length) return { verdict: 'KEPT', reasons: [...reasons, 'primary ≥3% better, load OK (hygiene)'], hits };
  if (hits.length) return { verdict: 'TIE', reasons: [...reasons, 'within 3% (or sub-8ms preRender ignored)'], hits };
  return { verdict: 'NA', reasons: reasons.length ? reasons : ['no comparable metric'], hits };
}

function shouldRevert(hypId, rows) {
  const bunny = rows.find((r) => r.id === 'bunny');
  const balls = rows.find((r) => r.id === 'balls');
  if (balls?.decision.verdict === 'WORSE') {
    const bad = (balls.decision.hits || []).filter((h) => {
      if (h.deltaPct < SPEED_PCT) return false;
      if (h.metric === 'physics_STEP_MS') return true;
      if (h.metric === 'logic0_STEP_MS' && h.base >= CAMPAIGN_MS_FLOOR && h.hyp >= CAMPAIGN_MS_FLOOR) return true;
      return false;
    });
    if (bad.length) return { revert: true, reason: `Balls ${bad.map((h) => h.metric).join('/')} ≥3% peor` };
  }
  if (bunny?.decision.verdict === 'WORSE') {
    const pre = (bunny.decision.hits || []).find((h) => h.metric === 'preRender_STEP_MS');
    if (pre && pre.base >= CAMPAIGN_MS_FLOOR && pre.hyp >= CAMPAIGN_MS_FLOOR && pre.deltaPct >= SPEED_PCT) {
      return { revert: true, reason: `bunny preRender ≥8 ms y ≥3% peor` };
    }
  }
  if (hypId === 'dry') return { revert: false, reason: '' };
  if (bunny?.decision.verdict === 'WORSE' && bunny.decision.reasons?.some((r) => r.includes('preRender ≥3% más caro'))) {
    return { revert: true, reason: 'bunny speed hyp WORSE' };
  }
  return { revert: false, reason: '' };
}

function resolveSnaps(hypId, championSnap) {
  const spec = { ...HYPS[hypId] };
  if (hypId === 'a') spec.baseSnap = championSnap || '01-dry.js';
  if (hypId === 'c') spec.baseSnap = championSnap || '02-dry-b.js';
  return spec;
}

function writeRowSection(lines, row) {
  lines.push(`### ${row.id} — ${row.name}`);
  lines.push('');
  lines.push(
    `Escena \`${row.scene.path}\` (${row.scene.exportName}). Primarias: ${row.primary.join(', ')}. Carga: ${row.load.join(', ')}. Detalle ${row.detailedStats ? 'on' : 'off'}.`
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
  const reportPath = path.join(payload.outRoot, 'report.md');
  const lines = [];
  lines.push(`# preRender ${payload.spec.id}: ${payload.spec.name}`);
  lines.push('');
  lines.push(`Hipótesis: ${payload.spec.claim}`);
  lines.push('');
  lines.push('## What changed');
  lines.push('');
  lines.push(
    `Snapshot \`${payload.spec.baseSnap}\` (baseline) vs \`${payload.spec.hypSnap}\` (hyp). Solo se intercambia \`${WORKER_REL}\`. \`skipCull\` queda como cada escena ya lo tiene (bunny true, Balls/Predator false). \`poseSkip\` no se reabre.`
  );
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(
    `Gameplay headed ${payload.args.runs} × ${payload.args.warmupMs}/${payload.args.durationMs} ms, ventana visible, \`--src\`. Bunny con \`collectDetailedStats\` on (COLLECT_MS / EMIT_MS / cola). Balls y Predator producto off. Piso de campaña 8 ms solo para keep de velocidad en bunny. Balls y Predator son higiene.`
  );
  lines.push('');
  lines.push('## Numbers');
  lines.push('');
  for (const row of payload.rows) writeRowSection(lines, row);
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

function summarize(spec, rows, revert) {
  const bits = rows.map((r) => `${r.id}=${r.decision.verdict}`);
  let text = `${spec.id}: ${bits.join(', ')}.`;
  if (revert.revert) text += ` REVERT: ${revert.reason}.`;
  return text;
}

function learnedText(spec, rows) {
  const bunny = rows.find((r) => r.id === 'bunny');
  const emitB = bunny?.scenePair?.base?.EMIT_MS?.median;
  const emitH = bunny?.scenePair?.hyp?.EMIT_MS?.median;
  const stepB = bunny?.scenePair?.base?.preRender_STEP_MS?.median;
  const stepH = bunny?.scenePair?.hyp?.preRender_STEP_MS?.median;
  const parts = [];
  if (Number.isFinite(stepB) && Number.isFinite(stepH)) {
    parts.push(`Bunny preRender ${stepB.toFixed(3)} → ${stepH.toFixed(3)} ms.`);
  }
  if (Number.isFinite(emitB) && Number.isFinite(emitH)) {
    parts.push(`EMIT_MS ${emitB.toFixed(3)} → ${emitH.toFixed(3)} ms.`);
    if (spec.id === 'a' || spec.id === 'c') {
      parts.push(
        emitH >= EMIT_STILL_LARGE_MS
          ? `Emit sigue ≥ ${EMIT_STILL_LARGE_MS} ms: C todavía es candidato.`
          : `Emit ya < ${EMIT_STILL_LARGE_MS} ms: no implementar C en esta sentada.`
      );
    }
  }
  parts.push('Señal de velocidad solo en bunny playable. Balls/Predator higiene. Predator combate es emergente.');
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

function parseArgv(argv) {
  const out = parseMeasureArgs(argv, { hyp: 'dry', champion: null });
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hyp' && argv[i + 1]) out.hyp = String(argv[++i]);
    else if (argv[i] === '--champion' && argv[i + 1]) out.champion = String(argv[++i]);
  }
  if (out.only && !Array.isArray(out.only)) {
    out.only = String(out.only).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

function emitStillLarge(rows) {
  const bunny = rows.find((r) => r.id === 'bunny');
  const emit = bunny?.scenePair?.hyp?.EMIT_MS?.median;
  const stepB = bunny?.scenePair?.base?.preRender_STEP_MS?.median;
  const stepH = bunny?.scenePair?.hyp?.preRender_STEP_MS?.median;
  const d = pctDelta(stepH, stepB);
  return {
    emit,
    stepWon: Number.isFinite(d) && d <= -SPEED_PCT,
    stillLarge: Number.isFinite(emit) && emit >= EMIT_STILL_LARGE_MS,
  };
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  const hypId = args.hyp;
  if (!HYPS[hypId]) throw new Error(`--hyp must be dry|b|a|c, got ${hypId}`);
  const spec = resolveSnaps(hypId, args.champion);
  const outRoot = path.join(repoRoot, 'tests/results/prerender-hyps', spec.id);
  fs.mkdirSync(outRoot, { recursive: true });

  const selected = args.only ? SCENES.filter((s) => args.only.includes(s.id)) : SCENES;
  const saved = fs.readFileSync(path.join(repoRoot, WORKER_REL));
  const rows = [];

  try {
    for (const feature of selected) {
      console.log(`\n################ ${spec.id} ${feature.id} ################`);
      const sdir = path.join(outRoot, feature.scene.key);
      fs.mkdirSync(sdir, { recursive: true });
      const sceneArgs = { ...args, detailedStats: feature.detailedStats };

      console.log(`\n======== ${feature.id} BASE ${spec.baseSnap} ========`);
      installWorker(spec.baseSnap);
      const base = measureSceneSide(`${feature.scene.key}-BASE`, feature.scene, sceneArgs, sdir, feature.id);

      console.log(`\n======== ${feature.id} HYP ${spec.hypSnap} ========`);
      installWorker(spec.hypSnap);
      const hyp = measureSceneSide(`${feature.scene.key}-HYP`, feature.scene, sceneArgs, sdir, feature.id);

      const scenePair = pairFromSides(base, hyp, feature.load);
      const row = {
        ...feature,
        scenePair,
        decision: decideRow(feature, scenePair, spec.kind),
      };
      rows.push(row);
      writeJson(path.join(outRoot, feature.id, 'verdict.json'), row);
      console.log(`${feature.id} => ${row.decision.verdict}`);
      logPair(feature.id, scenePair, [...feature.load, ...feature.primary, 'COLLECT_MS', 'EMIT_MS', 'RENDER_QUEUE_SIZE']);
    }
  } finally {
    const revert = shouldRevert(spec.id, rows);
    if (revert.revert) {
      installWorker(spec.baseSnap);
      console.log(`REVERTED worker to ${spec.baseSnap}: ${revert.reason}`);
    } else {
      installWorker(spec.hypSnap);
    }
    if (!rows.length) fs.writeFileSync(path.join(repoRoot, WORKER_REL), saved);
  }

  const revert = shouldRevert(spec.id, rows);
  const emitGate = emitStillLarge(rows);
  const payload = {
    spec,
    args,
    outRoot,
    rows,
    revert,
    emitGate,
    summary: summarize(spec, rows, revert),
    learned: learnedText(spec, rows),
  };
  writeJson(path.join(outRoot, 'summary.json'), payload);
  const reportPath = writeReport(payload);
  console.log(`\n${payload.summary}`);
  console.log(`report ${reportPath}`);
  if (spec.id === 'a' || spec.id === 'c') {
    console.log(`emitGate emit=${emitGate.emit} stillLarge=${emitGate.stillLarge} stepWon=${emitGate.stepWon}`);
  }
}

main();
