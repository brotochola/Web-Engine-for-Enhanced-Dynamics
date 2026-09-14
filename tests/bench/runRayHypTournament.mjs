#!/usr/bin/env node
/**
 * Ray hyp tournament: Round1 singles → Round2 pairs → Round3 stacks → champion.
 *
 *   node tests/bench/run-ray-hyp-tournament.mjs --round all
 *   node tests/bench/run-ray-hyp-tournament.mjs --round 1 --runs 2 --warmup-ms 8000 --duration-ms 10000
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/workers/workers-utils.js';
import {
  applyCombo,
  applyHyp,
  restoreAll,
  PATHS,
  CANONICAL_ORDER,
  sortHypIds,
  HYPS,
} from './ray-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const microRunner = path.join(repoRoot, 'tests/bench/ray-microbench.mjs');
const outDir = path.join(repoRoot, 'tests/results/ray-hyps/tournament');

const SCENES = [
  { key: 'rayStress', scene: '/tests/bench/stressScenes/RayStressScene.js', exportName: 'RayStressScene' },
  { key: 'predator', scene: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene' },
];

const HYP_TARGETS = {
  H1: { l1: ['castAllOps'], l2: true, l3: false },
  H2: { l1: ['castOps', 'losOps'], l2: true, l3: true },
  H3: { l1: ['castOps', 'losOps'], l2: true, l3: true },
  H4: { l1: ['castOps'], l2: true, l3: false },
  H5: { l1: ['castOps', 'losOps'], l2: true, l3: false },
  H6: { l1: ['castAllOps'], l2: true, l3: false },
};

function parseArgs(argv) {
  const out = {
    round: 'all',
    runs: 2,
    warmupMs: 8000,
    durationMs: 10000,
    skipL3: false,
    dryApply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--round' && argv[i + 1]) out.round = String(argv[++i]);
    else if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || 8000;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || 10000;
    else if (a === '--skip-l3') out.skipL3 = true;
    else if (a === '--dry-apply') out.dryApply = true;
  }
  return out;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function seriesStats(values) {
  return { median: median(values), samples: values };
}

function pctDelta(hyp, base) {
  if (base == null || !(base > 0) || hyp == null) return null;
  return ((hyp - base) / base) * 100;
}

function logicFromReport(j) {
  const logic = (j.workers || []).find((w) => w.id === 'logic0' || w.type === 'logic');
  const avg = logic?.statsSamplesAverage || {};
  return {
    STEP_MS: avg.STEP_MS ?? 0,
    RAYCAST_MS: avg.RAYCAST_MS ?? 0,
    RAYCAST_COUNT: avg.RAYCAST_COUNT ?? 0,
    ENTITIES_PROCESSED: avg.ENTITIES_PROCESSED ?? 0,
    loadPct: workerLoadPct(avg.STEP_MS ?? 0),
  };
}

function tagFromIds(ids) {
  if (!ids.length) return 'BASE';
  return sortHypIds(ids).join('+');
}

function applyEntrant(ids) {
  if (!ids.length) {
    restoreAll();
    return;
  }
  applyCombo(ids);
}

function runMicro(tag, runIndex) {
  const out = path.join(outDir, `${tag}-l1-r${runIndex}.json`);
  execFileSync(process.execPath, [microRunner, '--output', out], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function runIntegrated(scene, tag, runIndex, warmupMs, durationMs) {
  const out = path.join(outDir, `${tag}-${scene.key}-r${runIndex}.json`);
  execFileSync(
    process.execPath,
    [
      integratedRunner,
      '--scene',
      scene.scene,
      '--scene-export',
      scene.exportName,
      '--warmup-ms',
      String(warmupMs),
      '--duration-ms',
      String(durationMs),
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function measureEntrant(ids, args, scenes) {
  const tag = tagFromIds(ids);
  console.log(`\n======== MEASURE ${tag} ========`);
  applyEntrant(ids);

  const l1Runs = [];
  const l2Runs = [];
  const l3Runs = [];

  for (let r = 0; r < args.runs; r++) {
    console.log(`\n--- ${tag} L1 run ${r + 1}/${args.runs} ---`);
    try {
      const micro = runMicro(tag, r);
      l1Runs.push({
        castOps: micro.cases?.cast?.opsPerSec ?? 0,
        castAllOps: micro.cases?.castAll?.opsPerSec ?? 0,
        losOps: micro.cases?.hasLineOfSight?.opsPerSec ?? 0,
        linecastOps: micro.cases?.linecastBetweenEntities?.opsPerSec ?? 0,
        ok: true,
      });
    } catch (e) {
      console.error(`L1 FAILED for ${tag}:`, e.message);
      l1Runs.push({ ok: false, error: String(e.message || e) });
      break;
    }

    for (const scene of scenes) {
      console.log(`\n--- ${tag} ${scene.key} run ${r + 1}/${args.runs} ---`);
      const report = runIntegrated(scene, tag, r, args.warmupMs, args.durationMs);
      const logic = logicFromReport(report);
      if (scene.key === 'rayStress') l2Runs.push(logic);
      else l3Runs.push(logic);
    }
  }

  const summarizeL1 = () => {
    const ok = l1Runs.filter((x) => x.ok);
    if (!ok.length) return { ok: false, error: l1Runs[0]?.error };
    return {
      ok: true,
      castOps: seriesStats(ok.map((x) => x.castOps)),
      castAllOps: seriesStats(ok.map((x) => x.castAllOps)),
      losOps: seriesStats(ok.map((x) => x.losOps)),
      linecastOps: seriesStats(ok.map((x) => x.linecastOps)),
    };
  };

  const summarizeLogic = (rows) => {
    if (!rows.length) return null;
    return {
      RAYCAST_MS: seriesStats(rows.map((x) => x.RAYCAST_MS)),
      STEP_MS: seriesStats(rows.map((x) => x.STEP_MS)),
      RAYCAST_COUNT: seriesStats(rows.map((x) => x.RAYCAST_COUNT)),
      ENTITIES_PROCESSED: seriesStats(rows.map((x) => x.ENTITIES_PROCESSED)),
    };
  };

  return {
    id: tag,
    ids: sortHypIds(ids),
    l1: summarizeL1(),
    l2: summarizeLogic(l2Runs),
    l3: summarizeLogic(l3Runs),
  };
}

function decideSingle(result, base) {
  const reasons = [];
  if (!result.l1?.ok) {
    return { accept: false, reasons: ['L1 correctness/bench failed'] };
  }
  if (!base?.l1?.ok) {
    return { accept: false, reasons: ['BASE missing'] };
  }

  const hypId = result.ids[0];
  const targets = HYP_TARGETS[hypId] || { l1: ['castOps'], l2: true, l3: false };

  let targetOk = false;
  for (const key of targets.l1) {
    const d = pctDelta(result.l1[key]?.median, base.l1[key]?.median);
    if (d != null && d >= 3) targetOk = true;
    if (d != null && d < -5 && !targets.l1.includes(key)) {
      // non-target handled below
    }
  }
  if (targets.l2 && result.l2 && base.l2) {
    const d = pctDelta(result.l2.RAYCAST_MS.median, base.l2.RAYCAST_MS.median);
    // lower ms is better → negative pct is win
    if (d != null && d <= -3) targetOk = true;
  }
  if (targets.l3 && result.l3 && base.l3) {
    const d = pctDelta(result.l3.RAYCAST_MS.median, base.l3.RAYCAST_MS.median);
    if (d != null && d <= -3) targetOk = true;
  }

  if (!targetOk) reasons.push('target metric did not improve ≥3%');

  for (const key of ['castOps', 'castAllOps', 'losOps', 'linecastOps']) {
    if (targets.l1.includes(key)) continue;
    const d = pctDelta(result.l1[key]?.median, base.l1[key]?.median);
    if (d != null && d < -5) reasons.push(`non-target L1 ${key} regress ${d.toFixed(1)}%`);
  }

  if (result.l2 && base.l2) {
    const cd = pctDelta(result.l2.RAYCAST_COUNT.median, base.l2.RAYCAST_COUNT.median);
    if (cd != null && Math.abs(cd) > 5) reasons.push(`L2 RAYCAST_COUNT drift ${cd.toFixed(1)}%`);
    const sd = pctDelta(result.l2.STEP_MS.median, base.l2.STEP_MS.median);
    if (sd != null && sd > 5) reasons.push(`L2 STEP_MS regress ${sd.toFixed(1)}%`);
  }

  return { accept: reasons.length === 0 && targetOk, reasons, targetOk };
}

function decideCombo(result, base, parents) {
  const reasons = [];
  if (!result.l1?.ok) return { accept: false, reasons: ['L1 failed'] };

  // Must beat BASE on L2 RAYCAST_MS (primary combo score)
  if (result.l2 && base.l2) {
    const d = pctDelta(result.l2.RAYCAST_MS.median, base.l2.RAYCAST_MS.median);
    if (d == null || d > -1) reasons.push(`combo L2 RAYCAST_MS not better than BASE (${d?.toFixed(1)}%)`);
  }

  // Must not lose >3% vs best parent L2 RAYCAST_MS
  if (parents.length && result.l2) {
    const bestParentMs = Math.min(...parents.map((p) => p.l2?.RAYCAST_MS?.median ?? Infinity));
    if (Number.isFinite(bestParentMs) && bestParentMs > 0) {
      const d = pctDelta(result.l2.RAYCAST_MS.median, bestParentMs);
      // hyp ms vs parent ms: if hyp higher (worse), positive pct
      if (d != null && d > 3) reasons.push(`combo loses >3% vs best parent L2 (${d.toFixed(1)}%)`);
    }
  }

  for (const key of ['castOps', 'castAllOps', 'losOps']) {
    const d = pctDelta(result.l1[key]?.median, base.l1[key]?.median);
    if (d != null && d < -8) reasons.push(`combo L1 ${key} regress ${d.toFixed(1)}%`);
  }

  return { accept: reasons.length === 0, reasons };
}

function pairsOf(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      out.push(sortHypIds([ids[i], ids[j]]));
    }
  }
  return out;
}

function dryApplyAll() {
  for (const h of HYPS) {
    if (h.id === 'BASE') continue;
    applyHyp(h.id);
    execFileSync(process.execPath, ['--check', PATHS.ray], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', PATHS.utils], { stdio: 'pipe' });
  }
  applyCombo(CANONICAL_ORDER);
  execFileSync(process.execPath, ['--check', PATHS.ray], { stdio: 'pipe' });
  restoreAll();
  console.log('Dry-apply: all singles + FULL stack OK');
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

if (args.dryApply) {
  dryApplyAll();
  process.exit(0);
}

const scenes = args.skipL3 ? SCENES.filter((s) => s.key !== 'predator') : SCENES;
const leaderboard = {
  meta: {
    generatedAt: new Date().toISOString(),
    ...args,
    canonicalOrder: CANONICAL_ORDER,
    headless: true,
  },
  round1: null,
  round2: null,
  round3: null,
  champion: null,
};

try {
  dryApplyAll();

  // -------- Round 1 --------
  if (args.round === 'all' || args.round === '1') {
    const singles = ['BASE', ...CANONICAL_ORDER];
    const results = {};
    for (const id of singles) {
      results[id] = measureEntrant(id === 'BASE' ? [] : [id], args, scenes);
    }
    const base = results.BASE;
    const decisions = {};
    const winners = [];
    for (const id of CANONICAL_ORDER) {
      const d = decideSingle(results[id], base);
      decisions[id] = d;
      console.log(`Round1 ${id}: ${d.accept ? 'ACCEPT' : 'REJECT'} — ${d.reasons.join('; ') || 'ok'}`);
      if (d.accept) winners.push(id);
    }
    leaderboard.round1 = { results, decisions, winners };
    fs.writeFileSync(path.join(outDir, 'round1-summary.json'), JSON.stringify(leaderboard.round1, null, 2) + '\n');
    console.log('Round1 winners:', winners);
  }

  // -------- Round 2 --------
  if (args.round === 'all' || args.round === '2') {
    if (!leaderboard.round1) {
      const prev = path.join(outDir, 'round1-summary.json');
      if (!fs.existsSync(prev)) throw new Error('Need round1-summary.json — run --round 1 first');
      leaderboard.round1 = JSON.parse(fs.readFileSync(prev, 'utf8'));
    }
    const winners = leaderboard.round1.winners || [];
    const base =
      leaderboard.round1.results?.BASE ||
      measureEntrant([], args, scenes);
    if (!leaderboard.round1.results) leaderboard.round1.results = { BASE: base };

    const pairList = pairsOf(winners);
    const pairResults = {};
    const pairDecisions = {};
    const winningPairs = [];

    for (const pair of pairList) {
      const tag = tagFromIds(pair);
      const measured = measureEntrant(pair, args, scenes);
      pairResults[tag] = measured;
      const parents = pair.map((id) => leaderboard.round1.results[id]).filter(Boolean);
      const d = decideCombo(measured, base, parents);
      pairDecisions[tag] = d;
      console.log(`Round2 ${tag}: ${d.accept ? 'ACCEPT' : 'REJECT'} — ${d.reasons.join('; ') || 'ok'}`);
      if (d.accept) winningPairs.push(pair);
    }

    leaderboard.round2 = { pairResults, pairDecisions, winningPairs: winningPairs.map(tagFromIds) };
    fs.writeFileSync(path.join(outDir, 'round2-summary.json'), JSON.stringify(leaderboard.round2, null, 2) + '\n');
    console.log('Round2 winning pairs:', leaderboard.round2.winningPairs);
  }

  // -------- Round 3 --------
  if (args.round === 'all' || args.round === '3') {
    if (!leaderboard.round1) {
      leaderboard.round1 = JSON.parse(fs.readFileSync(path.join(outDir, 'round1-summary.json'), 'utf8'));
    }
    if (!leaderboard.round2) {
      const p2 = path.join(outDir, 'round2-summary.json');
      leaderboard.round2 = fs.existsSync(p2)
        ? JSON.parse(fs.readFileSync(p2, 'utf8'))
        : { winningPairs: [], pairResults: {} };
    }

    const winners = leaderboard.round1.winners || [];
    const base = leaderboard.round1.results.BASE;
    const stacks = [];

    // FULL stack of round1 winners
    if (winners.length >= 2) stacks.push(sortHypIds(winners));

    // Unions of winning pairs that share membership
    const wp = (leaderboard.round2.winningPairs || []).map((t) => t.split('+'));
    for (let i = 0; i < wp.length; i++) {
      for (let j = i + 1; j < wp.length; j++) {
        const union = sortHypIds([...new Set([...wp[i], ...wp[j]])]);
        if (union.length >= 3) stacks.push(union);
      }
    }

    // Dedupe stack tags
    const seen = new Set();
    const uniqueStacks = [];
    for (const s of stacks) {
      const t = tagFromIds(s);
      if (seen.has(t)) continue;
      seen.add(t);
      uniqueStacks.push(s);
    }

    const stackResults = {};
    const stackDecisions = {};
    for (const stack of uniqueStacks) {
      const tag = tagFromIds(stack);
      const measured = measureEntrant(stack, args, scenes);
      stackResults[tag] = measured;
      const parents = (leaderboard.round2.winningPairs || [])
        .map((t) => leaderboard.round2.pairResults?.[t])
        .filter(Boolean);
      const d = decideCombo(measured, base, parents.length ? parents : winners.map((id) => leaderboard.round1.results[id]));
      stackDecisions[tag] = d;
      console.log(`Round3 ${tag}: ${d.accept ? 'ACCEPT' : 'REJECT'} — ${d.reasons.join('; ') || 'ok'}`);
    }

    // Champion = best L2 RAYCAST_MS among accepted stacks, else among winning pairs, else best single winner
    const candidates = [];
    for (const [tag, r] of Object.entries(stackResults)) {
      if (stackDecisions[tag]?.accept && r.l2) candidates.push({ tag, ids: r.ids, ms: r.l2.RAYCAST_MS.median, source: 'round3' });
    }
    for (const tag of leaderboard.round2.winningPairs || []) {
      const r = leaderboard.round2.pairResults?.[tag];
      if (r?.l2) candidates.push({ tag, ids: r.ids, ms: r.l2.RAYCAST_MS.median, source: 'round2' });
    }
    for (const id of winners) {
      const r = leaderboard.round1.results[id];
      if (r?.l2) candidates.push({ tag: id, ids: [id], ms: r.l2.RAYCAST_MS.median, source: 'round1' });
    }

    candidates.sort((a, b) => a.ms - b.ms);
    const champion = candidates[0] || null;

    leaderboard.round3 = { stackResults, stackDecisions, stacks: uniqueStacks.map(tagFromIds), champion };
    fs.writeFileSync(path.join(outDir, 'round3-summary.json'), JSON.stringify(leaderboard.round3, null, 2) + '\n');
    leaderboard.champion = champion;
    console.log('Champion:', champion);
  }

  fs.writeFileSync(path.join(outDir, 'tournament-leaderboard.json'), JSON.stringify(leaderboard, null, 2) + '\n');
  console.log(`\nWrote ${path.join(outDir, 'tournament-leaderboard.json')}`);

  // Merge champion if round all/3 produced one
  if (leaderboard.champion?.ids?.length) {
    const mergePath = path.join(outDir, 'champion-ids.json');
    fs.writeFileSync(mergePath, JSON.stringify(leaderboard.champion, null, 2) + '\n');
    console.log('Champion ids saved for merge step');
  }
} finally {
  restoreAll();
  console.log('Restored baselines');
}
