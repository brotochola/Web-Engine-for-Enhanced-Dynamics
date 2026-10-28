#!/usr/bin/env node
/**
 * E-144 step 0: how much CPU each thread of Chrome's renderer process really uses while a scene runs, read from the
 * operating system (Windows: each thread's TotalProcessorTime, twice), not from the sampling profiler, which counts a
 * thread waiting in some states as busy. The page's workers (logic, spatial, physics and Box2D's solver threads) are
 * threads of that process.
 *
 *   node tests/bench/threadCpuProbe.mjs --scene /tests/bench/stressScenes/bunnyMarkStressScene.js \
 *     --scene-export BunnyMarkStressScene [--warmup-ms 8000] [--window-ms 5000] [--headed]
 *
 * Prints every thread over 20 ms/s (ms of CPU per second of wall time), the renderer's total, and how many threads
 * are over 800 ms/s: a thread that spins reads about 1000.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { parseArgs } from './microbenchHelpers.mjs';

const args = parseArgs();
const sceneModule = String(args.scene || '/tests/bench/stressScenes/bunnyMarkStressScene.js');
const sceneExport = String(args['scene-export'] || 'BunnyMarkStressScene');
const warmupMs = Number(args['warmup-ms'] ?? 8000);
const windowMs = Number(args['window-ms'] ?? 5000);
const headed = Boolean(args.headed);
const query = args.query ? `&${args.query}` : '';
if (process.platform !== 'win32') throw new Error('threadCpuProbe reads Windows thread times');

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Every process under `rootPid`, with its Chrome --type. */
function processTree(rootPid) {
  const json = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
  const rows = JSON.parse(json);
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ParentProcessId)) children.set(r.ParentProcessId, []);
    children.get(r.ParentProcessId).push(r);
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of children.get(pid) || []) {
      out.push({ pid: child.ProcessId, type: /--type=([\w-]+)/.exec(child.CommandLine || '')?.[1] || 'browser' });
      stack.push(child.ProcessId);
    }
  }
  return out;
}

/** Each thread's CPU time (ms) in the given processes: Map of `pid:tid` to ms. */
function threadTimes(pids) {
  const json = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-Process -Id ${pids.join(',')} | ForEach-Object { $p = $_.Id; $_.Threads | ForEach-Object { [pscustomobject]@{ p = $p; t = $_.Id; ms = $_.TotalProcessorTime.TotalMilliseconds } } } | ConvertTo-Json -Compress`],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
  const rows = [].concat(JSON.parse(json) || []);
  return new Map(rows.map((r) => [`${r.p}:${r.t}`, r.ms]));
}

const server = await createStaticBenchmarkServer(repoRoot, 0);
const browser = await chromium.launch({ headless: !headed });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  page.evaluate(({ sceneModule, sceneExport }) => window.__WEED_BENCHMARK__.run({
    sceneModule, sceneExport,
    warmupMs: 600000, durationMs: 600000, sampleIntervalMs: 1000, collectDetailedStats: false, collectGpuStats: false,
    canvasWidth: 1280, canvasHeight: 800,
  }), { sceneModule, sceneExport }).catch(() => {});
  await page.waitForFunction(() => Boolean(window.scene), undefined, { timeout: 120000 });
  await page.waitForTimeout(warmupMs);

  const renderers = processTree(process.pid).filter((p) => p.type === 'renderer').map((p) => p.pid);
  const before = threadTimes(renderers);
  const t0 = performance.now();
  await page.waitForTimeout(windowMs);
  const after = threadTimes(renderers);
  const wall = (performance.now() - t0) / 1000;

  const rows = [];
  for (const [key, ms] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    rows.push({ key, msPerS: (ms - was) / wall });
  }
  rows.sort((a, b) => b.msPerS - a.msPerS);
  const total = rows.reduce((s, r) => s + r.msPerS, 0);
  console.log(`${sceneExport}: ${rows.length} renderer threads, ${total.toFixed(0)} ms/s in all over ${wall.toFixed(1)} s`);
  for (const r of rows) if (r.msPerS >= 20) console.log(`  thread ${r.key.padEnd(14)} ${r.msPerS.toFixed(0).padStart(5)} ms/s`);
  console.log(`threads over 800 ms/s: ${rows.filter((r) => r.msPerS > 800).length}`);
} finally {
  await browser.close();
  await (server.close?.() ?? server.stop?.());
}
