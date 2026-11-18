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
 *     [--scene /path/scene.js --scene-export Class] [--warmup-ms N] [--duration-ms N] [--headless] [--full-rev]
 *
 * Every arm and A run from their own worktrees (revWorktree.mjs; --pool: the fixed trees pool-a, pool-b1, pool-b2 ...).
 * Each takes src/ from its revision and the rest (demos/, stress scenes, dist/) from the runner's tree, unless
 * --full-rev checks out each whole revision. Without it, a sitting whose arm differs from the runner's tree in its
 * scene's folder (or in dist/ under weedBundle) stops and asks for --full-rev (N-278: the barrio's arms would have run
 * the runner's neighbourhood).
 * Writes tests/results/predator-abab/<name>/summary.json (all rounds) and <name>-<label>/summary.json per arm, in
 * runPredatorAbab's summary format, so `runPredatorAbab --decide-only --name <name>-<label>` re-judges one arm.
 * --arm-queries "<q1>;<q2>;...": the arms are runtime switches of one build instead of revisions (E-319: Box2D's thread
 *   count and spin): every arm runs the --vs tree with its own scene parameters on top of --query (a key the arm names
 *   replaces the shared one, as runPredatorAbab's --query-b), and --hyp-revs is left out. Separate the arms with ";".
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
import {
  decideAbab, predatorMetrics, printDecision, refuseSrcOnlyGaps, resolveScene, sideQuery,
} from './runPredatorAbab.mjs';

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
  const armQueries = typeof args['arm-queries'] === 'string' ? args['arm-queries'].split(';').map((q) => q.trim()) : null;
  if (armQueries && args['hyp-revs']) throw new Error('--arm-queries or --hyp-revs, not both');
  const revs = armQueries ? armQueries.map(() => String(args.vs))
    : String(args['hyp-revs'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!args.vs || revs.length === 0) {
    throw new Error('runMultiArm needs --vs <base rev> and --hyp-revs <rev>[,<rev>...] or --arm-queries "<q1>;<q2>"');
  }
  const labels = typeof args.labels === 'string' ? args.labels.split(',').map((s) => s.trim()) : revs.map((_, i) => `B${i + 1}`);
  if (labels.length !== revs.length || new Set(labels).size !== labels.length || labels.includes('A')) {
    throw new Error('--labels: one distinct label per arm (--hyp-revs or --arm-queries entry), not "A"');
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
  const fullRev = Boolean(args['full-rev']);
  const sides = [{ label: 'A', ...ensureRevWorktree(String(args.vs), { srcOnly: !fullRev, ...(pool ? { pool: 'a' } : {}) }) }];
  const roots = { A: sides[0].root };
  revs.forEach((rev, i) => {
    if (armQueries) {
      roots[labels[i]] = roots.A;
      return;
    }
    const side = ensureRevWorktree(rev, { tag: `b${i + 1}`, srcOnly: !fullRev, ...(pool ? { pool: `b${i + 1}` } : {}) });
    sides.push({ label: labels[i], ...side });
    roots[labels[i]] = side.root;
  });
  const queries = { A: opts.query };
  labels.forEach((label, i) => { queries[label] = armQueries ? sideQuery(opts.query, armQueries[i]) : opts.query; });
  // N-278: a srcOnly arm serves the runner's scenes and bundles, not its revision's.
  if (!fullRev) refuseSrcOnlyGaps(sides, scene, { query: Object.values(queries).join('&') });
  for (const [label, root] of Object.entries(roots)) console.log(`${label}: ${root}${armQueries ? ` ?${queries[label]}` : ''}`);
  const outDir = path.join(repoRoot, 'tests/results/predator-abab', name);
  fs.mkdirSync(outDir, { recursive: true });
  const all = ['A', ...labels];
  const rounds = [];
  for (let r = 0; r < nRounds; r++) {
    const round = {};
    for (const label of armOrder(all, r)) {
      console.log(`\n======== ${name} round ${r + 1}/${nRounds} arm ${label} ========`);
      const res = runIntegratedWithRetry(scene, path.join(outDir, `${label}-r${r}.json`), {
        ...opts, root: roots[label], query: queries[label],
      });
      if (!res.ok) throw new Error(`${label} r${r}: ${res.error}`);
      round[label] = predatorMetrics(res.report);
    }
    rounds.push(round);
  }
  const protocol = {
    ...opts, rounds: nRounds, order: 'rotated, reversed on odd rounds', vs: String(args.vs), revs, labels, fullRev,
    ...(armQueries ? { armQueries: queries } : {}),
  };
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
