#!/usr/bin/env node
/**
 * What Chrome's GPU process does for a WeedJS scene (E-407, N-?): a trace of the GPU service's own categories (the
 * command buffer's decoding, ANGLE, the display compositor), taken over CDP while the scene runs, summarised as each
 * GPU-process thread's self time by event name (a slice's duration less its children's), in ms a second. The V8 CPU
 * profiles see the workers only; the GL calls' cost in the GPU process (validation, translation to D3D11, uploads,
 * shader compiles) shows here.
 *
 *   node tests/bench/gpuProcessTrace.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
 *     [--query k=v&k2=v2] [--warmup-ms 12000] [--trace-ms 3000] [--categories a,b,...] [--decoder] [--output dir] [--raw]
 * --decoder starts Chrome with --enable-gpu-service-tracing: the decoder's per-command slices.
 * From Git Bash set MSYS_NO_PATHCONV=1. Headed Chrome (a headless one draws on a software path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The GPU service's categories (the disabled-by-default ones carry the decoder's per-command slices). */
export const GPU_CATEGORIES = [
  'toplevel', 'gpu', 'gpu.service', 'gpu.angle', 'gpu.capture', 'viz', 'cc', 'benchmark',
  'disabled-by-default-gpu.service', 'disabled-by-default-gpu.decoder', 'disabled-by-default-gpu.device',
  'disabled-by-default-gpu.angle', 'disabled-by-default-viz.gpu_composite_time',
];

/** Self time by event name for each thread of the processes whose name matches `procRe`, from complete events. */
export function summariseTrace(events, procRe = /GPU Process/i) {
  const procName = new Map();
  const threadName = new Map();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name') procName.set(e.pid, e.args?.name || '');
    else if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args?.name || '');
  }
  // Complete slices per thread ('X' with dur, or B/E pairs), sorted by start.
  const byThread = new Map();
  const open = new Map();
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const e of events) {
    if (!procRe.test(procName.get(e.pid) || '')) continue;
    const key = `${e.pid}:${e.tid}`;
    let list = byThread.get(key);
    if (!list) byThread.set(key, (list = []));
    if (e.ph === 'X' && typeof e.dur === 'number') list.push({ name: e.name, ts: e.ts, dur: e.dur });
    else if (e.ph === 'B') {
      let st = open.get(key);
      if (!st) open.set(key, (st = []));
      st.push({ name: e.name, ts: e.ts });
    } else if (e.ph === 'E') {
      const st = open.get(key);
      const b = st && st.pop();
      if (b) list.push({ name: b.name, ts: b.ts, dur: e.ts - b.ts });
    } else continue;
    if (e.ts < t0) t0 = e.ts;
    if (e.ts > t1) t1 = e.ts;
  }
  const spanS = Math.max(1e-6, (t1 - t0) / 1e6);
  const threads = [];
  for (const [key, list] of byThread) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const self = new Map();
    const total = new Map();
    const count = new Map();
    const stack = [];
    let busy = 0;
    for (const s of list) {
      while (stack.length && stack[stack.length - 1].end <= s.ts) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.child += s.dur;
      else busy += s.dur;
      const node = { name: s.name, end: s.ts + s.dur, dur: s.dur, child: 0 };
      stack.push(node);
      s.node = node;
      total.set(s.name, (total.get(s.name) || 0) + s.dur);
      count.set(s.name, (count.get(s.name) || 0) + 1);
    }
    for (const s of list) self.set(s.name, (self.get(s.name) || 0) + Math.max(0, s.node.dur - s.node.child));
    const [pid] = key.split(':');
    const rows = [...self.entries()]
      .map(([name, us]) => ({ name, selfMsPerS: us / 1000 / spanS, totalMsPerS: (total.get(name) || 0) / 1000 / spanS, perS: (count.get(name) || 0) / spanS }))
      .sort((a, b) => b.selfMsPerS - a.selfMsPerS);
    threads.push({ process: procName.get(Number(pid)) || '', thread: threadName.get(key) || key, busyMsPerS: busy / 1000 / spanS, rows });
  }
  threads.sort((a, b) => b.busyMsPerS - a.busyMsPerS);
  return { spanS, threads };
}

export async function traceGpuProcess(opts) {
  const server = await createStaticBenchmarkServer(repoRoot);
  // --decoder: the GPU service's own tracing on, so the command decoder records a slice per GL command (its name, as
  // kTexSubImage2D, kDrawArraysInstancedANGLE) under CommandBufferService:PutChanged.
  const flags = ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  if (opts.decoder) flags.push('--enable-gpu-service-tracing');
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: flags });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${opts.query ? `&${opts.query}` : ''}`);
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__));
    await page.evaluate(({ m, e }) => window.__WEED_BENCHMARK__.prepare({ warmupMs: 600000, durationMs: 600000, sampleIntervalMs: 1000,
      sceneModule: m, sceneExport: e, collectDetailedStats: false, collectGpuStats: false }), { m: opts.scene, e: opts.sceneExport });
    await page.waitForTimeout(opts.warmupMs);
    const cdp = await browser.newBrowserCDPSession();
    const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: opts.categories },
    });
    await page.waitForTimeout(opts.traceMs);
    await cdp.send('Tracing.end');
    const { stream } = await done;
    let text = '';
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 22 });
      text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send('IO.close', { handle: stream });
    const parsed = JSON.parse(text);
    return { events: Array.isArray(parsed) ? parsed : parsed.traceEvents || [], raw: text };
  } finally {
    await browser.close();
    await server.close?.();
  }
}

async function main() {
  const args = parseArgs();
  if (!args.scene || !args['scene-export']) {
    console.error('usage: gpuProcessTrace.mjs --scene <module> --scene-export <Class> [--query k=v] [--warmup-ms N] [--trace-ms N] [--categories a,b] [--output dir] [--raw]');
    process.exit(2);
  }
  const categories = typeof args.categories === 'string' ? args.categories.split(',') : GPU_CATEGORIES;
  const { events, raw } = await traceGpuProcess({
    scene: String(args.scene),
    sceneExport: String(args['scene-export']),
    query: typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '',
    warmupMs: Number(args['warmup-ms'] ?? 12000),
    traceMs: Number(args['trace-ms'] ?? 3000),
    categories,
    decoder: !!args.decoder,
  });
  const summary = summariseTrace(events);
  console.log(`${events.length} events over ${summary.spanS.toFixed(2)} s; GPU process threads by busy time:`);
  for (const t of summary.threads.slice(0, 6)) {
    console.log(`\n${t.thread} (${t.process}): ${t.busyMsPerS.toFixed(1)} ms/s in slices`);
    for (const r of t.rows.slice(0, 25)) {
      console.log(`  ${r.selfMsPerS.toFixed(2).padStart(8)} self  ${r.totalMsPerS.toFixed(2).padStart(8)} total ms/s  ${r.perS.toFixed(0).padStart(7)}/s  ${r.name}`);
    }
  }
  if (args.output) {
    const dir = String(args.output);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gpu-process-summary.json'), JSON.stringify(summary, null, 1));
    if (args.raw) fs.writeFileSync(path.join(dir, 'trace.json'), raw);
  }
}

if (isCli(import.meta.url)) await main();
