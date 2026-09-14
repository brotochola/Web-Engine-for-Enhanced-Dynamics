#!/usr/bin/env node
/**
 * Particle hyp tournament (Wave B — emit + integrate): Round1 singles → Round2 pairs →
 * Round3 stacks → champion.
 *
 *   node tests/bench/run-particle-hyp-tournament.mjs --round all
 *   node tests/bench/run-particle-hyp-tournament.mjs --round 1 --runs 2 --warmup-ms 8000 --duration-ms 10000
 *   node tests/bench/run-particle-hyp-tournament.mjs --round 2
 *   node tests/bench/run-particle-hyp-tournament.mjs --round 3
 *   node tests/bench/run-particle-hyp-tournament.mjs --dry-apply
 *   node tests/bench/run-particle-hyp-tournament.mjs --include-l3   (adds zenithalParticleTestScene)
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
import { applyCombo, applyHyp, restoreAll, PATHS, CANONICAL_ORDER, HYPS } from './particle-hyps/hypPatches.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const integratedRunner = path.join(repoRoot, 'tests/bench/run-integrated-worker-benchmark.mjs');
const microRunner = path.join(repoRoot, 'tests/bench/particle-l1-microbench.mjs');
const outDir = path.join(repoRoot, 'tests/results/particle-hyps/tournament');

const SCENES_ALL = [
  { key: 'particleEmit', scene: '/tests/bench/stressScenes/ParticleEmitStressScene.js', exportName: 'ParticleEmitStressScene' },
  { key: 'particleIntegrate', scene: '/tests/bench/stressScenes/ParticleIntegrateStressScene.js', exportName: 'ParticleIntegrateStressScene' },
  { key: 'zenithal', scene: '/demos/zenithalParticleTestScene/zenithalParticleTestScene.js', exportName: 'ZenithalParticleTestScene' },
];

const WORKER_PREFER_IDS = ['particle'];

// Primary decision scene is the integrate stress scene (exercises both emit — via its
// topup — and the physics/build-active-visible hot paths every tick under heavy load).
const DECISION_TARGETS = {
  sceneKey: 'particleIntegrate',
  sceneLower: ['PARTICLE_PHYSICS_MS', 'BUILD_ACTIVE_VISIBLE_MS', 'STEP_MS'],
  workloadKey: 'ACTIVE_PARTICLES',
  comboPrimaryMs: 'PARTICLE_PHYSICS_MS',
};

// Per-hyp L1 targets — keys match particle-l1-microbench.mjs's emit_*/integrate_* cases
// (opsPerSec; higher is better for all of them).
const HYP_TARGETS = {
  P1: { l1Higher: ['integrateBuildListsOps'] },
  P2: { l1Higher: ['emitFlatOps', 'emitZenithalOps'] },
  P3: { l1Higher: ['emitZenithalOps'] }, // angleXY path isn't exercised by emitFlat/emitZenithal directly — scene-only target too.
  P4: { l1Higher: ['integrateFlatOps', 'integrateHeightedOps', 'integrateMixedOps'] },
  P5: { l1Higher: ['emitFlatOps'] },
  P6: { l1Higher: ['emitFlatOps', 'emitZenithalOps', 'emitAcquireOnlyOps'] },
};

function summarizeL1Run(micro) {
  const c = micro.cases || {};
  return {
    emitFlatOps: c.emit_emitFlat_burst?.opsPerSec ?? 0,
    emitZenithalOps: c.emit_emit_zenithal_burst?.opsPerSec ?? 0,
    emitAcquireOnlyOps: c.emit_acquire_only?.opsPerSec ?? 0,
    integrateFlatOps: c.integrate_flat_N?.opsPerSec ?? 0,
    integrateHeightedOps: c.integrate_heighted_N?.opsPerSec ?? 0,
    integrateMixedOps: c.integrate_mixed?.opsPerSec ?? 0,
    integrateBuildListsOps: c.integrate_build_lists_N?.opsPerSec ?? 0,
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
    execFileSync(process.execPath, ['--check', PATHS.particleEmitter], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', PATHS.particleIntegrate], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', PATHS.sharedAtomicPool], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', PATHS.atomicFreeList], { stdio: 'pipe' });
  }
  applyCombo(CANONICAL_ORDER);
  execFileSync(process.execPath, ['--check', PATHS.particleEmitter], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', PATHS.particleIntegrate], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', PATHS.sharedAtomicPool], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', PATHS.atomicFreeList], { stdio: 'pipe' });
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

    // Champion = best scene PARTICLE_PHYSICS_MS among accepted stacks, else winning pairs, else best single winner.
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
