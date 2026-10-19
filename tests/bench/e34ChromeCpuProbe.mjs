#!/usr/bin/env node
/**
 * E-34 instrument check. The mailbox spin is invisible to STEP_MS. This samples
 * Chrome process CPU while Balls runs at numberOfPhysicsWorkers 4 and at 1. The
 * instrument is real only if the step moves the way E-04b already measured
 * (4 faster than 1) AND the CPU moves with the worker count. A flat CPU trace
 * next to a 2× step is not an instrument.
 *
 *   node tests/bench/e34ChromeCpuProbe.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = path.join(ROOT, 'tests/results/e34-cpu');
fs.mkdirSync(OUT, { recursive: true });

const PS1 = path.join(ROOT, 'tests/bench/e34ProcessTreeCpu.ps1');

function treeCpu(rootPid) {
  if (!rootPid) return Promise.resolve([]);
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-File', PS1, '-Root', String(rootPid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (b) => { out += b; });
    ps.on('error', () => resolve([]));
    ps.on('exit', () => {
      const rows = [];
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = Number(parts[0]);
        const cpu = Number(parts[1]);
        if (Number.isFinite(pid) && Number.isFinite(cpu)) rows.push({ pid, cpu });
      }
      resolve(rows);
    });
  });
}

function runArm(count) {
  const out = path.join(OUT, `wc${count}.json`);
  for (const name of fs.readdirSync(OUT)) {
    if (name.startsWith('browser-') && name.endsWith('.pid')) fs.unlinkSync(path.join(OUT, name));
  }
  const child = spawn(process.execPath, [
    path.join(ROOT, 'tests/bench/runIntegratedWorkerBenchmark.mjs'),
    '--src',
    '--scene', '/demos/ballsScene/ballsScene.js',
    '--scene-export', 'BallsScene',
    '--warmup-ms', '8000',
    '--duration-ms', '8000',
    '--no-collect-detailed-stats',
    '--query', `numberOfPhysicsWorkers=${count}`,
    '--output', out,
  ], { cwd: ROOT, stdio: 'inherit' });
  const base = new Map();
  const last = new Map();
  const samples = [];
  let sampling = false;
  const root = child.pid;
  console.log(`benchmark pid ${root}`);
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    treeCpu(root).then((rows) => {
      for (const row of rows) {
        if (!base.has(row.pid)) base.set(row.pid, row.cpu);
        const prev = last.get(row.pid);
        last.set(row.pid, prev == null ? row.cpu : Math.max(prev, row.cpu));
      }
      let cpu = 0;
      for (const [pid, cpuNow] of last) cpu += cpuNow - base.get(pid);
      samples.push({ t: Date.now(), cpu, processes: rows.length });
      sampling = false;
    });
  }, 1000);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      clearInterval(timer);
      if (code !== 0) {
        reject(new Error(`arm ${count} exited ${code}`));
        return;
      }
      const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
      const physics = (rep.workersByType?.physics || [])[0]?.statsSamplesAverage || {};
      const usable = samples.filter((s) => s.cpu != null);
      const first = usable[0];
      const end = usable[usable.length - 1];
      const wallS = first && end ? (end.t - first.t) / 1000 : 0;
      const cpuS = end ? end.cpu : 0;
      resolve({
        count,
        browserPid: root,
        stepMs: physics.STEP_MS ?? null,
        bodyCount: physics.BODY_COUNT ?? null,
        awake: physics.AWAKE_COUNT ?? null,
        cores: wallS > 0 ? cpuS / wallS : null,
        cpuSeconds: cpuS,
        wallSeconds: wallS,
        processes: end ? end.processes : 0,
        missedSamples: samples.length - usable.length,
      });
    });
  });
}

const arms = [];
for (const count of [4, 1]) {
  console.log(`arm numberOfPhysicsWorkers=${count}`);
  arms.push(await runArm(count));
  console.log(JSON.stringify({ count: arms.at(-1).count, stepMs: arms.at(-1).stepMs, cores: arms.at(-1).cores, processes: arms.at(-1).processes, browserPid: arms.at(-1).browserPid }));
}
const report = { feature: 'e34-chrome-cpu', arms };
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(arms.map(({ count, stepMs, cores, bodyCount, awake, processes, browserPid }) => ({ count, stepMs, cores, bodyCount, awake, processes, browserPid })), null, 2));
