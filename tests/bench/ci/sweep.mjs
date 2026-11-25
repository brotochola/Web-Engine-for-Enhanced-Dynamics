#!/usr/bin/env node
/**
 * A list of old verdicts measured again on this machine (DX-CI, phase 2). The plan is the `plan` field of a JSON file
 * (the request itself: --plan ci-request.json), one entry a comparison:
 *
 *   { "id": "E-338", "type": "commit", "commit": "<full sha>", "kernel": "tests/bench/painterRadixWasmMicrobench.mjs", "args": "" }
 *     the kernel as it was at that commit, src/ from the commit's parent (A) against the commit's own (B)
 *   { "id": "simd decalStamp", "type": "variant", "kernel": "tests/bench/decalStampWasmMicrobench.mjs", "variants": ["js", "wasm"] }
 *     this tree's kernel, --variant of the first (A) against each other one (B)
 *   { "id": "setter", "type": "dump", "kernel": "tests/bench/setterMicrobench.mjs" }
 *     this tree's kernel alone: its rates (a kernel's cases against each other, on this machine)
 *   A plan of "dumpAll" in place of the list: every Node kernel of tests/bench, each a dump.
 *   A plan of { "revs": { "a": "<full sha>", "b": "<full sha>" } }: every Node kernel that reaches the engine, src/ of revision a against src/ of b
 *   (two releases, say), with the variant the engine ships (shipped.mjs). The kernels are b's; one that does not run on
 *   both sides is tried as it was at a; one that runs on neither way is a row with its error.
 *
 *   node tests/bench/ci/sweep.mjs --plan ci-request.json [--rounds 5] [--shard 1/4] --output file.json
 *
 * One process a run, one of each side thrown away first, the order alternating by round. Every rate in a kernel's report
 * is compared (opsPerSec, higher is better; ns, us or ms per something, lower is better): a change moves the ones that
 * run it and the others say what this machine's noise is.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isCli, parseArgs } from '../microbenchHelpers.mjs';
import { repoRoot } from '../revWorktree.mjs';
import { reachesEngine, shippedArgs } from './shipped.mjs';

const RUN_TIMEOUT_MS = 120000;
const PARTS = ['src', 'tests', 'wasm', 'scripts', 'demos/tests', 'demos/**/*.js', 'demos/**/*.json', 'package.json'];
const treesDir = path.join(path.dirname(repoRoot), 'weed-sweep');

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A sparse worktree that moves from commit to commit (src, tests, wasm and scripts alone). */
function tree(name) {
  const root = path.join(treesDir, name);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(treesDir, { recursive: true });
    git(['worktree', 'add', '--no-checkout', '--detach', root, 'HEAD']);
    git(['sparse-checkout', 'set', '--no-cone', ...PARTS.map((p) => `/${p}`)], root);
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  }
  return root;
}

/**
 * Off a VM: the trees away. Their node_modules is a link to this tree's, and a removal follows it and empties that
 * (2026-11-24, this tool's first run): the link goes first, by itself, and nothing is removed while one is there.
 */
function removeTrees() {
  for (const name of ['a', 'b']) {
    const root = path.join(treesDir, name);
    if (!fs.existsSync(root)) continue;
    const link = path.join(root, 'node_modules');
    if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link);
    if (fs.existsSync(link)) throw new Error(`${link} is still there: nothing removed`);
    git(['worktree', 'remove', '--force', root]);
  }
  fs.rmSync(treesDir, { recursive: true, force: true });
}

/** Both sides of a commit: the whole of it, with src/ from its parent on side A. */
function checkoutCommit(sides, commit) {
  try {
    git(['cat-file', '-e', `${commit}^^{tree}`]);
  } catch {
    git(['fetch', '-q', '--depth=2', '--filter=blob:none', 'origin', commit]);
  }
  for (const root of [sides.a, sides.b]) {
    git(['checkout', '-q', '-f', '--detach', commit], root);
    git(['clean', '-fdq', '-e', 'node_modules'], root);
  }
  git(['restore', '-q', `--source=${commit}^`, '--worktree', '--', 'src'], sides.a);
}

/** Both sides' whole tree at `rev`, with src/ from revision a on side a and from b on side b. */
function checkoutRevs(sides, rev, a, b) {
  for (const sha of [rev, a, b]) {
    try {
      git(['cat-file', '-e', `${sha}^{tree}`]);
    } catch {
      git(['fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', sha]);
    }
  }
  for (const [root, src] of [[sides.a, a], [sides.b, b]]) {
    git(['checkout', '-q', '-f', '--detach', rev], root);
    git(['clean', '-fdq', '-e', 'node_modules'], root);
    if (src !== rev) git(['restore', '-q', `--source=${src}`, '--worktree', '--', 'src'], root);
  }
}

/** The Node kernels of `root`'s tests/bench, by file name. */
function kernelFiles(root) {
  return fs.readdirSync(path.join(root, 'tests/bench')).filter((f) => /(Microbench|Kernel)\.mjs$/.test(f) && f !== 'chromeKernel.mjs').sort();
}

/** Two revisions: every kernel with b's tests, those that fail there with a's (`at`: whose tests ran it). */
function revsSweep({ a, b }, { only, shard, rounds, tmp, done }) {
  const sides = { a: tree('a'), b: tree('b') };
  let list = null;
  for (const [at, rev] of [['b', b], ['a', a]]) {
    checkoutRevs(sides, rev, a, b);
    if (list === null) {
      const engine = (file) => reachesEngine(pathToFileURL(path.join(sides.b, 'tests/bench', file)));
      list = kernelFiles(sides.b).filter(engine).flatMap((file) => shippedArgs(file).map((args) => ({ file, args })));
      if (only) list = list.filter((k) => only.some((name) => k.file.startsWith(name)));
      if (shard) list = list.filter((_, i) => i % shard[1] === shard[0] - 1);
    }
    const again = [];
    for (const k of list) {
      if (!fs.existsSync(path.join(sides.a, 'tests/bench', k.file))) {
        done({ ...k.failed, label: k.failed.label, type: 'revs' });
        continue;
      }
      const name = k.file.replace(/(Microbench|Kernel)\.mjs$/, '');
      const words = k.args ? k.args.split(' ') : [];
      const row = compare(k.args ? `${name} ${words.slice(1).join(' ')}` : name, { root: sides.a, args: words }, { root: sides.b, args: words },
        `tests/bench/${k.file}`, rounds, tmp);
      row.type = 'revs';
      row.testsAt = at;
      if (!row.error) done(row);
      else if (at === 'b') again.push({ ...k, failed: row });
      else done({ ...row, error: `${k.failed.error} || as it was at a: ${row.error}` });
    }
    list = again;
    if (list.length === 0 || a === b) break;
  }
  for (const k of a === b ? list : []) done(k.failed);
}

/**
 * Every rate of a report, by its place: { 'cases.x.opsPerSec': { v, higher } }. A report with none of them (a frame's `ms`
 * is all it gives) is read by its `ms`.
 */
export function ratesOf(report) {
  const out = walk(report, '', {}, false);
  return Object.keys(out).length ? out : walk(report, '', {}, true);
}

function walk(report, at, out, byMs) {
  if (report === null || typeof report !== 'object') return out;
  for (const [key, value] of Object.entries(report)) {
    const place = at ? `${at}.${key}` : key;
    if (typeof value === 'number') {
      if (!(value > 0) || !Number.isFinite(value)) continue;
      if (byMs) {
        if (key === 'ms') out[place] = { v: value, higher: false };
      } else if (/^(ops(PerSec|PerSecond)?|perSec|opsPerSecond)$/i.test(key) || /PerSec(ond)?$/.test(key)) out[place] = { v: value, higher: true };
      else if (/^(ns|us|ms)Per[A-Z]/.test(key) || /(Ns|Us)$/.test(key) || /^(nsPerOp|ns|medianMs|msMedian)$/.test(key)) out[place] = { v: value, higher: false };
    } else if (!/machine|config|options|samples|raw/i.test(key)) {
      walk(value, place, out, byMs);
    }
  }
  return out;
}

function runOnce(root, kernel, extra, out) {
  fs.rmSync(out, { force: true });
  const r = spawnSync(process.execPath, ['--expose-gc', path.join(root, kernel), '--output', out, ...extra], {
    cwd: root, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 << 20,
  });
  if (r.error || r.status !== 0 || !fs.existsSync(out)) {
    const text = `${r.stderr || ''}\n${r.stdout || ''}`;
    const line = /^.*(?:Error|error:).*$/m.exec(text)?.[0] || text.trim().split('\n').slice(-1)[0] || '';
    return { error: (r.error ? r.error.message : `exit ${r.status}: ${line}`).slice(0, 240) };
  }
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { rates: ratesOf(json), checksum: json.checksum ?? null };
}

/** One kernel's rates over `rounds` processes, the first thrown away. */
function dump(label, side, kernel, rounds, tmp) {
  const row = { label, kernel: path.basename(kernel, '.mjs'), metrics: {} };
  const t0 = performance.now();
  for (let r = -1; r < rounds; r++) {
    const got = runOnce(side.root, kernel, side.args, path.join(tmp, 'dump.json'));
    if (got.error) {
      row.error = got.error;
      break;
    }
    if (r < 0) continue;
    for (const [place, m] of Object.entries(got.rates)) {
      const kept = (row.metrics[place] ??= { higher: m.higher, v: [] });
      kept.v.push(+m.v.toPrecision(5));
    }
  }
  row.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  return row;
}

function compare(label, a, b, kernel, rounds, tmp) {
  const row = { label, kernel: path.basename(kernel, '.mjs'), metrics: {} };
  const t0 = performance.now();
  const keep = { a: [], b: [] };
  for (let r = -1; r < rounds; r++) {
    for (const side of r % 2 === 0 ? ['a', 'b'] : ['b', 'a']) {
      const s = side === 'a' ? a : b;
      const got = runOnce(s.root, kernel, s.args, path.join(tmp, `${side}.json`));
      if (got.error) {
        row.error = `${side}: ${got.error}`;
        row.seconds = +((performance.now() - t0) / 1000).toFixed(1);
        return row;
      }
      if (r >= 0) keep[side].push(got);
    }
  }
  row.checksumsAgree = keep.a[0].checksum === keep.b[0].checksum;
  for (const place of Object.keys(keep.a[0].rates)) {
    const of = (list) => list.map((x) => x.rates[place]?.v ?? null);
    const va = of(keep.a);
    const vb = of(keep.b);
    if (va.includes(null) || vb.includes(null)) continue;
    const r4 = (v) => +v.toPrecision(5);
    row.metrics[place] = { higher: keep.a[0].rates[place].higher, a: va.map(r4), b: vb.map(r4) };
  }
  row.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  return row;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rounds = Number(args.rounds ?? 5);
  let plan = JSON.parse(fs.readFileSync(path.resolve(String(args.plan ?? 'ci-request.json')), 'utf8')).plan;
  if (plan === 'dumpAll') {
    plan = fs.readdirSync(path.join(repoRoot, 'tests/bench')).filter((f) => /(Microbench|Kernel)\.mjs$/.test(f) && f !== 'chromeKernel.mjs').sort()
      .map((f) => ({ id: f.replace(/(Microbench|Kernel)\.mjs$/, ''), type: 'dump', kernel: `tests/bench/${f}` }));
  }
  const revs = !Array.isArray(plan) && plan?.revs;
  if (revs) plan = [];
  if (args.type) plan = plan.filter((e) => e.type === args.type);
  if (args.shard) {
    const [k, n] = String(args.shard).split('/').map(Number);
    plan = plan.filter((_, i) => i % n === k - 1);
  }
  const tmp = path.join(repoRoot, 'tests/results/ci-sweep');
  fs.mkdirSync(tmp, { recursive: true });
  const out = { kind: 'sweep', rounds, rows: [] };
  const write = () => fs.writeFileSync(path.resolve(String(args.output ?? 'sweep.json')), `${JSON.stringify(out)}\n`);
  const t0 = performance.now();
  const words = (text) => (typeof text === 'string' && text ? text.split(' ') : []);
  if (revs) {
    Object.assign(out, { a: revs.a, b: revs.b });
    revsSweep(revs, {
      only: args.only ? String(args.only).split(',') : null, shard: args.shard ? String(args.shard).split('/').map(Number) : null, rounds, tmp,
      done: (row) => {
        out.rows.push(row);
        console.log(`${((performance.now() - t0) / 60000).toFixed(1)} min  ${row.label} ${row.error ? `FAILED ${row.error.slice(0, 160)}` : `${Object.keys(row.metrics).length} rates, ${row.seconds} s${row.testsAt === 'a' ? ' (the kernel of a)' : ''}`}`);
        write();
      },
    });
  }
  // Kernels of one commit in a row: a checkout serves them all.
  const ordered = [...plan].sort((x, y) => String(x.commit || '').localeCompare(String(y.commit || '')));
  let sides = null;
  let at = null;
  for (const entry of ordered) {
    let rows = [];
    try {
      if (entry.type === 'commit') {
        sides ??= { a: tree('a'), b: tree('b') };
        if (at !== entry.commit) {
          checkoutCommit(sides, entry.commit);
          at = entry.commit;
        }
        const extra = words(entry.args);
        rows = [compare(entry.id, { root: sides.a, args: extra }, { root: sides.b, args: extra }, entry.kernel, rounds, tmp)];
        rows[0].commit = entry.commit.slice(0, 8);
      } else if (entry.type === 'dump') {
        rows = [dump(entry.id, { root: repoRoot, args: words(entry.args) }, entry.kernel, rounds, tmp)];
      } else {
        const [base, ...others] = entry.variants;
        const side = (v) => ({ root: repoRoot, args: ['--variant', v, ...words(entry.args)] });
        rows = others.map((v) => compare(`${entry.id} ${base}>${v}`, side(base), side(v), entry.kernel, rounds, tmp));
      }
    } catch (e) {
      rows = [{ label: entry.id, kernel: path.basename(entry.kernel, '.mjs'), metrics: {}, error: `${String(e.stderr || e.message).trim().split('\n').slice(-2).join(' | ').slice(0, 240)}`, commit: entry.commit?.slice(0, 8) }];
      at = null;
    }
    for (const row of rows) {
      row.type = entry.type;
      out.rows.push(row);
      console.log(`${((performance.now() - t0) / 60000).toFixed(1)} min  ${row.label} ${row.kernel} ${row.commit || ''} ${row.error ? `FAILED ${row.error}` : `${Object.keys(row.metrics).length} rates, ${row.seconds} s`}`);
    }
    write();
  }
  write();
  if (!process.env.GITHUB_ACTIONS) removeTrees();
  console.log(`${out.rows.filter((r) => !r.error).length} of ${out.rows.length} comparisons ran`);
}

if (isCli(import.meta.url)) main();
