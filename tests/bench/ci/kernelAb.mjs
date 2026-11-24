#!/usr/bin/env node
/**
 * The catalog's kernels, side A against side B, in this machine: both sides from worktrees, one process a run, the
 * order alternating by round (AB, BA, …), one process of each side thrown away first. `--a X --b X` is an A/A: what
 * this machine reads as a difference when there is none. Each script runs once a round and every catalog row of that
 * script reads its own key from it.
 *
 *   node tests/bench/ci/kernelAb.mjs --a <rev> --b <rev> [--rounds 5] [--only id,id] [--shard 1/4] --output file.json
 *
 * Only src/ comes from a side's revision: the kernels and the rest are this tree's (revWorktree.mjs).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { lookupPath } from '../measureLib.mjs';
import { isCli, parseArgs } from '../microbenchHelpers.mjs';
import { ensureRevWorktree, repoRoot } from '../revWorktree.mjs';
import { selectKernelRows } from '../runKernelsVsRev.mjs';

const RUN_TIMEOUT_MS = 240000;

function runOnce(root, script, out) {
  fs.rmSync(out, { force: true });
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [path.join(root, script), '--output', out], {
    cwd: root, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 << 20,
  });
  const ms = performance.now() - t0;
  if (r.error || r.status !== 0 || !fs.existsSync(out)) {
    const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' | ');
    return { ms, error: (r.error ? r.error.message : `exit ${r.status}: ${tail}`).slice(0, 600) };
  }
  return { ms, json: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rounds = Number(args.rounds ?? 5);
  const only = args.only ? String(args.only).split(',') : null;
  const byScript = new Map();
  for (const row of selectKernelRows({ only })) {
    const list = byScript.get(row.kernel.script) || [];
    list.push(row);
    byScript.set(row.kernel.script, list);
  }
  let scripts = [...byScript.keys()];
  if (args.shard) {
    const [k, n] = String(args.shard).split('/').map(Number);
    scripts = scripts.filter((_, i) => i % n === k - 1);
  }
  const sides = {
    a: ensureRevWorktree(String(args.a ?? 'HEAD'), { tag: 'a' }),
    b: ensureRevWorktree(String(args.b ?? 'HEAD'), { tag: 'b' }),
  };
  const tmp = path.join(repoRoot, 'tests/results/ci-kernels');
  fs.mkdirSync(tmp, { recursive: true });
  const rows = [];
  const t0 = performance.now();
  for (const script of scripts) {
    const name = path.basename(script, '.mjs');
    const features = byScript.get(script);
    const result = Object.fromEntries(features.map((f) => [f.id, {
      id: f.id, script, opsKey: f.kernel.opsKey, higherBetter: f.kernel.higherBetter !== false,
      informational: Boolean(f.kernel.informational), a: [], b: [],
    }]));
    let error = null;
    let runMs = 0;
    const take = (label, record) => {
      const r = runOnce(sides[label].root, script, path.join(tmp, `${name}-${label}.json`));
      runMs = Math.max(runMs, r.ms);
      if (r.error) {
        error = `${label}: ${r.error}`;
        return false;
      }
      if (record) {
        for (const f of features) {
          const v = lookupPath(r.json, f.kernel.opsKey);
          result[f.id][label].push(typeof v === 'number' && Number.isFinite(v) ? v : null);
          result[f.id][`${label}Checksum`] = r.json.checksum ?? null;
        }
      }
      return true;
    };
    let ok = take('a', false) && take('b', false);
    for (let r = 0; ok && r < rounds; r++) {
      const order = r % 2 ? ['b', 'a'] : ['a', 'b'];
      ok = take(order[0], true) && take(order[1], true);
    }
    for (const f of features) rows.push({ ...result[f.id], ...(error ? { error } : {}), runMs: Math.round(runMs) });
    console.log(`${((performance.now() - t0) / 60000).toFixed(1)} min  ${name}${error ? `  FAILED ${error}` : `  ${Math.round(runMs)} ms a run`}`);
  }
  const out = {
    kind: 'kernelAb', a: sides.a.sha, b: sides.b.sha, rounds, minutes: +((performance.now() - t0) / 60000).toFixed(1), rows,
  };
  fs.writeFileSync(path.resolve(String(args.output ?? 'kernel-ab.json')), `${JSON.stringify(out, null, 1)}\n`);
  const failed = rows.filter((r) => r.error);
  if (failed.length) console.log(`${failed.length} rows failed: ${failed.map((r) => r.id).join(', ')}`);
}

if (isCli(import.meta.url)) main();
