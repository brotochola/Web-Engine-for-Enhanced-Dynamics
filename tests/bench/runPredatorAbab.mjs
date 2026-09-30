#!/usr/bin/env node
/**
 * Product gate for one hypothesis: Predator headed, A B A B …, A = baseline
 * worktree (working tree with the hypothesis files swapped back), B = working
 * tree. Every worker kind is watched, not only the one the change touched.
 *
 *   node tests/bench/runPredatorAbab.mjs --name L1 \
 *     --override src/workers/logicWorker.js=tests/results/hyp-baselines/L1.logicWorker.js
 *   node tests/bench/runPredatorAbab.mjs --name X1 --override ... --pairs 4 --owner pixi
 *   node tests/bench/runPredatorAbab.mjs --name branch-vs-main --vs main --pairs 8
 *
 * Verdict per kind: median of the paired deltas (B−A)/A. REGRESSION if any
 * kind is ≥ +3 % and its cv is ≤ 10 % (or it is the owner kind), or a load key
 * drifts more than 5 %. KEPT (product) if the owner kind is ≤ −3 %.
 * Otherwise NEUTRAL: with a kernel win that is `kept (kernel, producto neutro)`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { median, pctDelta, writeJson } from './featureTournamentLib.mjs';
import { cv, repoRoot, runIntegratedWithRetry } from './measureLib.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { ensureOverlayWorktree, ensureRevWorktree } from './revWorktree.mjs';

export const PREDATOR_SCENE = {
  key: 'predator',
  path: '/demos/predatorScene/predatorScene.js',
  exportName: 'PredatorScene',
  headed: true,
  kind: 'gameplay',
};

const KINDS = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];
const LOAD_KEYS = ['BODY_COUNT', 'GPU_CASTERS', 'GPU_SHADOW_LIGHTS', 'ACTIVE_PARTICLES'];
// Predator emits ~100 particles: Poisson noise alone is ~10 %. Below this
// baseline the key is reported, not gated (it is not any worker's load).
const LOAD_GATE_MIN = { ACTIVE_PARTICLES: 1000 };

/** Max STEP_MS per worker kind plus the load keys. */
export function predatorMetrics(report) {
  const out = {};
  for (const kind of KINDS) out[`${kind}_STEP_MS`] = 0;
  for (const w of report.workers || []) {
    const avg = w.statsSamplesAverage || {};
    const kind = w.type === 'pixi' ? 'renderer' : w.type;
    const key = `${kind}_STEP_MS`;
    if (key in out && (avg.STEP_MS ?? 0) > out[key]) out[key] = avg.STEP_MS;
    if (kind === 'physics') out.BODY_COUNT = avg.BODY_COUNT ?? 0;
    if (kind === 'renderer') {
      out.GPU_CASTERS = avg.GPU_CASTERS ?? 0;
      out.GPU_SHADOW_LIGHTS = avg.GPU_SHADOW_LIGHTS ?? 0;
    }
    if (kind === 'particle') out.ACTIVE_PARTICLES = avg.ACTIVE_PARTICLES ?? 0;
  }
  return out;
}

function parseOverrides(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = {};
  for (const item of list) {
    const eq = String(item).indexOf('=');
    if (eq < 0) throw new Error(`--override expects rel=path, got ${item}`);
    out[item.slice(0, eq)] = path.resolve(item.slice(eq + 1));
  }
  return out;
}

export function decideAbab(pairs, owner) {
  const kinds = {};
  for (const kind of KINDS) {
    const key = `${kind}_STEP_MS`;
    const a = pairs.map((p) => p.A[key]);
    const b = pairs.map((p) => p.B[key]);
    const deltas = pairs.map((p) => pctDelta(p.B[key], p.A[key])).filter(Number.isFinite);
    kinds[kind] = {
      baseMedian: median(a),
      hypMedian: median(b),
      pairedDeltaPct: median(deltas),
      deltas,
      worseFraction: deltas.length ? deltas.filter((d) => d > 0).length / deltas.length : 0,
      cvBase: cv(a),
      cvHyp: cv(b),
    };
  }
  const load = {};
  for (const key of LOAD_KEYS) {
    const a = median(pairs.map((p) => p.A[key] ?? 0));
    const b = median(pairs.map((p) => p.B[key] ?? 0));
    load[key] = { base: a, hyp: b, deltaPct: a > 0 ? pctDelta(b, a) : null };
  }
  const reasons = [];
  for (const [key, l] of Object.entries(load)) {
    l.gated = !(l.base < (LOAD_GATE_MIN[key] ?? 0));
    if (l.gated && l.deltaPct != null && Math.abs(l.deltaPct) > 5) reasons.push(`load ${key} ${l.deltaPct.toFixed(1)}%`);
  }
  // A paired median of +3 % from 8 scattered pairs is not a regression by
  // itself: it also has to be consistent (≥ 75 % of the pairs worse).
  const CONSISTENT = 0.75;
  const regress = [];
  const noisy = [];
  for (const [kind, k] of Object.entries(kinds)) {
    if (!(k.pairedDeltaPct >= 3)) continue;
    const quiet = Math.max(k.cvBase, k.cvHyp) <= 0.1;
    const consistent = k.worseFraction >= CONSISTENT;
    const tag = `${kind} +${k.pairedDeltaPct.toFixed(1)}% (${Math.round(k.worseFraction * k.deltas.length)}/${k.deltas.length} pairs worse, cv ${(Math.max(k.cvBase, k.cvHyp) * 100).toFixed(0)}%)`;
    if (consistent && (quiet || kind === owner)) regress.push(tag);
    else noisy.push(`${tag}, not blocking`);
  }
  let verdict = 'NEUTRAL';
  const o = owner ? kinds[owner] : null;
  if (reasons.length) verdict = 'FAIL (load)';
  else if (regress.length) verdict = 'REGRESSION';
  else if (o && o.pairedDeltaPct <= -3 && 1 - o.worseFraction >= CONSISTENT) verdict = 'KEPT (product)';
  return { verdict, owner, kinds, load, reasons, regress, noisy };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawOverrides = process.argv.flatMap((a, i, all) => (a === '--override' && all[i + 1] ? [all[i + 1]] : []));
  const name = String(args.name || 'hyp');
  const owner = args.owner ? String(args.owner) : null;
  const nPairs = Number(args.pairs ?? 4);
  const opts = {
    headed: true,
    detailedStats: false,
    warmupMs: Number(args['warmup-ms'] ?? DEFAULT_WARMUP_MS),
    durationMs: Number(args['duration-ms'] ?? DEFAULT_DURATION_MS),
    query: typeof args.query === 'string' ? args.query : '',
  };
  const outDir = path.join(repoRoot, 'tests/results/predator-abab', name);
  fs.mkdirSync(outDir, { recursive: true });
  const summaryPath = path.join(outDir, 'summary.json');
  if (args['decide-only']) {
    const prev = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    prev.decision = decideAbab(prev.pairs, owner ?? prev.owner);
    writeJson(summaryPath, prev);
    printDecision(name, prev.decision);
    return;
  }
  // --vs <rev>: A = src/ from that revision, everything else from the working tree.
  const baseline = args.vs
    ? ensureRevWorktree(String(args.vs))
    : ensureOverlayWorktree(name, parseOverrides(rawOverrides));
  console.log(`baseline worktree ${baseline.root}`);
  // --append: add pairs to the previous sitting of the same hypothesis.
  const pairs = args.append && fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')).pairs : [];
  const first = pairs.length;
  for (let p = first; p < first + nPairs; p++) {
    const pair = {};
    // Counterbalanced: odd pairs run B first, so drift inside a pair
    // (heat, background) does not always land on the same side.
    const order = p % 2 === 0 ? [['A', baseline.root], ['B', repoRoot]] : [['B', repoRoot], ['A', baseline.root]];
    for (const [side, root] of order) {
      console.log(`\n======== ${name} pair ${p + 1}/${first + nPairs} side ${side} ========`);
      const res = runIntegratedWithRetry(PREDATOR_SCENE, path.join(outDir, `${side}-p${p}.json`), { ...opts, root });
      if (!res.ok) throw new Error(`${side} p${p}: ${res.error}`);
      pair[side] = predatorMetrics(res.report);
    }
    pairs.push(pair);
  }
  const decision = decideAbab(pairs, owner);
  const summary = {
    name,
    owner,
    protocol: { ...opts, pairs: pairs.length, order: 'AB BA AB BA', seed: 123456 },
    vs: args.vs ? { rev: String(args.vs), sha: baseline.sha } : null,
    overrides: baseline.overrides ?? null,
    pairs,
    decision,
  };
  writeJson(summaryPath, summary);
  printDecision(name, decision);
}

function printDecision(name, decision) {
  console.log(`\n======== ${name}: ${decision.verdict} ========`);
  for (const [kind, k] of Object.entries(decision.kinds)) {
    console.log(
      `${kind.padEnd(10)} ${k.baseMedian.toFixed(3)} → ${k.hypMedian.toFixed(3)} ms  paired ${k.pairedDeltaPct >= 0 ? '+' : ''}${k.pairedDeltaPct.toFixed(1)}%  worse ${Math.round(k.worseFraction * k.deltas.length)}/${k.deltas.length}  cv ${(k.cvBase * 100).toFixed(0)}/${(k.cvHyp * 100).toFixed(0)}%`
    );
  }
  for (const [key, l] of Object.entries(decision.load)) {
    console.log(`${key.padEnd(18)} ${l.base.toFixed(1)} → ${l.hyp.toFixed(1)} (${l.deltaPct == null ? 'n/a' : l.deltaPct.toFixed(1) + '%'})${l.gated ? '' : ' (reported, not gated)'}`);
  }
  for (const r of [...decision.reasons, ...decision.regress, ...decision.noisy]) console.log(`- ${r}`);
}

if (isCli(import.meta.url)) await main();
