#!/usr/bin/env node
/**
 * Decal hyp tournament: Round1 singles → Round2 pairs → Round3 stacks → champion.
 *
 *   node tests/bench/run-decal-hyp-tournament.mjs --round all
 *   node tests/bench/run-decal-hyp-tournament.mjs --round 1 --runs 2 --warmup-ms 8000 --duration-ms 10000
 *   node tests/bench/run-decal-hyp-tournament.mjs --round 2
 *   node tests/bench/run-decal-hyp-tournament.mjs --round 3
 *   node tests/bench/run-decal-hyp-tournament.mjs --dry-apply
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTournamentArgs,
  measureEntrant,
  decideSingle,
  decideCombo,
  writeJson,
  pairsOf,
  tagFromIds,
  sortHypIds,
} from './feature-tournament-lib.mjs';
import { applyCombo, applyHyp, restoreAll, PATHS, CANONICAL_ORDER, HYPS } from './decal-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const integratedRunner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const microRunner = path.join(repoRoot, 'tests/bench/decal-microbench.mjs');
const outDir = path.join(repoRoot, 'tests/results/decal-hyps/tournament');

const SCENES_ALL = [
  { key: 'decalStress', scene: '/tests/bench/stressScenes/DecalStampStressScene.js', exportName: 'DecalStampStressScene' },
  { key: 'zenithal', scene: '/demos/zenithalParticleTestScene/zenithalParticleTestScene.js', exportName: 'ZenithalParticleTestScene' },
];

const WORKER_PREFER_IDS = ['particle'];

const DECISION_TARGETS = {
  sceneKey: 'decalStress',
  sceneLower: ['DECAL_STAMP_MS', 'STEP_MS'],
  workloadKey: 'PARTICLES_STAMPED',
  comboPrimaryMs: 'DECAL_STAMP_MS',
};

const HYP_TARGETS = {
  D1: { l1Higher: ['normal1tileDenseOps', 'multiply1tileDenseOps', 'normalSparseOps', 'multiplySparseOps'] },
  D2: { l1Higher: ['normalMultitileLargeOps', 'normal1tileDenseOps', 'normalSparseOps'] },
  D3: { l1Higher: [] }, // L1 doesn't drive the worker loop — scene-only target.
  D4: { l1Higher: ['normal1tileDenseOps'] }, // weak — expected reject.
  D5: { l1Higher: [] }, // identity transform — expected reject.
  D6: { l1Higher: [] }, // L1 calls stampParticleToTileBuffers, not stampDecal — scene-only target.
};

function summarizeL1Run(micro) {
  const c = micro.cases || {};
  return {
    normal1tileDenseOps: c.normal_1tile_dense?.opsPerSec ?? 0,
    multiply1tileDenseOps: c.multiply_1tile_dense?.opsPerSec ?? 0,
    normalMultitileLargeOps: c.normal_multitile_large?.opsPerSec ?? 0,
    normalSparseOps: c.normal_sparse?.opsPerSec ?? 0,
    multiplySparseOps: c.multiply_sparse?.opsPerSec ?? 0,
  };
}

function parseArgs(argv) {
  const out = parseTournamentArgs(argv, { skipL3: true });
  if (argv.includes('--include-l3')) out.skipL3 = false;
  return out;
}

function applyEntrant(ids) {
  if (!ids.length) {
    restoreAll();
    return;
  }
  applyCombo(ids);
}

function measure(ids, args, scenes) {
  const tag = tagFromIds(ids, CANONICAL_ORDER);
  const result = measureEntrant({
    repoRoot,
    integratedRunner,
    microRunner,
    outDir,
    tag,
    runs: args.runs,
    scenes,
    warmupMs: args.warmupMs,
    durationMs: args.durationMs,
    workerPreferIds: WORKER_PREFER_IDS,
    applyEntrant: () => applyEntrant(ids),
    summarizeL1Run,
  });
  result.ids = sortHypIds(ids, CANONICAL_ORDER);
  return result;
}

function dryApplyAll() {
  for (const h of HYPS) {
    if (h.id === 'BASE') continue;
    applyHyp(h.id);
    execFileSync(process.execPath, ['--check', PATHS.decalStamp], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', PATHS.particleEmitter], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', PATHS.particleWorker], { stdio: 'pipe' });
  }
  applyCombo(CANONICAL_ORDER);
  execFileSync(process.execPath, ['--check', PATHS.decalStamp], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', PATHS.particleEmitter], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', PATHS.particleWorker], { stdio: 'pipe' });
  restoreAll();
  console.log('Dry-apply: all singles + FULL stack OK');
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

if (args.dryApply) {
  dryApplyAll();
  process.exit(0);
}

const scenes = args.skipL3 ? SCENES_ALL.filter((s) => s.key !== 'zenithal') : SCENES_ALL;
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
      results[id] = measure(id === 'BASE' ? [] : [id], args, scenes);
    }
    const base = results.BASE;
    const decisions = {};
    const winners = [];
    for (const id of CANONICAL_ORDER) {
      const targets = { ...DECISION_TARGETS, ...HYP_TARGETS[id] };
      const d = decideSingle(results[id], base, targets);
      decisions[id] = d;
      console.log(`Round1 ${id}: ${d.accept ? 'ACCEPT' : 'REJECT'} — ${d.reasons.join('; ') || 'ok'}`);
      if (d.accept) winners.push(id);
    }
    leaderboard.round1 = { results, decisions, winners };
    writeJson(path.join(outDir, 'round1-summary.json'), leaderboard.round1);
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
    const base = leaderboard.round1.results?.BASE || measure([], args, scenes);
    if (!leaderboard.round1.results) leaderboard.round1.results = { BASE: base };

    const pairList = pairsOf(winners, CANONICAL_ORDER);
    const pairResults = {};
    const pairDecisions = {};
    const winningPairs = [];

    for (const pair of pairList) {
      const tag = tagFromIds(pair, CANONICAL_ORDER);
      const measured = measure(pair, args, scenes);
      pairResults[tag] = measured;
      const parents = pair.map((id) => leaderboard.round1.results[id]).filter(Boolean);
      const d = decideCombo(measured, base, parents, DECISION_TARGETS);
      pairDecisions[tag] = d;
      console.log(`Round2 ${tag}: ${d.accept ? 'ACCEPT' : 'REJECT'} — ${d.reasons.join('; ') || 'ok'}`);
      if (d.accept) winningPairs.push(pair);
    }

    leaderboard.round2 = { pairResults, pairDecisions, winningPairs: winningPairs.map((p) => tagFromIds(p, CANONICAL_ORDER)) };
    writeJson(path.join(outDir, 'round2-summary.json'), leaderboard.round2);
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
    if (winners.length >= 2) stacks.push(sortHypIds(winners, CANONICAL_ORDER));

    // Unions of winning pairs that share membership
    const wp = (leaderboard.round2.winningPairs || []).map((t) => t.split('+'));
    for (let i = 0; i < wp.length; i++) {
      for (let j = i + 1; j < wp.length; j++) {
        const union = sortHypIds([...new Set([...wp[i], ...wp[j]])], CANONICAL_ORDER);
        if (union.length >= 3) stacks.push(union);
      }
    }

    // Dedupe stack tags
    const seen = new Set();
    const uniqueStacks = [];
    for (const s of stacks) {
      const t = tagFromIds(s, CANONICAL_ORDER);
      if (seen.has(t)) continue;
      seen.add(t);
      uniqueStacks.push(s);
    }

    const stackResults = {};
    const stackDecisions = {};
    for (const stack of uniqueStacks) {
      const tag = tagFromIds(stack, CANONICAL_ORDER);
      const measured = measure(stack, args, scenes);
      stackResults[tag] = measured;
      const parents = (leaderboard.round2.winningPairs || [])
        .map((t) => leaderboard.round2.pairResults?.[t])
        .filter(Boolean);
      const d = decideCombo(
        measured,
        base,
        parents.length ? parents : winners.map((id) => leaderboard.round1.results[id]),
        DECISION_TARGETS
      );
      stackDecisions[tag] = d;
      console.log(`Round3 ${tag}: ${d.accept ? 'ACCEPT' : 'REJECT'} — ${d.reasons.join('; ') || 'ok'}`);
    }

    // Champion = best scene DECAL_STAMP_MS among accepted stacks, else winning pairs, else best single winner.
    const msOf = (r) => r?.scenes?.[DECISION_TARGETS.sceneKey]?.[DECISION_TARGETS.comboPrimaryMs]?.median;
    const candidates = [];
    for (const [tag, r] of Object.entries(stackResults)) {
      const ms = msOf(r);
      if (stackDecisions[tag]?.accept && ms != null) candidates.push({ tag, ids: r.ids, ms, source: 'round3' });
    }
    for (const tag of leaderboard.round2.winningPairs || []) {
      const r = leaderboard.round2.pairResults?.[tag];
      const ms = msOf(r);
      if (ms != null) candidates.push({ tag, ids: r.ids, ms, source: 'round2' });
    }
    for (const id of winners) {
      const r = leaderboard.round1.results[id];
      const ms = msOf(r);
      if (ms != null) candidates.push({ tag: id, ids: [id], ms, source: 'round1' });
    }

    candidates.sort((a, b) => a.ms - b.ms);
    const champion = candidates[0] || null;

    leaderboard.round3 = { stackResults, stackDecisions, stacks: uniqueStacks.map((s) => tagFromIds(s, CANONICAL_ORDER)), champion };
    writeJson(path.join(outDir, 'round3-summary.json'), leaderboard.round3);
    leaderboard.champion = champion;
    console.log('Champion:', champion);
  }

  writeJson(path.join(outDir, 'tournament-leaderboard.json'), leaderboard);
  console.log(`\nWrote ${path.join(outDir, 'tournament-leaderboard.json')}`);

  if (leaderboard.champion?.ids?.length) {
    writeJson(path.join(outDir, 'champion-ids.json'), leaderboard.champion);
    console.log('Champion ids saved — leaving champion combo applied to src/.');
    applyCombo(leaderboard.champion.ids);
  } else {
    restoreAll();
    console.log('No accepted champion — restored baselines.');
  }
} catch (err) {
  restoreAll();
  console.error('Tournament failed, restored baselines:', err);
  throw err;
}
