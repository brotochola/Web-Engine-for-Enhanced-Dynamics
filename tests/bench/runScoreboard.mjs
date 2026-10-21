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

import { ENGINE_FEATURES, filterFeatures, getFeature } from './engineFeatureCatalog.mjs';
import {
  SPEED_PCT,
  explainHit,
  median,
  fmtDeltaPct,
  fmtStat,
  measureSceneSide,
  parseMeasureArgs,
  pctDelta,
  pickOpsWithKey,
  renderCompareTable,
  repoRoot,
  runKernelScript,
  sceneMetricKeys,
  sceneWantsHeaded,
  stepMsFloorOk,
  usesStressStepFloor,
  workloadOk,
  writeJson,
} from './measureLib.mjs';
import { isCli } from './microbenchHelpers.mjs';
import { ensureRevWorktree } from './revWorktree.mjs';

const outRoot = path.join(repoRoot, 'tests/results/scoreboard');

function runNodeTests() {
  try {
    execFileSync('pnpm', ['test:node'], { cwd: repoRoot, stdio: 'inherit', shell: true });
  } catch (first) {
    // Parallel ESM loads still flake rarely; one retry before aborting the campaign.
    console.warn('test:node failed once; retrying once before abort...');
    execFileSync('pnpm', ['test:node'], { cwd: repoRoot, stdio: 'inherit', shell: true });
  }
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
  if (feature.protocolCeiling) {
    reasons.push(`protocol ceiling: ${feature.protocolCeiling}`);
  }
  if (kernel && kernel.error) reasons.push(`kernel failed: ${kernel.error}`);
  if (scenePair && !scenePair.ok) reasons.push(`scene failed: ${scenePair.error || 'unknown'}`);
  if (scenePair?.workload && !scenePair.workload.ok) {
    reasons.push(
      `load not comparable: ${scenePair.workload.drifts
        .map((d) => (d.reason ? `${d.key} ${d.reason}` : `${d.key} ${d.pct?.toFixed?.(1)}%`))
        .join(', ')}`
    );
  }
  if (
    !feature.protocolCeiling &&
    usesStressStepFloor(feature.scene) &&
    scenePair?.ok &&
    scenePair.base &&
    scenePair.hyp
  ) {
    const floor = stepMsFloorOk(scenePair.base, scenePair.hyp, feature.primary);
    if (!floor.ok) reasons.push(floor.reason);
  }

  const hits = [];
  if (kernel?.baseOps != null && kernel?.hypOps != null && !feature.kernel?.informational) {
    const d = pctDelta(kernel.hypOps, kernel.baseOps);
    hits.push({
      metric: 'kernel',
      base: kernel.baseOps,
      hyp: kernel.hypOps,
      deltaPct: d,
      higherBetter: feature.kernel?.higherBetter !== false,
    });
  }
  if (!feature.protocolCeiling && scenePair?.ok && scenePair.workload?.ok) {
    for (const metric of feature.primary) {
      const b = scenePair.base[metric]?.median;
      const h = scenePair.hyp[metric]?.median;
      const d = pctDelta(h, b);
      if (d == null) continue;
      hits.push({ metric, base: b, hyp: h, deltaPct: d, higherBetter: false });
    }
  }

  if (feature.protocolCeiling) {
    return { verdict: 'FAIL', reasons, hits };
  }
  if (
    reasons.some(
      (r) =>
        r.startsWith('load') ||
        r.startsWith('scene failed') ||
        r.startsWith('kernel failed') ||
        r.startsWith('step floor:') ||
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

/**
 * N-35. Stress rows run 2 times per side, back to back, and four of the six rows
 * one scoreboard flagged against main were noise (textureUpload "+15 %" was
 * -11 % over 4 pairs). Before a row is called WORSE, each regressing hit is
 * measured again over RECHECK_PAIRS alternating pairs. It stays a regression
 * only if its median is still SPEED_PCT worse and at least 3 pairs in 4 are worse.
 */
const RECHECK_PAIRS = 4;

/**
 * @param {number[]} deltas per-pair (hyp / base - 1) in percent
 * @param {boolean} higherBetter kernels (ops/s) true, step times false
 */
export function confirmRegression(deltas, higherBetter) {
  const worseCount = deltas.filter((d) => (higherBetter ? d < 0 : d > 0)).length;
  const medianPct = deltas.length ? median(deltas) : 0;
  const medianWorse = higherBetter ? medianPct <= -SPEED_PCT : medianPct >= SPEED_PCT;
  return {
    confirmed: deltas.length > 0 && medianWorse && worseCount >= Math.ceil(deltas.length * 0.75),
    medianPct,
    worseCount,
    pairs: deltas.length,
  };
}

/** Re-measure a WORSE row's regressing hits over alternating pairs (N-35). */
export function recheckRegressions(feature, row, args, baseline, outRoot) {
  const regress = row.decision.hits.filter((h) =>
    h.higherBetter ? h.deltaPct <= -SPEED_PCT : h.deltaPct >= SPEED_PCT
  );
  const dir = path.join(outRoot, feature.id, 'recheck');
  fs.mkdirSync(dir, { recursive: true });
  const oneRun = { ...args, runs: 1, stressRuns: 1 };
  const results = [];
  for (const hit of regress) {
    const deltas = [];
    for (let p = 0; p < RECHECK_PAIRS; p++) {
      const order = p % 2 === 0 ? ['BASE', 'KEEP'] : ['KEEP', 'BASE'];
      const v = {};
      for (const side of order) {
        const root = side === 'BASE' ? baseline.root : undefined;
        if (hit.metric === 'kernel') {
          const json = runKernelScript(feature.kernel.script, path.join(dir, `kernel-${side}-p${p}.json`), root);
          v[side] = pickOpsWithKey(json, feature.kernel.opsKey);
        } else {
          const res = measureSceneSide(`${feature.scene.key}-${side}-p${p}`, feature.scene, oneRun, dir, feature.id, root);
          v[side] = res.ok ? res.summary[hit.metric]?.median : null;
        }
      }
      const d = pctDelta(v.KEEP, v.BASE);
      if (d != null) deltas.push(d);
    }
    results.push({ metric: hit.metric, deltas, ...confirmRegression(deltas, hit.higherBetter) });
  }
  return { pairs: RECHECK_PAIRS, results, confirmed: results.some((r) => r.confirmed) };
}

function isProtocolCeilingFail(row) {
  return (
    row.decision?.verdict === 'FAIL' &&
    (row.decision.reasons || []).some((r) => String(r).startsWith('protocol ceiling:'))
  );
}

/** A stress pair under 3 ms is FAIL. It is not a regression: the protocol forbids keep, drop, and tie. */
function isStepFloorFail(row) {
  const reasons = (row.decision?.reasons || []).map(String);
  return (
    row.decision?.verdict === 'FAIL' &&
    reasons.length > 0 &&
    reasons.every((r) => r.startsWith('step floor:'))
  );
}

function productVerdict(rows, gates) {
  if (gates?.node && gates.node !== 'ok' && gates.node !== 'skipped') {
    return { fasterThanMain: false, text: `No. test:node failed (${gates.node}). Speed does not count.` };
  }
  if (gates?.lockstep && gates.lockstep !== 'ok' && gates.lockstep !== 'skipped') {
    return { fasterThanMain: false, text: `No. Lockstep failed (${gates.lockstep}). Speed does not count.` };
  }
  const notClaimed = (r) => isProtocolCeilingFail(r) || isStepFloorFail(r);
  const usable = rows.filter((r) => r.decision.verdict !== 'NA' && !notClaimed(r));
  const fails = rows.filter(
    (r) => (r.decision.verdict === 'FAIL' || r.decision.verdict === 'WORSE') && !notClaimed(r)
  );
  const keeps = rows.filter((r) => r.decision.verdict === 'KEPT');
  const ceilings = rows.filter(isProtocolCeilingFail);
  const floors = rows.filter(isStepFloorFail);
  const aside = [
    ceilings.length ? `${ceilings.length} row(s) are a protocol ceiling (not claimed)` : '',
    floors.length ? `${floors.length} row(s) are under the 3 ms floor (not a regression)` : '',
  ].filter(Boolean).join('. ');
  const asideNote = aside ? ` ${aside}.` : '';
  if (fails.length) {
    return {
      fasterThanMain: false,
      text: `No. ${fails.length} row(s) FAIL/WORSE. Do not claim a better WeedJS.${asideNote}`,
    };
  }
  if (!usable.length) {
    return { fasterThanMain: false, text: `No. No comparable rows.${asideNote}` };
  }
  if (keeps.length && !fails.length) {
    return {
      fasterThanMain: true,
      text: `Yes, on the rows that were measured: ${keeps.map((r) => r.id).join(', ')} kept and none worse.${asideNote}`,
    };
  }
  return {
    fasterThanMain: false,
    text: `Tie: no row is ≥3% better and none is worse.${asideNote}`,
  };
}

function describeFeature(feature) {
  if (!feature) return 'Feature with no catalog entry.';
  const bits = [`Hot module: \`${feature.module}\`.`];
  if (feature.kernel) {
    bits.push(
      `Node kernel: \`${feature.kernel.script}\` (key ${feature.kernel.opsKey || 'ops/s'}; ${
        feature.kernel.higherBetter === false ? 'fewer ms is better' : 'more ops/s is better'
      }).`
    );
  } else {
    bits.push('There is no Node kernel for this row: only the scene that runs the code is measured.');
  }
  if (feature.scene) {
    bits.push(
      `Scene: \`${feature.scene.path}\` (${feature.scene.exportName}), ${
        feature.scene.kind === 'gameplay' ? 'gameplay headed' : 'stress'
      }, ${feature.scene.headed ? 'visible window' : 'headless'}.`
    );
  } else {
    bits.push('There is no Chromium scene: this row\'s claim is kernel-only.');
  }
  if (feature.primary?.length) bits.push(`Primaries: ${feature.primary.join(', ')}.`);
  if (feature.load?.length) bits.push(`Load keys: ${feature.load.join(', ')}.`);
  if (feature.protocolCeiling) {
    bits.push(`Protocol ceiling (the scene is not claimed): ${feature.protocolCeiling}.`);
  }
  if (feature.kernel?.informational) {
    bits.push('The kernel is informational: it does not enter keep/drop (stride or another confound).');
  }
  return bits.join(' ');
}

function writeFeatureSection(row, payload) {
  const feature = getFeature(row.id);
  const lines = [];
  lines.push(`### ${row.id} — ${row.name || feature?.name || row.id}`);
  lines.push('');
  lines.push(describeFeature(feature));
  lines.push('');
  lines.push(`**Verdict: ${row.decision.verdict}.**`);
  lines.push('');

  if (row.kernel?.error) {
    lines.push(`The kernel failed: ${row.kernel.error}`);
    lines.push('');
  } else if (row.kernel && (row.kernel.baseOps != null || row.kernel.hypOps != null)) {
    const d = row.kernel.deltaPct;
    const higherBetter = feature?.kernel?.higherBetter !== false;
    lines.push(
      `Kernel: baseline ${Number.isFinite(row.kernel.baseOps) ? row.kernel.baseOps.toFixed(higherBetter ? 0 : 3) : 'n/a'}${
        higherBetter ? ' ops/s' : ' ms'
      }, current tree ${Number.isFinite(row.kernel.hypOps) ? row.kernel.hypOps.toFixed(higherBetter ? 0 : 3) : 'n/a'}${
        higherBetter ? ' ops/s' : ' ms'
      } (${fmtDeltaPct(d)}).`
    );
    lines.push('');
  }

  if (row.scene && !row.scene.ok) {
    lines.push(`The scene failed: ${row.scene.error || 'unknown error'}. No worker numbers.`);
    lines.push('');
  } else if (row.scene?.base || row.scene?.hyp) {
    const keys = sceneMetricKeys(feature, row.scene);
    lines.push(renderCompareTable(row.scene.base, row.scene.hyp, keys));
    lines.push('');
    if (row.scene.workload?.ok) {
      lines.push('Load matches: this row\'s keys stayed within ±5% and each coefficient of variation was under 50%. The pair exists.');
    } else if (row.scene.workload) {
      const drifts = (row.scene.workload.drifts || [])
        .map((d) => (d.reason ? `${d.key}: ${d.reason}` : `${d.key} ${fmtDeltaPct(d.pct)}`))
        .join('; ');
      lines.push(`Load does not match. The pair does not exist. Detail: ${drifts || 'no drifts recorded'}.`);
    }
    lines.push('');
  }

  const hits = row.decision.hits || [];
  if (row.decision.reasons?.length) {
    lines.push(`Reason: ${row.decision.reasons.join(' ')}`);
    lines.push('');
  }
  if (hits.length) {
    lines.push('Why this verdict:');
    lines.push('');
    for (const hit of hits) lines.push(`- ${explainHit(hit)}`);
    lines.push('');
  }

  if (payload.args?.smoke) {
    lines.push(
      'This row was measured as smoke (one run per side). The cv comes out 0% because there is no series. A smoke KEPT or WORSE is a screen, not a claim to merge.'
    );
    lines.push('');
  }
  if (row.id === 'box2d' && payload.args?.smoke) {
    lines.push(
      'Context from the same campaign: the headed 5-run Balls confirm (`tests/results/product-confirm/report.md`) measured physics 6.911 → 6.554 ms (−5.2%) with `BODY_COUNT` 9004/9004. This 4 s smoke does not cancel that confirm: Box2D WASM was not touched; `physics_STEP_MS` is the Balls physics worker, and one 4 s run moves several percent from machine noise alone.'
    );
    lines.push('');
  }
  return lines.join('\n');
}

export function writeReport(payload) {
  const lines = [];
  lines.push('# Engine feature scoreboard');
  lines.push('');
  lines.push(
    `Hypothesis: the current working tree is faster than \`${payload.vs}\` on the catalog rows that were measured.`
  );
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(
    `Measured ${payload.rows.length} of ${payload.catalogSize} catalog rows: ${payload.rows.map((r) => r.id).join(', ')}.`
  );
  lines.push(
    `Correctness: test:node ${payload.gates?.node ?? 'n/a'}; lockstep balls/liquidfun/lfstress/particles ${payload.gates?.lockstep ?? 'n/a'}. If either fails, speed does not count.`
  );
  lines.push(
    `Gameplay headed ${payload.args.runs} × ${payload.args.warmupMs}/${payload.args.durationMs} ms. Stress headless ${payload.args.stressRuns} × ${payload.args.stressWarmupMs}/${payload.args.stressDurationMs} ms.`
  );
  if (payload.args?.headedOnly) {
    lines.push(
      `This run used \`--headed-only ${payload.args.headedOnly.join(',')}\`: only those rows open a window and run the five-run protocol. The other scenes (even if the catalog marks them headed) use the headless stress protocol.`
    );
  } else if (payload.args.headlessAll) {
    lines.push('This run used `--headless`: no scene opens a window.');
  }
  if (payload.args?.detailedStats) {
    lines.push('This run asked for `--detailed-stats`: sub-timers (`VISIBILITY_MS`, and the rest) are on. This is not a product confirm.');
  }
  lines.push(
    'Detailed stats off (load counts still publish). Load matches if the median stays within ±5% and each key\'s cv is under 50%. A speed keep requires a primary at least 3% cheaper in ms (or the kernel at least 3% more ops/s) and no primary on the row 3% worse.'
  );
  lines.push(
    `Baseline: git \`${payload.vs}\` plus the load-count patch (same visibility, that rev's speed). Treatment: the current working tree. The baseline runs from a worktree with only that rev's \`src/\`; the working tree is not written.`
  );
  if (payload.args.smoke) {
    lines.push(
      'Smoke run (n=1). It shows whether the platform closes load and writes numbers. It is not enough to claim that a feature is cheaper or more expensive.'
    );
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Feature | Verdict | Primary | Load |');
  lines.push('|---------|-----------|----------|-------|');
  for (const row of payload.rows) {
    const hit = (row.decision.hits || [])
      .map((h) => `${h.metric} ${fmtDeltaPct(h.deltaPct)}`)
      .join('; ') || '—';
    const load = row.scene?.workload?.ok ? 'OK' : row.scene?.workload ? 'NO' : '—';
    lines.push(`| ${row.id} | ${row.decision.verdict} | ${hit} | ${load} |`);
  }
  lines.push('');
  lines.push('## Numbers per feature');
  lines.push('');
  for (const row of payload.rows) {
    lines.push(writeFeatureSection(row, payload));
  }
  lines.push('## Product verdict');
  lines.push('');
  lines.push(payload.product.text);
  lines.push('');
  lines.push('## What we learned');
  lines.push('');
  lines.push(
    'WORSE does not mean "Box2D is broken". It means that row\'s primary (for box2d: Balls `physics_STEP_MS`) was at least 3% more expensive on this run, with matching load. A table of signs is not enough: the report has to say which scene, which worker, both sides in ms, and whether n=1 or n=5. Artistic Predator is not a row. Vis-poly uses `visPolyStressScene` with `raycasted: true`. Stable combat uses `steadyCombatScene`. Do not claim a "better WeedJS" until every catalog row is KEPT or a tie and none is WORSE or FAIL.'
  );
  lines.push('');
  const md = lines.join('\n');
  fs.writeFileSync(path.join(outRoot, 'report.md'), md);
  return md;
}

function updateHypothesisLog(payload) {
  const logPath = path.join(repoRoot, 'docs/internal/HYPOTHESIS_LOG.md');
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

function gateFailed(gates) {
  if (gates?.node && gates.node !== 'ok' && gates.node !== 'skipped') {
    return `test:node failed (${gates.node})`;
  }
  if (gates?.lockstep && gates.lockstep !== 'ok' && gates.lockstep !== 'skipped') {
    return `lockstep failed (${gates.lockstep})`;
  }
  return null;
}

/** Black / empty draw on a headed scene: stop instead of plowing ahead. */
function blackScreenReason(row, feature) {
  if (!feature?.scene?.headed && !(feature?.load || []).includes('VISIBLE_ENTITIES')) {
    return null;
  }
  const sides = [
    ['BASE', row?.scene?.base],
    ['KEEP', row?.scene?.hyp],
  ];
  for (const [label, summary] of sides) {
    if (!summary) continue;
    const vis = summary.VISIBLE_ENTITIES?.median;
    if (Number.isFinite(vis) && vis === 0) {
      return `${row.id} ${label} VISIBLE_ENTITIES median 0 (black / empty draw)`;
    }
  }
  return null;
}

function abortCampaign(reason, rows, gates, args) {
  console.error(`\nABORT scoreboard: ${reason}`);
  console.error('Diagnose and fix before continuing. Remaining catalog rows were not run.');
  const payload = {
    vs: args.vs,
    args,
    catalogSize: ENGINE_FEATURES.length,
    rows,
    gates,
    aborted: reason,
    product: { fasterThanMain: false, text: `No. Campaign aborted: ${reason}` },
  };
  writeJson(path.join(outRoot, 'summary.json'), payload);
  writeReport(payload);
  console.log(`Wrote ${path.join(outRoot, 'report.md')}`);
  process.exitCode = 1;
}

function main() {
  const args = parseMeasureArgs(process.argv.slice(2));
  const features = filterFeatures(args.only);
  fs.mkdirSync(outRoot, { recursive: true });
  const baseline = ensureRevWorktree(args.vs);
  console.log(`baseline worktree ${baseline.root} (${baseline.sha.slice(0, 8)})`);
  const rows = [];
  const sceneCache = new Map();

  const gates = { node: args.skipNode ? 'skipped' : null, lockstep: args.skipLockstep ? 'skipped' : null };
  {
    if (!args.skipNode) {
      console.log('\n======== correctness: pnpm test:node ========');
      try {
        runNodeTests();
        gates.node = 'ok';
      } catch (e) {
        gates.node = String(e.message || e);
        console.error('test:node failed; aborting scoreboard (product cannot be kept).');
        abortCampaign(`test:node failed (${gates.node})`, rows, gates, args);
        return;
      }
    }
    if (!args.skipLockstep) {
      console.log('\n======== correctness: lockstep visual ========');
      try {
        runLockstep();
        gates.lockstep = 'ok';
      } catch (e) {
        gates.lockstep = String(e.message || e);
        console.error('lockstep failed; aborting scoreboard (product cannot be kept).');
        abortCampaign(`lockstep failed (${gates.lockstep})`, rows, gates, args);
        return;
      }
    }

    const gateReason = gateFailed(gates);
    if (gateReason) {
      abortCampaign(gateReason, rows, gates, args);
      return;
    }

    for (const feature of features) {
      console.log(`\n################ ${feature.id} ################`);
      const row = { id: feature.id, name: feature.name };
      if (!args.skipKernels && feature.kernel && !feature.protocolCeiling) {
        const kdir = path.join(outRoot, feature.id);
        fs.mkdirSync(kdir, { recursive: true });
        try {
          console.log(`kernel BASE ${feature.kernel.script}`);
          const baseJson = runKernelScript(feature.kernel.script, path.join(kdir, 'kernel-BASE.json'), baseline.root);
          console.log(`kernel KEEP ${feature.kernel.script}`);
          const hypJson = runKernelScript(feature.kernel.script, path.join(kdir, 'kernel-KEEP.json'));
          row.kernel = {
            baseOps: pickOpsWithKey(baseJson, feature.kernel.opsKey),
            hypOps: pickOpsWithKey(hypJson, feature.kernel.opsKey),
          };
          row.kernel.deltaPct = pctDelta(row.kernel.hypOps, row.kernel.baseOps);
        } catch (e) {
          row.kernel = { error: String(e.message || e) };
        }
      }

      if (!args.skipScenes && feature.scene && !feature.protocolCeiling) {
        const headed = sceneWantsHeaded(feature.scene, args, feature.id);
        const cacheKey = `${feature.scene.key}|${headed ? 1 : 0}|${args.smoke}`;
        if (!sceneCache.has(cacheKey)) {
          const sdir = path.join(outRoot, feature.scene.key);
          fs.mkdirSync(sdir, { recursive: true });
          const base = measureSceneSide(`${feature.scene.key}-BASE`, feature.scene, args, sdir, feature.id, baseline.root);
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
      if (row.decision.verdict === 'WORSE' && !args.noRecheck && !args.smoke) {
        row.recheck = recheckRegressions(feature, row, args, baseline, outRoot);
        if (!row.recheck.confirmed) {
          const seen = row.recheck.results
            .map((r) => `${r.metric} ${fmtDeltaPct(r.medianPct)} median, ${r.worseCount}/${r.pairs} worse`)
            .join('; ');
          row.decision = {
            verdict: 'TIE',
            reasons: [
              ...row.decision.reasons.filter((r) => r !== 'primary ≥3% worse'),
              `flagged WORSE, not confirmed over ${RECHECK_PAIRS} ABAB pairs (${seen})`,
            ],
            hits: row.decision.hits,
          };
        }
      }
      rows.push(row);
      fs.mkdirSync(path.join(outRoot, feature.id), { recursive: true });
      writeJson(path.join(outRoot, feature.id, 'verdict.json'), row);
      console.log(`${feature.id} => ${row.decision.verdict}`);

      const black = blackScreenReason(row, feature);
      if (black) {
        abortCampaign(black, rows, gates, args);
        return;
      }
      if (row.decision.verdict === 'FAIL') {
        const reasons = row.decision.reasons || [];
        const onlyStepFloor =
          reasons.length > 0 && reasons.every((r) => String(r).startsWith('step floor:'));
        // Black canvas already aborted above. Step-floor / load / scene FAIL: keep going so
        // the campaign can raise knobs and remasure remaining rows in the same sitting.
        console.warn(
          `CONTINUE: ${row.id} FAIL (${onlyStepFloor ? 'step-floor' : reasons.join('; ') || 'no reason'}). Not a black abort.`
        );
      }
    }
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

if (isCli(import.meta.url)) main();
