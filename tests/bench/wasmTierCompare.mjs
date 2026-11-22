#!/usr/bin/env node
/**
 * Which WASM kernel benches time Liftoff code? (N-226) Each bench runs as it ships and under node --no-liftoff (every
 * WASM function compiled by TurboFan from the start), in alternating pairs, and every case's ops/s is compared. A case
 * clearly faster under --no-liftoff timed some Liftoff code, or code tiering left behind: its warm-up does not reach
 * TurboFan (wasmKernelHelpers.warmWasm does, where a bench uses it). kernelTierAudit.mjs sees this only in benches that
 * print the helpers' timing marker; this reads the numbers of any bench that writes --output JSON with cases.*.opsPerSec.
 *
 *   node tests/bench/wasmTierCompare.mjs [--pairs 2] [--threshold 5] [--output out.json] [name filters...]
 *   (no filter: every *Microbench.mjs whose source mentions wasm)
 *
 * A row reads LIFTOFF when the median pair ratio (no-liftoff / default) of a case is over 1 + threshold %, with every
 * pair agreeing in sign; FAST-DEFAULT when the default is that much faster (no-liftoff loses Liftoff's quick start
 * only in benches that time their first calls); otherwise even. Timings move with the machine's clock, hence pairs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchDir, '../..');

function parseCli(argv) {
  const opts = { pairs: 2, threshold: 5, output: null, filters: [], timeoutMs: 15 * 60 * 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pairs') opts.pairs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--threshold') opts.threshold = Number(argv[++i]);
    else if (a === '--output') opts.output = argv[++i];
    else if (a === '--timeout-min') opts.timeoutMs = Number(argv[++i]) * 60 * 1000;
    else if (a.startsWith('--')) throw new Error(`wasmTierCompare: unknown argument ${a}`);
    else opts.filters.push(a);
  }
  return opts;
}

function wasmBenches(filters) {
  return fs.readdirSync(benchDir)
    .filter((f) => f.endsWith('Microbench.mjs'))
    .filter((f) => (filters.length ? filters.some((w) => f.includes(w)) : /wasm/i.test(fs.readFileSync(path.join(benchDir, f), 'utf8'))))
    .sort();
}

/** Every case's ops/s in a bench's JSON (cases.<name>.opsPerSec, at any depth under `cases`). */
function opsOf(json) {
  const out = {};
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.opsPerSec === 'number') out[prefix] = node.opsPerSec;
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, prefix ? `${prefix}.${k}` : k);
  };
  walk(json?.cases, '');
  return out;
}

function runOnce(bench, noLiftoff, tmp, timeoutMs) {
  const out = path.join(tmp, `${bench}-${noLiftoff ? 'tf' : 'def'}.json`);
  fs.rmSync(out, { force: true });
  const args = [...(noLiftoff ? ['--no-liftoff'] : []), path.join(benchDir, bench), '--output', out];
  execFileSync(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
  return opsOf(JSON.parse(fs.readFileSync(out, 'utf8')));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

function main() {
  const opts = parseCli(process.argv.slice(2));
  const benches = wasmBenches(opts.filters);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-tier-'));
  const report = { node: process.version, pairs: opts.pairs, threshold: opts.threshold, benches: {} };
  console.log(`wasmTierCompare: ${benches.length} benches, ${opts.pairs} pairs each (default vs --no-liftoff)`);
  try {
    for (const bench of benches) {
      const ratios = {};
      let error = null;
      for (let p = 0; p < opts.pairs && !error; p++) {
        // Alternate which side runs first, so a clock that drifts through a pair does not favour one side.
        const order = p % 2 === 0 ? [false, true] : [true, false];
        const side = {};
        for (const tf of order) {
          try {
            side[tf ? 'tf' : 'def'] = runOnce(bench, tf, tmp, opts.timeoutMs);
          } catch (e) {
            error = String(e.stderr || e.message || e).split('\n').filter(Boolean).slice(-1)[0] || 'failed';
            break;
          }
        }
        if (error) break;
        for (const [name, def] of Object.entries(side.def)) {
          const tf = side.tf[name];
          if (!(def > 0) || !(tf > 0)) continue;
          (ratios[name] ||= []).push(tf / def);
        }
      }
      const cases = {};
      for (const [name, rs] of Object.entries(ratios)) {
        const m = median(rs);
        const lo = 1 + opts.threshold / 100;
        const verdict = m > lo && rs.every((r) => r > 1) ? 'LIFTOFF' : m < 1 / lo && rs.every((r) => r < 1) ? 'FAST-DEFAULT' : 'even';
        cases[name] = { ratios: rs.map((r) => Math.round(r * 1000) / 1000), median: Math.round(m * 1000) / 1000, verdict };
      }
      report.benches[bench] = error ? { error } : { cases };
      if (error) {
        console.log(`  ${bench.padEnd(44)} ERROR ${error.slice(0, 100)}`);
        continue;
      }
      const flagged = Object.entries(cases).filter(([, c]) => c.verdict !== 'even');
      const worst = Object.entries(cases).sort((a, b) => b[1].median - a[1].median)[0];
      console.log(`  ${bench.padEnd(44)} ${flagged.length ? flagged.map(([n, c]) => `${c.verdict} ${n} x${c.median}`).join('; ') : `even (max x${worst ? worst[1].median : '?'})`}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (opts.output) fs.writeFileSync(opts.output, `${JSON.stringify(report, null, 2)}\n`);
}

main();
