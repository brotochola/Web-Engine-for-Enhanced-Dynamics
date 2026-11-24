#!/usr/bin/env node
/**
 * Test files run over and over, each run a process of its own: how often each file fails on this machine.
 *
 *   node tests/bench/ci/repeatTests.mjs --threaded --times 200 --minutes 40 --output f.json
 *   node tests/bench/ci/repeatTests.mjs --files tests/node/a.test.js,tests/node/b.test.js --times 50 --output f.json
 *
 * --threaded: every file under tests/node that starts worker threads. --minutes caps the whole thing: the files take
 * turns, so all get as many runs as fit. The first three failures' output is kept.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../measureLib.mjs';
import { isCli, parseArgs } from '../microbenchHelpers.mjs';

export function threadedTestFiles() {
  const dir = path.join(repoRoot, 'tests/node');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js') && fs.readFileSync(path.join(dir, f), 'utf8').includes('worker_threads'))
    .sort()
    .map((f) => `tests/node/${f}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = args.threaded ? threadedTestFiles() : String(args.files).split(',');
  const times = Number(args.times ?? 100);
  const until = performance.now() + Number(args.minutes ?? 40) * 60000;
  const rows = new Map(files.map((f) => [f, { file: f, runs: 0, failed: 0, totalMs: 0, failures: [] }]));
  for (let i = 0; i < times && performance.now() < until; i++) {
    for (const f of files) {
      if (performance.now() >= until) break;
      const row = rows.get(f);
      const t0 = performance.now();
      const r = spawnSync(process.execPath, ['--test', f], { cwd: repoRoot, encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20 });
      row.runs++;
      row.totalMs += performance.now() - t0;
      if (r.status !== 0) {
        row.failed++;
        if (row.failures.length < 3) {
          row.failures.push((r.stdout || r.error?.message || '').split('\n').slice(-60).join('\n').slice(0, 4000));
        }
      }
    }
  }
  const out = { kind: 'repeatTests', rows: [...rows.values()].map((r) => ({ ...r, totalMs: Math.round(r.totalMs) })) };
  fs.writeFileSync(path.resolve(String(args.output ?? 'repeat-tests.json')), `${JSON.stringify(out, null, 1)}\n`);
  for (const r of out.rows) {
    console.log(`${r.failed ? 'FAIL' : 'ok  '} ${r.file}  ${r.failed}/${r.runs} failed, ${(r.totalMs / Math.max(1, r.runs) / 1000).toFixed(2)} s a run`);
  }
}

if (isCli(import.meta.url)) main();
