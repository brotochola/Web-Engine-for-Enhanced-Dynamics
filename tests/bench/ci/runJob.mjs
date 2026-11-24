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

/** A result in a few short texts (one an annotation). */
function brief(r, exit) {
  const head = `${job.machine.cpu} | ${job.machine.threads} threads | exit ${exit}`;
  if (!r) return [`${head} | no result`];
  if (r.kind === 'tests') {
    const out = [`${head}\n${Object.entries(r.suites).map(([n, s]) => `${n}: ${s.pass}/${s.tests} pass, ${s.fail} fail, ${s.seconds} s`).join('\n')}`];
    for (const [n, s] of Object.entries(r.suites)) {
      for (const f of s.failed.slice(0, 8)) out.push(`${n}: ${f.name}\n${f.where}\n${f.error}\nexpected ${f.expected} actual ${f.actual}`.slice(0, 1200));
    }
    return out;
  }
  if (Array.isArray(r.broken)) {
    return [`${head}\n${r.rows.map((x) => `${x.kind} ${x.name}: bad ${x.bad} of ${x.accepted} (writes ${x.writes})`).join('\n')}`];
  }
  if (r.kind === 'repeatTests') {
    const bad = r.rows.filter((x) => x.failed);
    return [`${head}\n${r.rows.length} files, ${r.rows.reduce((a, x) => a + x.runs, 0)} runs\n${bad.map((x) => `${x.file}: ${x.failed}/${x.runs} failed`).join('\n') || 'no failure'}`,
      ...bad.slice(0, 6).map((x) => `${x.file}\n${x.failures[0]}`.slice(0, 1800))];
  }
  if (r.kind === 'sceneSmoke') {
    const lines = r.rows.map((x) => `${x.booted ? 'ok' : 'DEAD'} ${x.scene} ${JSON.stringify(x.fps)}${x.logs.length ? ` | ${x.logs.slice(0, 2).join(' | ').slice(0, 220)}` : ''}`);
    const out = [`${head}\n${r.browser} ${r.version} ${JSON.stringify(r.gpu)}`];
    for (let i = 0; i < lines.length; i += 8) out.push(lines.slice(i, i + 8).join('\n'));
    return out;
  }
  if (r.kind === 'kernelSmoke') {
    const bad = r.rows.filter((x) => x.error);
    return [`${head}\n${r.rows.length - bad.length} of ${r.rows.length} kernels ran\n${bad.map((x) => `${x.kernel}: ${x.error.slice(0, 120)}`).join('\n')}`];
  }
  if (r.kind === 'kernelAb') {
    const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
    const lines = r.rows.map((x) => (x.error ? `${x.id} FAILED ${x.error.slice(0, 160)}` : `${x.id} ${(100 * (med(x.b) / med(x.a) - 1)).toFixed(1)}%`));
    const out = [];
    for (let i = 0; i < lines.length; i += 60) out.push(`${head} | ${r.minutes} min\n${lines.slice(i, i + 60).join('\n')}`);
    return out;
  }
  return [`${head}\n${JSON.stringify(r).slice(0, 3000)}`];
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

// The job's result as annotations: the public API shows them as soon as the job ends (the results branch waits for the
// last job, and a log needs a login). GitHub keeps 10 notices a step, about 4 KB each.
const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
for (const text of brief(result, status).slice(0, 10)) {
  const escaped = text.split('%').join('%25').split('\r').join('').split('\n').join('%0A');
  console.log(`::notice title=${id}::${escaped.slice(0, 3800)}`);
}
fs.writeFileSync(path.join(outDir, 'job.json'), `${JSON.stringify({
  ...job, status, minutes: +((performance.now() - t0) / 60000).toFixed(1),
}, null, 1)}\n`);
process.exit(status === 0 ? 0 : 1);
