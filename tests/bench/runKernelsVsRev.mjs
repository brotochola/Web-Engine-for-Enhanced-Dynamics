#!/usr/bin/env node
/**
 * Kernel dump for every catalog row that has a kernel, optionally versus a git rev.
 *
 *   node tests/bench/runKernelsVsRev.mjs                     # dump the working tree
 *   node tests/bench/runKernelsVsRev.mjs --vs HEAD           # working tree vs HEAD
 *   node tests/bench/runKernelsVsRev.mjs --vs main --only emit,spatial
 *   node tests/bench/runKernelsVsRev.mjs --vs HEAD --changed # rows whose module the diff touches
 *
 * The baseline runs from a worktree (revWorktree.mjs): only src/ comes from
 * the rev, the kernel scripts are the working tree's. Nothing writes the
 * working tree.
 *
 * Each side: one discarded warmup process, then the timed rounds (--rounds,
 * default 5 with a baseline, 1 for a plain dump; order alternates per round,
 * median per side). The warmup JSON is the preflight: if any row's opsKey is
 * not a finite number there, the run stops before the timed pass. No fallback
 * to some other case.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ENGINE_FEATURES } from './engineFeatureCatalog.mjs';
import { pctDelta, writeJson } from './featureTournamentLib.mjs';
import { lookupPath, repoRoot, SPEED_PCT } from './measureLib.mjs';
import { isCli } from './microbenchHelpers.mjs';
import { ensureOverlayWorktree, ensureRevWorktree } from './revWorktree.mjs';

const outRoot = path.join(repoRoot, 'tests/results/kernels');

function parseArgs(argv) {
  const out = { vs: null, only: null, changed: false, skipWarm: false, overlay: null, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vs' && argv[i + 1]) out.vs = String(argv[++i]);
    else if (a === '--only' && argv[i + 1]) out.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--changed') out.changed = true;
    else if (a === '--skip-warm') out.skipWarm = true;
    else if (a === '--rounds' && argv[i + 1]) out.rounds = Math.max(1, Number(argv[++i]));
    else if (a === '--overlay' && argv[i + 1]) out.overlay = String(argv[++i]);
    else if (a === '--override' && argv[i + 1]) {
      const item = String(argv[++i]);
      const eq = item.indexOf('=');
      out.overrides[item.slice(0, eq)] = path.resolve(item.slice(eq + 1));
    }
  }
  return out;
}

function changedFiles(vs) {
  const diff = execFileSync('git', ['diff', '--name-only', vs], { cwd: repoRoot, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' });
  return new Set(
    `${diff}\n${untracked}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  );
}

export function selectKernelRows({ only, changed, vs }) {
  let rows = ENGINE_FEATURES.filter((f) => f.kernel);
  if (only?.length) {
    const want = new Set(only);
    rows = rows.filter((f) => want.has(f.id));
  }
  if (changed) {
    const files = changedFiles(vs || 'HEAD');
    rows = rows.filter((f) => {
      const mods = [f.module, ...(f.kernel.touches || [])];
      return mods.some((m) => files.has(m)) || files.has(f.kernel.script);
    });
  }
  return rows;
}

function runScript(root, script, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(process.execPath, [path.join(root, script), '--output', outPath], {
    cwd: root,
    stdio: 'inherit',
  });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

function opsOf(json, feature) {
  const v = lookupPath(json, feature.kernel.opsKey);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function preflight(sides, rows, skipWarm) {
  const missing = [];
  for (const side of sides) {
    for (const feature of rows) {
      const out = path.join(outRoot, side.label, `${feature.id}-warm.json`);
      console.log(`\n[warm ${side.label}] ${feature.id} ← ${feature.kernel.script}`);
      let json = null;
      try {
        json = skipWarm && fs.existsSync(out)
          ? JSON.parse(fs.readFileSync(out, 'utf8'))
          : runScript(side.root, feature.kernel.script, out);
      } catch (e) {
        missing.push(`${side.label} ${feature.id}: script failed (${e.message || e})`);
        continue;
      }
      if (opsOf(json, feature) == null) {
        missing.push(`${side.label} ${feature.id}: no finite number at ${feature.kernel.opsKey}`);
      }
    }
  }
  return missing;
}

/**
 * Share of (KEEP round, BASE round) comparisons KEEP wins, in the better
 * direction. 5 vs 5 rounds of the same code reach ≥ 0.9 about 1.6 % of the time.
 */
export function roundsWinFraction(baseRounds, hypRounds, higherBetter = true) {
  let wins = 0;
  for (const h of hypRounds) for (const b of baseRounds) if (higherBetter ? h > b : h < b) wins++;
  return wins / (hypRounds.length * baseRounds.length);
}

const ROUNDS_CONSISTENT = 0.9;

export function verdictFor(feature, baseOps, hypOps, baseRounds = [baseOps], hypRounds = [hypOps]) {
  if (feature.kernel.informational) return 'INFO';
  const d = pctDelta(hypOps, baseOps);
  if (d == null) return 'FAIL';
  const higherBetter = feature.kernel.higherBetter !== false;
  const frac = roundsWinFraction(baseRounds, hypRounds, higherBetter);
  const win = (higherBetter ? d >= SPEED_PCT : d <= -SPEED_PCT) && frac >= ROUNDS_CONSISTENT;
  const lose = (higherBetter ? d <= -SPEED_PCT : d >= SPEED_PCT) && frac <= 1 - ROUNDS_CONSISTENT;
  return lose ? 'WORSE' : win ? 'KEPT' : 'TIE';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = selectKernelRows(args);
  if (!rows.length) {
    console.error('No kernel rows selected.');
    process.exit(1);
  }
  const sides = [{ label: 'KEEP', root: repoRoot }];
  let baseline = null;
  if (args.overlay) {
    // Gate 4: same kernel against the working tree with the hypothesis files swapped back.
    baseline = { ...ensureOverlayWorktree(args.overlay, args.overrides), sha: `overlay:${args.overlay}` };
    console.log(`baseline worktree ${baseline.root} (working tree minus ${Object.keys(args.overrides).join(', ')})`);
    sides.unshift({ label: 'BASE', root: baseline.root });
  } else if (args.vs) {
    baseline = ensureRevWorktree(args.vs);
    console.log(`baseline worktree ${baseline.root} (${baseline.sha.slice(0, 8)})`);
    sides.unshift({ label: 'BASE', root: baseline.root });
  }

  const missing = preflight(sides, rows, args.skipWarm);
  if (missing.length) {
    console.error('\nPreflight failed. Fix the kernel or its catalog opsKey:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  const results = [];
  for (const feature of rows) {
    const row = {
      id: feature.id,
      module: feature.module,
      script: feature.kernel.script,
      opsKey: feature.kernel.opsKey,
      higherBetter: feature.kernel.higherBetter !== false,
      informational: Boolean(feature.kernel.informational),
    };
    // One process per side is not enough: the same code moves ~±6 % between
    // processes (gpuQueuePack). Alternate the order each round, keep the median.
    const rounds = args.rounds ?? (baseline ? 5 : 1);
    const perSide = { BASE: [], KEEP: [] };
    for (let r = 0; r < rounds; r++) {
      const order = r % 2 ? [...sides].reverse() : sides;
      for (const side of order) {
        console.log(`\n[timed ${side.label} ${r + 1}/${rounds}] ${feature.id}`);
        const json = runScript(side.root, feature.kernel.script, path.join(outRoot, side.label, `${feature.id}.json`));
        perSide[side.label].push(opsOf(json, feature));
        row[side.label === 'BASE' ? 'baseChecksum' : 'checksum'] = json.checksum ?? null;
      }
    }
    for (const [label, key] of [['BASE', 'baseOps'], ['KEEP', 'ops']]) {
      const vals = perSide[label];
      if (!vals.length) continue;
      row[`${key}Rounds`] = vals;
      row[key] = vals.includes(null) ? null : [...vals].sort((a, b) => a - b)[vals.length >> 1];
    }
    if (baseline) {
      row.deltaPct = pctDelta(row.ops, row.baseOps);
      if (row.ops != null && row.baseOps != null) {
        row.roundsWinFraction = roundsWinFraction(row.baseOpsRounds, row.opsRounds, row.higherBetter);
      }
      row.verdict = verdictFor(feature, row.baseOps, row.ops, row.baseOpsRounds, row.opsRounds);
      // Same kernel, same seed: a different checksum means the change altered the output.
      if (row.checksum != null && row.baseChecksum != null && row.checksum !== row.baseChecksum) {
        row.verdict = 'CHECKSUM';
      }
    }
    results.push(row);
  }

  const nulls = results.filter((r) => r.ops == null || (baseline && r.baseOps == null));
  const summary = {
    vs: args.overlay ? `overlay:${args.overlay}` : args.vs,
    baselineSha: baseline?.sha ?? null,
    protocol: 'warmup process discarded, then timed rounds (order alternates, median per side); baseline = worktree with src/ from --vs',
    rows: results,
    nulls: nulls.map((r) => r.id),
    finishedAt: new Date().toISOString(),
  };
  writeJson(path.join(outRoot, baseline ? 'vs-summary.json' : 'kernels-dump.json'), summary);

  console.log('\n======== kernels ========');
  for (const r of results) {
    const fmt = (v) => (v == null ? 'null' : r.higherBetter ? v.toFixed(0) : v.toFixed(3));
    const tail = baseline
      ? `${fmt(r.baseOps)} → ${fmt(r.ops)} (${r.deltaPct == null ? 'n/a' : `${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`}` +
        `${r.roundsWinFraction == null ? '' : `, rounds won ${Math.round(r.roundsWinFraction * 100)}%`}) ${r.verdict}`
      : fmt(r.ops);
    console.log(`${r.id.padEnd(16)} ${r.opsKey.padEnd(40)} ${tail}`);
  }
  const worse = results.filter((r) => r.verdict === 'WORSE' || r.verdict === 'CHECKSUM');
  if (nulls.length || worse.length) process.exitCode = 1;
}

if (isCli(import.meta.url)) main();
