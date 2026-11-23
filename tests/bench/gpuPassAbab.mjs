#!/usr/bin/env node
/**
 * gpuPassBench ABAB between two revisions (E-408): each side's src/ in a worktree (revWorktree.mjs, src only, so both
 * sides run HEAD's bench page and passes on their own shaders), gpuPassBench launched from each side's root in turn, the
 * pairs alternating which side goes first. Prints each pass's median a side and a pair, B against A, and the pairs B won.
 * A real Chrome window on the real GPU, as gpuPassBench is; one sitting at a time, the machine quiet.
 *
 *   node tests/bench/gpuPassAbab.mjs --vs main --hyp-rev HEAD --passes light3d,light --query res=0.25
 *     [--backend webgl|webgpu|both (both)] [--pairs 4] [--samples 12] [--target-ms 25] [--output path]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureRevWorktree } from './revWorktree.mjs';

function parseCli(argv) {
  const opts = { vs: null, hypRev: 'HEAD', passes: null, query: [], backend: 'both', pairs: 4, samples: 12, targetMs: 25, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`gpuPassAbab: ${a} needs a value`);
      return argv[++i];
    };
    if (a === '--vs') opts.vs = next();
    else if (a === '--hyp-rev') opts.hypRev = next();
    else if (a === '--passes') opts.passes = next();
    else if (a === '--query') opts.query.push(next());
    else if (a === '--backend') opts.backend = next();
    else if (a === '--pairs') opts.pairs = Number(next());
    else if (a === '--samples') opts.samples = Number(next());
    else if (a === '--target-ms') opts.targetMs = Number(next());
    else if (a === '--output') opts.output = next();
    else throw new Error(`gpuPassAbab: unknown argument ${a}`);
  }
  if (!opts.vs || !opts.passes) throw new Error('gpuPassAbab: --vs and --passes are required');
  if (!(opts.pairs >= 1)) throw new Error('gpuPassAbab: --pairs is a whole number from 1');
  return opts;
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One gpuPassBench run from a side's root: { 'backend pass': ms (the run's median) }. */
function runSide(side, opts, outFile) {
  const args = [path.join(side.root, 'tests/bench/gpuPassBench.mjs'), '--backend', opts.backend, '--passes', opts.passes,
    '--samples', String(opts.samples), '--target-ms', String(opts.targetMs), '--output', outFile];
  for (const q of opts.query) args.push('--query', q);
  try {
    execFileSync(process.execPath, args, { cwd: side.root, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    console.log(`gpuPassAbab: ${side.label}'s run exited ${err.status}`);
  }
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const out = {};
  for (const c of report.cases) {
    for (const [name, r] of Object.entries(c.result?.passes || {})) {
      if (r && Number.isFinite(r.median) && r.mode !== 'capacity') out[`${c.backend} ${name}`] = { ms: r.median, image: r.image ?? null };
    }
  }
  return out;
}

const opts = parseCli(process.argv.slice(2));
const sides = [
  { label: 'A', ...ensureRevWorktree(opts.vs, { tag: 'gpuA' }) },
  { label: 'B', ...ensureRevWorktree(opts.hypRev, { tag: 'gpuB' }) },
];
console.log(`A ${opts.vs} ${sides[0].sha.slice(0, 8)}  B ${opts.hypRev} ${sides[1].sha.slice(0, 8)}  ${opts.passes}  ${opts.query.join(' ')}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpuPassAbab-'));
const pairs = [];
for (let p = 0; p < opts.pairs; p++) {
  const order = p % 2 === 0 ? [sides[0], sides[1]] : [sides[1], sides[0]];
  const pair = {};
  for (const side of order) pair[side.label] = runSide(side, opts, path.join(tmp, `p${p}${side.label}.json`));
  pairs.push(pair);
  console.log(`pair ${p + 1}/${opts.pairs} (${order.map((s) => s.label).join('')}) done`);
}

const keys = [...new Set(pairs.flatMap((pr) => [...Object.keys(pr.A), ...Object.keys(pr.B)]))];
const summary = [];
for (const key of keys) {
  const a = pairs.map((pr) => pr.A[key]?.ms).filter(Number.isFinite);
  const b = pairs.map((pr) => pr.B[key]?.ms).filter(Number.isFinite);
  const ratios = pairs.filter((pr) => pr.A[key] && pr.B[key]).map((pr) => pr.B[key].ms / pr.A[key].ms);
  const wins = ratios.filter((r) => r < 1).length;
  const images = new Set(pairs.flatMap((pr) => [pr.A[key]?.image, pr.B[key]?.image]).filter(Boolean));
  const row = {
    key, a: median(a), b: median(b), ratio: median(ratios), wins, pairs: ratios.length,
    aAll: a, bAll: b, sameImage: images.size <= 1,
  };
  summary.push(row);
  console.log(`${key.padEnd(20)} A ${row.a.toFixed(3)} ms  B ${row.b.toFixed(3)} ms  B/A ${((row.ratio - 1) * 100).toFixed(1)} %  ` +
    `B faster in ${wins}/${ratios.length}  A [${a.map((x) => x.toFixed(3)).join(' ')}]  B [${b.map((x) => x.toFixed(3)).join(' ')}]` +
    `${row.sameImage ? '' : '  (images differ)'}`);
}
if (opts.output) {
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  fs.writeFileSync(path.resolve(opts.output), `${JSON.stringify({ tool: 'gpuPassAbab', opts, sides: sides.map((s) => ({ label: s.label, rev: s.rev, sha: s.sha })), pairs, summary }, null, 2)}\n`);
  console.log(`wrote ${path.resolve(opts.output)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
