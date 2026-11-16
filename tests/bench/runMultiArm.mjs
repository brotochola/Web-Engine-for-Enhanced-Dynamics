#!/usr/bin/env node
/**
 * N-239: one sitting for several changes judged in the same scene and query. Each round runs the base (A) and every
 * hypothesis arm (B1, B2, ...) once, in an order rotated from round to round and reversed on odd rounds, so no arm is
 * always first or always next to A; then each arm is judged against the same A runs with runPredatorAbab's rules
 * (decideAbab: its pairs are round r's A and round r's arm). An ABAB sitting per change measures main again each time;
 * here k changes cost (k + 1) runs a round instead of 2k.
 *
 *   node tests/bench/runMultiArm.mjs --name batch1 --vs main --hyp-revs <rev1>,<rev2> [--labels e471,e476] \
 *     [--owner spatial | --owners spatial,logic] [--pairs 4] [--query "crowd=2.5&zoom=0.216"] [--pool]
 *     [--scene /path/scene.js --scene-export Class] [--warmup-ms N] [--duration-ms N] [--headless]
 *
 * Every arm and A run from their own worktrees (revWorktree.mjs; --pool: the fixed trees pool-a, pool-b1, pool-b2 ...).
 * Writes tests/results/predator-abab/<name>/summary.json (all rounds) and <name>-<label>/summary.json per arm, in
 * runPredatorAbab's summary format, so `runPredatorAbab --decide-only --name <name>-<label>` re-judges one arm.
 * No --append, --early or --hyp probes here: they stay ABAB's. Keep arms to three or four: the more arms, the farther
 * an arm's run from A's within a round.
 * From Git Bash set MSYS_NO_PATHCONV=1 for /demos/... paths. There is no --help: read this comment.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { writeJson } from './featureTournamentLib.mjs';
import { repoRoot, runIntegratedWithRetry } from './measureLib.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { ensureRevWorktree } from './revWorktree.mjs';
import { decideAbab, predatorMetrics, printDecision, resolveScene } from './runPredatorAbab.mjs';

/**
 * The order of the arms in round `round`: `labels` rotated by the round, reversed on odd rounds.
 * @param {string[]} labels 'A' and the arms' labels
 * @param {number} round
 * @returns {string[]}
 */
export function armOrder(labels, round) {
  const n = labels.length;
  const shift = round % n;
  const rotated = labels.slice(shift).concat(labels.slice(0, shift));
  return round % 2 === 1 ? rotated.reverse() : rotated;
}

/**
 * One arm's pairs for decideAbab: each round's A against the same round's arm.
 * @param {Array<Record<string, object>>} rounds each round's metrics by label
 * @param {string} label
 */
export function armPairs(rounds, label) {
  return rounds.filter((r) => r.A && r[label]).map((r) => ({ A: r.A, B: r[label] }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = String(args.name || 'multi');
  const revs = String(args['hyp-revs'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!args.vs || revs.length === 0) throw new Error('runMultiArm needs --vs <base rev> and --hyp-revs <rev>[,<rev>...]');
  const labels = typeof args.labels === 'string' ? args.labels.split(',').map((s) => s.trim()) : revs.map((_, i) => `B${i + 1}`);
  if (labels.length !== revs.length || new Set(labels).size !== labels.length || labels.includes('A')) {
    throw new Error('--labels: one distinct label per --hyp-revs entry, not "A"');
  }
  const owners = typeof args.owners === 'string' ? args.owners.split(',').map((s) => s.trim())
    : revs.map(() => (args.owner ? String(args.owner) : null));
  if (owners.length !== revs.length) throw new Error('--owners: one owner per --hyp-revs entry');
  const nRounds = Number(args.pairs ?? 4);
  const scene = resolveScene(args);
  const opts = {
    headed: !args.headless,
    detailedStats: false,
    warmupMs: Number(args['warmup-ms'] ?? DEFAULT_WARMUP_MS),
    durationMs: Number(args['duration-ms'] ?? DEFAULT_DURATION_MS),
    query: typeof args.query === 'string' ? args.query : '',
    extraArgs: [],
  };
  const pool = Boolean(args.pool);
  const roots = { A: ensureRevWorktree(String(args.vs), { srcOnly: true, ...(pool ? { pool: 'a' } : {}) }).root };
  revs.forEach((rev, i) => {
    roots[labels[i]] = ensureRevWorktree(rev, { tag: `b${i + 1}`, srcOnly: true, ...(pool ? { pool: `b${i + 1}` } : {}) }).root;
  });
  for (const [label, root] of Object.entries(roots)) console.log(`${label}: ${root}`);
  const outDir = path.join(repoRoot, 'tests/results/predator-abab', name);
  fs.mkdirSync(outDir, { recursive: true });
  const all = ['A', ...labels];
  const rounds = [];
  for (let r = 0; r < nRounds; r++) {
    const round = {};
    for (const label of armOrder(all, r)) {
      console.log(`\n======== ${name} round ${r + 1}/${nRounds} arm ${label} ========`);
      const res = runIntegratedWithRetry(scene, path.join(outDir, `${label}-r${r}.json`), { ...opts, root: roots[label] });
      if (!res.ok) throw new Error(`${label} r${r}: ${res.error}`);
      round[label] = predatorMetrics(res.report);
    }
    rounds.push(round);
  }
  const protocol = { ...opts, rounds: nRounds, order: 'rotated, reversed on odd rounds', vs: String(args.vs), revs, labels };
  const decisions = {};
  labels.forEach((label, i) => {
    const pairs = armPairs(rounds, label);
    const decision = decideAbab(pairs, owners[i]);
    decisions[label] = decision;
    const armDir = path.join(repoRoot, 'tests/results/predator-abab', `${name}-${label}`);
    fs.mkdirSync(armDir, { recursive: true });
    writeJson(path.join(armDir, 'summary.json'), {
      name: `${name}-${label}`, owner: owners[i], multiArm: name, hypRev: revs[i],
      protocol: { ...protocol, pairs: pairs.length }, pairs, decision,
    });
    printDecision(`${name} ${label} (${revs[i]})`, decision);
  });
  writeJson(path.join(outDir, 'summary.json'), { name, protocol, owners, rounds, decisions });
}

if (isCli(import.meta.url)) await main();
