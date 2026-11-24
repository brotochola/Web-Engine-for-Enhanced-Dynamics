#!/usr/bin/env node
/**
 * Requests to GitHub's machines from here (docs/internal/CI_MEASURE.md). Needs only git's access to the repository:
 * a push starts a request, and its results come back as a branch.
 *
 *   node scripts/ciMeasure.mjs submit <request.json> [--base <rev>]   push ci/<name>: <rev> (HEAD) plus the request
 *   node scripts/ciMeasure.mjs status <name>                          the run's jobs (the public API, no login)
 *   node scripts/ciMeasure.mjs wait <name> [--minutes 120]            until the results branch is there
 *   node scripts/ciMeasure.mjs fetch <name>                           results to tests/results/ci/<name>/ (git-ignored)
 *   node scripts/ciMeasure.mjs clean <name>                           delete ci/<name> and ci-results/<name> on GitHub
 *
 * It pushes and deletes those two branches and no other. The request's commit is made without the hooks and without
 * touching the working tree or the index: it is thrown away with its branch.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandRequest, readRequest } from '../tests/bench/ci/request.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLL_MS = 60000;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, ...opts }).trim();
}

/** owner/repo of origin. */
function slug() {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(git(['remote', 'get-url', 'origin']));
  if (!m) throw new Error('origin is not a GitHub repository');
  return m[1];
}

function checkName(name) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name || '')) throw new Error(`request name "${name}"`);
  return name;
}

function submit(file, base) {
  const req = readRequest(file);
  const jobs = expandRequest(req);
  const sha = git(['rev-parse', '--verify', `${base}^{commit}`]);
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(['read-tree', sha], { env });
  const blob = git(['hash-object', '-w', '--stdin'], { input: `${JSON.stringify(req, null, 2)}\n` });
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},ci-request.json`], { env });
  const tree = git(['write-tree'], { env });
  const commit = git(['commit-tree', tree, '-p', sha, '-m', `CI request ${req.name}`]);
  fs.rmSync(path.dirname(index), { recursive: true, force: true });
  git(['push', '-f', 'origin', `${commit}:refs/heads/ci/${req.name}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(`ci/${req.name}: ${jobs.length} jobs on ${sha.slice(0, 8)}\nhttps://github.com/${slug()}/actions`);
}

async function api(pathname) {
  const r = await fetch(`https://api.github.com/repos/${slug()}${pathname}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for ${pathname}`);
  return r.json();
}

async function status(name) {
  const runs = (await api(`/actions/runs?branch=${encodeURIComponent(`ci/${name}`)}&per_page=1`)).workflow_runs;
  if (!runs.length) {
    console.log(`no run for ci/${name} yet`);
    return null;
  }
  const run = runs[0];
  const jobs = [];
  for (let page = 1; ; page++) {
    const got = (await api(`/actions/runs/${run.id}/jobs?per_page=100&page=${page}`)).jobs;
    jobs.push(...got);
    if (got.length < 100) break;
  }
  const count = {};
  for (const j of jobs) count[j.conclusion || j.status] = (count[j.conclusion || j.status] || 0) + 1;
  console.log(`${run.status} ${run.conclusion || ''} ${run.html_url}\n${JSON.stringify(count)}`);
  for (const j of jobs) {
    if (j.conclusion === 'success') continue;
    const step = (j.steps || []).find((s) => s.conclusion === 'failure' || s.status === 'in_progress');
    console.log(`  ${(j.conclusion || j.status).padEnd(12)} ${j.name}${step ? `  (${step.name})` : ''}`);
  }
  return run;
}

/** The results branch's commit on GitHub, or null. Its message names the run's commit, so an older run's is not taken. */
function resultsCommit(name) {
  const line = git(['ls-remote', 'origin', `refs/heads/ci-results/${name}`]);
  return line ? line.split(/\s+/)[0] : null;
}

function requestCommit(name) {
  const line = git(['ls-remote', 'origin', `refs/heads/ci/${name}`]);
  return line ? line.split(/\s+/)[0] : null;
}

function fetchResults(name) {
  if (!resultsCommit(name)) return false;
  const ref = `refs/ci-results/${name}`;
  git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/ci-results/${name}:${ref}`]);
  const of = requestCommit(name);
  const message = git(['log', '-1', '--format=%s', ref]);
  if (of && !message.includes(of)) return false;
  const out = path.join(root, 'tests', 'results', 'ci', name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const tar = path.join(out, 'results.tar');
  git(['archive', '--format=tar', '-o', tar, ref]);
  const x = spawnSync('tar', ['-xf', 'results.tar'], { cwd: out, encoding: 'utf8' });
  if (x.status !== 0) throw new Error(x.stderr);
  fs.rmSync(tar);
  git(['update-ref', '-d', ref]);
  console.log(`${path.join(out, 'ci-out', 'summary.md')}  (${message})`);
  return true;
}

const [command, arg, ...rest] = process.argv.slice(2);
const opt = (k, d) => {
  const i = rest.indexOf(`--${k}`);
  return i >= 0 ? rest[i + 1] : d;
};
if (command === 'submit') {
  submit(arg, opt('base', 'HEAD'));
} else if (command === 'status') {
  await status(checkName(arg));
} else if (command === 'fetch') {
  if (!fetchResults(checkName(arg))) {
    console.log(`no results of this request's run yet`);
    process.exitCode = 1;
  }
} else if (command === 'wait') {
  const until = Date.now() + Number(opt('minutes', 120)) * 60000;
  while (!fetchResults(checkName(arg))) {
    if (Date.now() > until) {
      console.log('still no results');
      process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
} else if (command === 'clean') {
  for (const ref of [`ci/${checkName(arg)}`, `ci-results/${arg}`]) {
    if (git(['ls-remote', 'origin', `refs/heads/${ref}`])) git(['push', '-q', 'origin', '--delete', ref]);
  }
} else {
  console.log('usage: ciMeasure.mjs submit|status|wait|fetch|clean <request.json | name>');
  process.exitCode = 1;
}
