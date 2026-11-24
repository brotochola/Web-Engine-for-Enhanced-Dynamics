#!/usr/bin/env node
/**
 * Every Node kernel of tests/bench (…Microbench.mjs, …Kernel.mjs) run once with its defaults: which ones still run, and
 * how long each takes. A kernel nobody runs rots quietly (three of the catalog's 42 scripts had, 2026-11-24).
 *
 *   node tests/bench/ci/kernelSmoke.mjs [--only a,b] [--timeout-s 120] [--shard 1/2] --output file.json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isCli, parseArgs } from '../microbenchHelpers.mjs';
import { repoRoot } from '../revWorktree.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.join(repoRoot, 'tests/bench');
  let files = fs.readdirSync(dir).filter((f) => /(Microbench|Kernel)\.mjs$/.test(f)).sort();
  if (args.only) files = files.filter((f) => String(args.only).split(',').includes(f.replace('.mjs', '')));
  if (args.shard) {
    const [k, n] = String(args.shard).split('/').map(Number);
    files = files.filter((_, i) => i % n === k - 1);
  }
  const out = { kind: 'kernelSmoke', rows: [] };
  for (const file of files) {
    const t0 = performance.now();
    const report = path.join(os.tmpdir(), `smoke-${file}.json`);
    const r = spawnSync(process.execPath, [path.join(dir, file), '--output', report], {
      cwd: repoRoot, encoding: 'utf8', timeout: Number(args['timeout-s'] ?? 120) * 1000, maxBuffer: 64 << 20,
    });
    const seconds = +((performance.now() - t0) / 1000).toFixed(1);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const error = r.error ? r.error.message : r.status === 0 ? null
      : (/^.*(?:Error|error|usage).*$/m.exec(text)?.[0] || text.trim().split('\n').slice(-2).join(' | ')).trim().slice(0, 300);
    out.rows.push({ kernel: file.replace('.mjs', ''), status: r.status ?? r.signal, seconds, ...(error ? { error } : {}) });
    console.log(`${error ? 'FAIL' : 'ok  '} ${file} ${seconds} s${error ? `  ${error}` : ''}`);
    fs.rmSync(report, { force: true });
  }
  fs.writeFileSync(path.resolve(String(args.output ?? 'kernel-smoke.json')), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${out.rows.filter((x) => !x.error).length} of ${out.rows.length} kernels ran`);
}

if (isCli(import.meta.url)) main();
