#!/usr/bin/env node
/**
 * One line each time a job of a CI request ends (and when the run does), from the public API: no login, which GitHub
 * limits to 60 calls an hour, so it asks every three minutes.
 *
 *   node scripts/ciWatch.mjs <name>
 *   node scripts/ciWatch.mjs <name> --notes [--job <text>] [--failed]   what each ended job published, once (a call a job)
 */
import { execFileSync } from 'node:child_process';

const name = process.argv[2];
const flag = (k) => process.argv.includes(`--${k}`);
const option = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const slug = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin)[1];
const POLL_MS = 180000;
const seen = new Set();

async function api(pathname) {
  const r = await fetch(`https://api.github.com/repos/${slug}${pathname}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  return r.json();
}

/** The request's latest run and its jobs. */
async function load() {
  const run = (await api(`/actions/runs?branch=${encodeURIComponent(`ci/${name}`)}&per_page=1`)).workflow_runs[0];
  const jobs = [];
  for (let page = 1; run; page++) {
    const got = (await api(`/actions/runs/${run.id}/jobs?per_page=100&page=${page}`)).jobs;
    jobs.push(...got);
    if (got.length < 100) break;
  }
  return { run, jobs };
}

if (flag('notes')) {
  const { jobs } = await load();
  const job = option('job');
  for (const j of jobs) {
    if (j.status !== 'completed' || j.name === 'plan' || (job && !j.name.includes(job)) || (flag('failed') && j.conclusion === 'success')) continue;
    for (const a of await api(`/check-runs/${j.id}/annotations?per_page=50`)) {
      if (a.title === j.name) console.log(`== ${j.conclusion} ${j.name}\n${a.message}\n`);
    }
  }
} else {
  for (;;) {
    try {
      const { run, jobs } = await load();
      for (const j of jobs) {
        if (j.status !== 'completed' || seen.has(j.id)) continue;
        seen.add(j.id);
        const minutes = ((new Date(j.completed_at) - new Date(j.started_at)) / 60000).toFixed(1);
        const step = (j.steps || []).find((s) => s.conclusion === 'failure');
        console.log(`${j.conclusion} ${j.name} ${minutes} min${step ? ` (${step.name})` : ''}`);
      }
      if (run?.status === 'completed') {
        console.log(`run ${run.conclusion}`);
        break;
      }
    } catch (e) {
      console.log(`${e.message} (asking again)`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
