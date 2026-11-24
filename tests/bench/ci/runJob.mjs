#!/usr/bin/env node
/**
 * One job of a CI request on this VM (JOB_ID, JOB_TASK, JOB_ARGS from the workflow's matrix). Everything the job leaves
 * goes to ci-out/<id>/: job.json (the machine, the task, how it ended), result.json (the task's own), log.txt, shots/.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeMachine } from './machine.mjs';
import { TASKS } from './request.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const id = process.env.JOB_ID;
const taskName = process.env.JOB_TASK;
const args = JSON.parse(process.env.JOB_ARGS || '{}');
const task = TASKS[taskName];
if (!id || !task) throw new Error(`no such job: ${id} ${taskName}`);

const outDir = path.join(root, 'ci-out', id);
fs.mkdirSync(outDir, { recursive: true });
const resultFile = path.join(outDir, 'result.json');
const log = fs.createWriteStream(path.join(outDir, 'log.txt'));

/** Run a command, its output to the job's console, to log.txt and to `keep` (an array); its exit status or signal. */
function run(command, argv, keep) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (d) => {
        process.stdout.write(d);
        log.write(d);
        if (keep) keep.push(d);
      });
    }
    child.on('error', (e) => resolve(e.message));
    child.on('close', (code, signal) => resolve(code ?? signal));
  });
}

/** The node suite, and what failed in it. */
async function runTests() {
  const files = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.test.js')).map((f) => `${dir}/${f}`);
  const out = { kind: 'tests', suites: {} };
  for (const [name, dir] of [['node', 'tests/node'], ['demos', 'demos/tests']]) {
    const list = files(dir);
    const keep = [];
    const t0 = performance.now();
    // Windows' command line holds 32 KB: the files go in groups.
    const status = [];
    for (let i = 0; i < list.length; i += 300) {
      status.push(await run(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=tap', ...list.slice(i, i + 300)], keep));
    }
    const text = Buffer.concat(keep).toString('utf8');
    const count = (word) => [...text.matchAll(new RegExp(`^# ${word} (\\d+)`, 'gm'))].reduce((s, m) => s + Number(m[1]), 0);
    out.suites[name] = {
      status, seconds: +((performance.now() - t0) / 1000).toFixed(1), files: list.length,
      tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'),
      failed: failures(text),
    };
  }
  fs.writeFileSync(resultFile, `${JSON.stringify(out, null, 1)}\n`);
  return Object.values(out.suites).every((s) => s.fail === 0 && s.tests > 0) ? 0 : 1;
}

/** Each failing leaf test of a TAP text: its name, file and error. */
function failures(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let k = i + 1; k < lines.length && k < i + 60; k++) {
      if (lines[k].trim() === '...') break;
      body.push(lines[k]);
    }
    const all = body.join('\n');
    if (/failureType: 'subtestsFailed'/.test(all)) continue;
    const pick = (re) => re.exec(all)?.[1]?.trim() ?? null;
    out.push({
      name: m[2],
      where: pick(/location: '(.*)'/),
      error: (pick(/error: \|-\n([\s\S]*?)\n\s*(?:code|name|stack|expected|actual|operator):/) || pick(/error: '?(.*?)'?$/m) || all).slice(0, 700),
      expected: pick(/expected: (.*)$/m)?.slice(0, 200) ?? null,
      actual: pick(/actual: (.*)$/m)?.slice(0, 200) ?? null,
    });
  }
  return out;
}

const started = new Date().toISOString();
const t0 = performance.now();
const job = { id, task: taskName, args, machineKey: process.env.JOB_MACHINE, machine: describeMachine(), started };
console.log(JSON.stringify(job.machine));
fs.writeFileSync(path.join(outDir, 'job.json'), `${JSON.stringify({ ...job, status: 'unfinished' }, null, 1)}\n`);

let status;
if (taskName === 'tests') {
  status = await runTests();
} else {
  const argv = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === false) continue;
    argv.push(`--${k}`);
    if (v !== true) argv.push(String(v));
  }
  argv.push('--output', resultFile);
  if (taskName === 'scenes') argv.push('--shots', path.join(outDir, 'shots'));
  status = await run(process.execPath, [path.join(root, task.script), ...argv]);
}
await new Promise((resolve) => log.end(resolve));
fs.writeFileSync(path.join(outDir, 'job.json'), `${JSON.stringify({
  ...job, status, minutes: +((performance.now() - t0) / 60000).toFixed(1),
}, null, 1)}\n`);
process.exit(status === 0 ? 0 : 1);
