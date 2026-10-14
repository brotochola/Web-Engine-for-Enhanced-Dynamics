/**
 * Toolchain guard.
 *
 * F-05, and the check it should have existed for.
 *
 * `npm test` uses node:test, which needs no dependencies at all. So an empty or
 * half-extracted `node_modules` leaves the whole suite reporting green while
 * every benchmark in the repository is dead - they fail at import with
 * `Cannot find package 'playwright'`. That is exactly how a destroyed
 * `node_modules` survived unnoticed: 894/894 tests passing, no benchmark able to
 * run.
 *
 * This sits beside the dist-freshness guard (`scripts/distVersion.js`) because
 * both answer the same question: **is what I am about to measure actually
 * runnable?** One catches a stale bundle, this catches a missing toolchain.
 *
 * Usage:
 *   node scripts/assertToolchain.mjs            -> check, exit 1 on failure
 *   node scripts/assertToolchain.mjs --quiet    -> exit code only
 *
 * Wired as `pretest:bench` so every benchmark refuses to start against a broken
 * tree instead of failing 30 seconds later with an import error.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

/**
 * Packages the measurement path actually needs.
 *
 * `playwright` is the one that matters - it is what every benchmark imports and
 * what fails first when the tree is broken. The others are listed because a
 * half-finished install can leave SOME of them missing, and reporting all of them
 * at once is more useful than making someone re-run to discover the next one.
 */
const REQUIRED = [
  { name: 'playwright', why: 'every benchmark launches Chromium through it' },
  { name: 'esbuild', why: 'bundle build and the ?src= module path' },
  { name: 'webpack', why: 'make_bundle and the dist build' },
];

function fail(lines) {
  for (const line of lines) console.error(line);
  console.error('');
  console.error('  The node test suite will still report GREEN - node:test needs no');
  console.error('  dependencies - so a green `npm test` is NOT evidence the toolchain');
  console.error('  works. Fix with `npm install`, then re-check:');
  console.error('    node scripts/assertToolchain.mjs');
  process.exit(1);
}

const problems = [];

// 1. The directory itself. An empty node_modules is the signature of the
//    `git worktree remove --force` junction-following bug, so name it directly.
const nm = path.join(REPO, 'node_modules');
if (!fs.existsSync(nm)) {
  problems.push(`node_modules is missing entirely: ${nm}`);
} else {
  const entries = fs.readdirSync(nm);
  if (entries.length === 0) {
    problems.push(
      'node_modules exists but is EMPTY.\n' +
        '    This is the signature of `git worktree remove --force` following a\n' +
        '    node_modules junction back into this repo and deleting its contents.\n' +
        '    See docs/MATH_ALLOC_AUDIT_IMPLEMENTATION_LOG.md, finding F-05.',
    );
  }
}

// 2. Each required package must resolve, which catches the half-extracted case
//    that a directory listing alone would miss.
const require = createRequire(path.join(REPO, 'package.json'));
for (const { name, why } of REQUIRED) {
  try {
    require.resolve(`${name}/package.json`);
  } catch {
    try {
      require.resolve(name);
    } catch {
      problems.push(`${name} does not resolve - ${why}`);
    }
  }
}

// 3. Resolve the benchmark runner's own imports STATICALLY.
//
//    It must NOT be imported. `runIntegratedWorkerBenchmark.mjs` calls main() at
//    module scope with no isCli() guard, so importing it launches a browser. The
//    first version of this file did exactly that - during a running measurement
//    sitting, which contaminated it.
//
//    So: read the source, pull out its bare specifiers, and resolve each. That
//    catches the same class of failure (a dependency the runner cannot import)
//    without executing a line of it.
try {
  const runnerPath = path.join(REPO, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
  const source = fs.readFileSync(runnerPath, 'utf8');
  const specifiers = [
    ...source.matchAll(/(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
  ]
    .map((m) => m[1])
    .filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:'));

  const unresolved = [];
  for (const spec of new Set(specifiers)) {
    try {
      require.resolve(spec);
    } catch {
      unresolved.push(spec);
    }
  }
  if (unresolved.length > 0) {
    problems.push(
      `the benchmark runner imports packages that do not resolve: ${unresolved.join(', ')}`,
    );
  }
} catch (e) {
  problems.push(`could not statically check the benchmark runner: ${e.message}`);
}

if (problems.length > 0) {
  if (!QUIET) {
    console.error('');
    console.error('  TOOLCHAIN BROKEN - refusing to measure against this tree.');
    console.error('');
  }
  fail(problems);
}

if (!QUIET) {
  console.log('  Toolchain OK - benchmark harness imports resolve.');
}