#!/usr/bin/env node
/**
 * Hygiene A/B: current src tree versus a git rev (default main).
 * Same scene files on both sides: the baseline is a worktree with only src/
 * from that rev (revWorktree.mjs). The working tree is never written.
 *
 *   node tests/bench/runHygieneSceneAb.mjs --vs main
 *   node tests/bench/runHygieneSceneAb.mjs --vs main --only steadyCombat
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
  pctDelta,
  renderCompareTable,
  repoRoot,
  sceneMetricKeys,
  stepMsFloorOk,
  usesStressStepFloor,
  workloadOk,
  writeJson,
} from './measureLib.mjs';
import { ensureRevWorktree } from './revWorktree.mjs';

const outRoot = path.join(repoRoot, 'tests/results/hygiene-vs-main');

const ROWS = [
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
    primary: ['physics_STEP_MS'],
    load: ['BODY_COUNT', 'AWAKE_COUNT'],
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
    // Hygiene: none of these 3% worse. Combat load is emergent — pair may FAIL.
    primary: ['physics_STEP_MS', 'logic0_STEP_MS', 'particle_STEP_MS', 'spatialMax_STEP_MS', 'pixi_STEP_MS'],
    load: ['BODY_COUNT', 'ACTIVE_PARTICLES'],
  },
  {
    id: 'burningBoxes',
    name: 'Burning Boxes',
    scene: {
      key: 'burningBoxes',
      path: '/demos/burningBoxesScene/burningBoxesScene.js',
      exportName: 'BurningBoxesScene',
      headed: true,
      kind: 'gameplay',
    },
    primary: ['physics_STEP_MS', 'pixi_STEP_MS'],
    load: ['BODY_COUNT'],
  },
  {
    id: 'liquidFunStress',
    name: 'LiquidFun stress',
    scene: {
      key: 'liquidFunStress',
      path: '/tests/bench/stressScenes/liquidFunStressScene.js',
      exportName: 'LiquidFunStressScene',
      headed: false,
      kind: 'stress',
    },
    primary: ['physics_STEP_MS'],
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
    primary: ['particle_STEP_MS', 'spatialMax_STEP_MS', 'logic0_STEP_MS'],
    load: ['BODY_COUNT', 'ACTIVE_PARTICLES'],
  },
];

function parseArgs(argv) {
  let vs = 'main';
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vs' && argv[i + 1]) vs = String(argv[++i]);
    else if (argv[i] === '--only' && argv[i + 1]) {
      only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return {
    vs,
    only,
    runs: 5,
    stressRuns: 2,
    warmupMs: 25_000,
    durationMs: 18_000,
    stressWarmupMs: 8000,
    stressDurationMs: 10_000,
    headlessAll: false,
    detailedStats: false,
  };
}

function decideRow(feature, scenePair) {
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
        r.startsWith('step floor:') ||
        r.includes('BODY_COUNT')
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

function writeReport(payload, reportPath = path.join(outRoot, 'report.md')) {
  const lines = [];
  lines.push('# Hygiene vs main: four scenes with physics ON');
  lines.push('');
  lines.push(
    'Hypothesis: the current tree (`physics.enabled === false` opt-in, do not allocate the grid when spatial workers = 0, DebugUI caps) does not make the primaries of Predator, Balls, Burning Boxes, and LiquidFunStress ≥3% worse than `main`. This is hygiene, not a claim of "faster than main".'
  );
  lines.push('');
  lines.push('## What changed');
  lines.push('');
  lines.push(
    'The baseline is a worktree with only that revision\'s `src/`; both sides use the working tree\'s scenes. All four have physics on and spatial workers > 0: they do not enter the Weed-pose path or the grid skip.'
  );
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(
    `Git: working tree vs \`${payload.vs}\`. Gameplay headed ${payload.args.runs} × ${payload.args.warmupMs}/${payload.args.durationMs} ms, visible window, \`collectDetailedStats\` off. Stress headless ${payload.args.stressRuns} × ${payload.args.stressWarmupMs}/${payload.args.stressDurationMs} ms. Predator is the artistic demo (emergent load); it is not the scoreboard \`steadyCombat\` row.`
  );
  lines.push('');
  lines.push('## Numbers');
  lines.push('');

  for (const row of payload.rows) {
    lines.push(`### ${row.id} — ${row.name}`);
    lines.push('');
    lines.push(
      `Scene \`${row.scene.path}\` (${row.scene.exportName}), ${row.scene.kind === 'gameplay' ? 'gameplay headed' : 'stress headless'}. Primaries: ${row.primary.join(', ')}. Load: ${row.load.join(', ')}.`
    );
    lines.push('');
    lines.push(`**Verdict: ${row.decision.verdict}.**`);
    lines.push('');
    if (!row.scenePair?.ok) {
      lines.push(`The scene failed: ${row.scenePair?.error || 'unknown error'}.`);
      lines.push('');
      continue;
    }
    const keys = sceneMetricKeys(row, row.scenePair);
    lines.push(renderCompareTable(row.scenePair.base, row.scenePair.hyp, keys));
    lines.push('');
    if (row.scenePair.workload?.ok) {
      lines.push('Load matches: ±5% and cv < 50%. The pair exists.');
    } else if (row.scenePair.workload) {
      const drifts = (row.scenePair.workload.drifts || [])
        .map((d) => (d.reason ? `${d.key}: ${d.reason}` : `${d.key} ${fmtDeltaPct(d.pct)}`))
        .join('; ');
      lines.push(`Load does not match. The pair does not exist. Detail: ${drifts || 'no drifts'}.`);
    }
    lines.push('');
    if (row.decision.reasons?.length) {
      lines.push(`Reason: ${row.decision.reasons.join(' ')}`);
      lines.push('');
    }
    for (const hit of row.decision.hits || []) lines.push(`- ${explainHit(hit)}`);
    if (row.decision.hits?.length) lines.push('');
  }

  lines.push('## Verdict');
  lines.push('');
  lines.push(payload.summary);
  lines.push('');
  lines.push('## What we learned');
  lines.push('');
  lines.push(payload.learned);
  lines.push('');
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
}

function productText(rows) {
  const fails = rows.filter((r) => r.decision.verdict === 'FAIL' || r.decision.verdict === 'WORSE');
  const keeps = rows.filter((r) => r.decision.verdict === 'KEPT');
  const ties = rows.filter((r) => r.decision.verdict === 'TIE');
  if (fails.length) {
    return `No. ${fails.map((r) => `${r.id}=${r.decision.verdict}`).join(', ')}. Hygiene is not claimed clean.`;
  }
  if (keeps.length) {
    return `Hygiene OK. ${keeps.map((r) => r.id).join(', ')} kept; ${ties.map((r) => r.id).join(', ') || 'none'} tie. No primary ≥3% worse.`;
  }
  if (ties.length) {
    return `Hygiene OK (tie): ${ties.map((r) => r.id).join(', ')} within 3%.`;
  }
  return 'No comparable rows.';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.only ? ROWS.filter((r) => args.only.includes(r.id)) : ROWS;
  if (!selected.length) {
    throw new Error(`--only matched nothing. ids: ${ROWS.map((r) => r.id).join(', ')}`);
  }
  fs.mkdirSync(outRoot, { recursive: true });
  const baseline = ensureRevWorktree(args.vs);
  console.log(`baseline worktree ${baseline.root} (${baseline.sha.slice(0, 8)})`);
  const rows = [];

  for (const feature of selected) {
      console.log(`\n################ ${feature.id} ################`);
      const sdir = path.join(outRoot, feature.scene.key);
      fs.mkdirSync(sdir, { recursive: true });

      console.log(`\n======== ${feature.id} BASE ${args.vs} ========`);
      const base = measureSceneSide(`${feature.scene.key}-BASE`, feature.scene, args, sdir, feature.id, baseline.root);

      console.log(`\n======== ${feature.id} KEEP ========`);
      const hyp = measureSceneSide(`${feature.scene.key}-KEEP`, feature.scene, args, sdir, feature.id);

      const scenePair = {
        ok: Boolean(base.ok && hyp.ok),
        error: base.ok ? hyp.error : base.error,
        base: base.summary,
        hyp: hyp.summary,
        workload:
          base.ok && hyp.ok && base.summary && hyp.summary
            ? workloadOk(base.summary, hyp.summary, feature.load)
            : { ok: false, drifts: [] },
        headed: base.headed,
        runs: base.runs,
        warmupMs: base.warmupMs,
        durationMs: base.durationMs,
      };

      const row = {
        ...feature,
        scenePair,
        decision: decideRow(feature, scenePair),
      };
      rows.push(row);
      writeJson(path.join(outRoot, feature.id, 'verdict.json'), row);
      console.log(`${feature.id} => ${row.decision.verdict}`);
      if (scenePair.ok) {
        for (const key of [...feature.load, ...feature.primary]) {
          const b = scenePair.base[key];
          const h = scenePair.hyp[key];
          const d = pctDelta(h?.median, b?.median);
          console.log(`  ${key}: ${fmtStat(b, metricKind(key))} -> ${fmtStat(h, metricKind(key))} (${fmtDeltaPct(d)})`);
        }
      }
  }

  const payload = {
    vs: args.vs,
    args,
    rows,
    summary: productText(rows),
    learned:
      args.only
        ? 'steadyCombat is the catalog combat row (stable load). Predator does not stand in for this pair.'
        : 'These scenes do not exercise the Weed-pose path. A TIE or a hygiene keep here does not prove Bunny Mark; a WORSE would be a regression on the usual WASM path.',
  };
  const tag = args.only ? args.only.join('-') : 'all';
  const summaryPath = args.only
    ? path.join(outRoot, `${tag}-summary.json`)
    : path.join(outRoot, 'summary.json');
  writeJson(summaryPath, payload);
  writeReport(payload, args.only ? path.join(outRoot, `${tag}-report.md`) : path.join(outRoot, 'report.md'));
  console.log('\n======== HYGIENE VS MAIN ========');
  console.log(payload.summary);
  console.log(`Wrote ${args.only ? path.join(outRoot, `${tag}-report.md`) : path.join(outRoot, 'report.md')}`);
}

main();
