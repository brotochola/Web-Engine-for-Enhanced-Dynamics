/**
 * A CI request: ci-request.json at the root of a ci/<name> branch (docs/internal/CI_MEASURE.md). It lists tasks, each
 * with its machines and how many VMs of each; this module turns it into the workflow's matrix, one job a VM.
 *
 *   { "name": "calib-1",
 *     "jobs": [ { "task": "tests", "machines": ["linux", "mac"], "vms": 1 },
 *               { "task": "kernelAb", "machines": ["linux"], "vms": 8, "args": { "a": "<sha>", "b": "<sha>", "rounds": 5 } } ] }
 *
 * `args` go to the task's script as --key value; `shards: n` splits a task's work over n jobs (--shard k/n) on every VM.
 */
import fs from 'node:fs';

/** GitHub's standard runners, free on a public repository (2026-11-24). */
export const MACHINES = Object.freeze({
  linux: 'ubuntu-24.04',
  linuxArm: 'ubuntu-24.04-arm',
  win: 'windows-2025',
  winArm: 'windows-11-arm',
  mac: 'macos-15',
  macIntel: 'macos-15-intel',
});

/**
 * Each task: its script (a Node script, or Node's own test runner for `tests`), and the browsers it needs.
 * `minutes` is the job's limit.
 */
export const TASKS = Object.freeze({
  tests: { minutes: 30, browsers: [] },
  race: { script: 'tests/bench/ci/raceStress.mjs', minutes: 60, browsers: [] },
  repeatTests: { script: 'tests/bench/ci/repeatTests.mjs', minutes: 90, browsers: [] },
  kernelAb: { script: 'tests/bench/ci/kernelAb.mjs', minutes: 180, browsers: [] },
  scenes: { script: 'tests/bench/ci/sceneSmoke.mjs', minutes: 120, browsers: (args) => [args.browser || 'chromium'] },
  bench: { script: 'tests/bench/runIntegratedWorkerBenchmark.mjs', minutes: 30, browsers: (args) => [args.channel || 'chrome'] },
});

export function readRequest(file) {
  const req = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(req.name || '')) throw new Error(`request name "${req.name}": lower case, digits and dashes`);
  if (!Array.isArray(req.jobs) || req.jobs.length === 0) throw new Error('the request has no jobs');
  return req;
}

/** The matrix's entries: one a VM and shard. GitHub takes 256 a workflow run. */
export function expandRequest(req) {
  const out = [];
  for (const job of req.jobs) {
    const task = TASKS[job.task];
    if (!task) throw new Error(`unknown task ${job.task}`);
    const args = job.args || {};
    const label = job.label || job.task;
    for (const machine of job.machines || []) {
      if (!MACHINES[machine]) throw new Error(`unknown machine ${machine}`);
      const vms = typeof job.vms === 'object' ? job.vms[machine] ?? 1 : job.vms ?? 1;
      for (let vm = 1; vm <= vms; vm++) {
        for (let shard = 1; shard <= (job.shards || 1); shard++) {
          const shards = job.shards || 1;
          const id = `${label}-${machine}-${vm}${shards > 1 ? `-s${shard}` : ''}`;
          if (out.some((e) => e.id === id)) throw new Error(`two jobs are called ${id}: give one a label`);
          out.push({
            id,
            machine,
            os: MACHINES[machine],
            task: job.task,
            minutes: job.minutes || task.minutes,
            browsers: (typeof task.browsers === 'function' ? task.browsers(args) : task.browsers).join(' '),
            args: JSON.stringify({ ...args, ...(shards > 1 ? { shard: `${shard}/${shards}` } : {}) }),
          });
        }
      }
    }
  }
  if (out.length > 256) throw new Error(`${out.length} jobs: a workflow run takes 256`);
  return out;
}
