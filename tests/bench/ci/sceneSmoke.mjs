#!/usr/bin/env node
/**
 * Every demo (or every stress scene) opened in one browser: does it boot, does each worker publish frames, what does it
 * log, what does it draw (a small screenshot), and which GPU the page got.
 *
 *   node tests/bench/ci/sceneSmoke.mjs [--browser chromium|chrome|webkit|firefox] [--set demos|stress|boot] [--seconds 8]
 *        [--only a,b] [--query k=v] [--shots dir] [--shard 1/2] --output file.json
 *
 * chromium is Playwright's full build in the new headless mode (channel 'chromium'): its default headless shell always
 * draws in software. chrome is the installed Google Chrome. --set boot: four scenes, for a browser's first check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as playwright from 'playwright';

import { createStaticBenchmarkServer } from '../../helpers/createStaticBenchmarkServer.mjs';
import { menuScenes } from '../demoWarnings.mjs';
import { repoRoot } from '../measureLib.mjs';
import { isCli, parseArgs } from '../microbenchHelpers.mjs';
import { sceneExport } from '../profileSceneSweep.mjs';

const BOOT_TIMEOUT_MS = 120000;
const BOOT_SET = ['ballsScene', 'bunnyMarkScene', 'boidsScene', 'predatorScene'];

function stressScenes() {
  const dir = path.join(repoRoot, 'tests/bench/stressScenes');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('Scene.js')).sort()) {
    const file = `/tests/bench/stressScenes/${f}`;
    try {
      out.push({ file, exportName: sceneExport(file) });
    } catch {
      // A module of the folder that is no scene.
    }
  }
  return out;
}

function launch(which) {
  if (which === 'webkit') return playwright.webkit.launch();
  if (which === 'firefox') return playwright.firefox.launch();
  const args = ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--enable-unsafe-webgpu', ...(os.platform() === 'linux' ? ['--no-sandbox'] : [])];
  return playwright.chromium.launch({ channel: which === 'chrome' ? 'chrome' : 'chromium', args });
}

/** The page's GPU: the WebGL renderer string and the WebGPU adapter. */
function probeGpu(page) {
  return page.evaluate(async () => {
    const out = { isolated: globalThis.crossOriginIsolated, threads: navigator.hardwareConcurrency, userAgent: navigator.userAgent };
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      out.webgl = gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null;
      out.maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null;
      out.timerQuery = Boolean(gl && gl.getExtension('EXT_disjoint_timer_query_webgl2'));
    } catch (e) {
      out.webgl = `error: ${e.message}`;
    }
    try {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      const info = adapter ? adapter.info || {} : {};
      out.webgpu = adapter ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || 'adapter' : null;
      out.webgpuFallback = adapter ? Boolean(adapter.isFallbackAdapter ?? info.isFallbackAdapter) : null;
      out.webgpuTimestamps = adapter ? adapter.features.has('timestamp-query') : null;
    } catch (e) {
      out.webgpu = `error: ${e.message}`;
    }
    return out;
  });
}

/** Frames every worker has published so far, by worker. */
function framesNow(page) {
  return page.evaluate(async () => {
    const scene = window.__WEED_BENCHMARK__.getScene?.();
    if (!scene?.buffers?.frameTotals) return null;
    const frameTotals = await import('/src/util/frameTotals.js');
    const { createWorkerBenchmarkReader } = await import('/tests/bench/workerBenchmarkMetrics.js');
    const snap = createWorkerBenchmarkReader(scene, { frameTotals }).snapshot(performance.now(), { totals: true });
    return Object.fromEntries(snap.workers.map((w) => [w.id, w.totals ? w.totals.frames : null]));
  });
}

/** A promise's result, or `fallback` after `ms` (the promise goes on alone). */
function within(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function runScene(browser, port, { file, exportName }, opts) {
  const name = path.basename(file, '.js');
  const logs = new Map();
  const note = (t) => logs.set(t, (logs.get(t) || 0) + 1);
  const row = { scene: name, booted: false };
  const t0 = Date.now();
  let page = null;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => note(`[page error] ${String(e).slice(0, 300)}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') note(`[${m.type()}] ${m.text().slice(0, 300)}`);
    });
    const query = opts.query ? `&${opts.query}` : '';
    await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1${query}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 60000 });
    const prepared = page.evaluate((a) => window.__WEED_BENCHMARK__.prepare({
      warmupMs: 600000, durationMs: 1000, sampleIntervalMs: 100, sceneModule: a.file, sceneExport: a.exportName,
      canvasWidth: 1280, canvasHeight: 720,
    }).then(() => 'ok', (e) => `prepare: ${e?.message ?? e}`), { file, exportName });
    const got = await within(prepared.catch((e) => `evaluate: ${e.message}`), BOOT_TIMEOUT_MS, 'prepare: timeout');
    row.bootMs = Date.now() - t0;
    if (got !== 'ok') throw new Error(got);
    row.booted = true;
    const before = await within(framesNow(page), 30000, null);
    const s0 = Date.now();
    await page.waitForTimeout(opts.seconds * 1000);
    const after = await within(framesNow(page), 30000, null);
    const seconds = (Date.now() - s0) / 1000;
    row.fps = after && before
      ? Object.fromEntries(Object.keys(after).map((k) => [k, +(((after[k] ?? 0) - (before[k] ?? 0)) / seconds).toFixed(1)]))
      : null;
    if (opts.shots) {
      fs.mkdirSync(opts.shots, { recursive: true });
      await page.screenshot({ path: path.join(opts.shots, `${name}.jpg`), type: 'jpeg', quality: 45, scale: 'css', timeout: 60000 })
        .catch((e) => note(`[harness] screenshot: ${e.message.split('\n')[0]}`));
    }
  } catch (err) {
    note(`[harness] ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}`);
  } finally {
    if (page) await within(page.close().catch(() => {}), 15000);
  }
  row.logs = [...logs].map(([text, n]) => (n > 1 ? `${text} (x${n})` : text)).slice(0, 25);
  return row;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const which = String(args.browser ?? 'chromium');
  const set = String(args.set ?? 'demos');
  let scenes = set === 'stress' ? stressScenes() : menuScenes(repoRoot);
  if (set === 'boot') scenes = scenes.filter((s) => BOOT_SET.includes(path.basename(s.file, '.js')));
  if (args.only) scenes = scenes.filter((s) => String(args.only).split(',').includes(path.basename(s.file, '.js')));
  if (args.shard) {
    const [k, n] = String(args.shard).split('/').map(Number);
    scenes = scenes.filter((_, i) => i % n === k - 1);
  }
  const opts = {
    seconds: Number(args.seconds ?? 8),
    query: args.query ? String(args.query) : '',
    shots: args.shots ? path.resolve(String(args.shots)) : null,
  };
  const server = await createStaticBenchmarkServer(repoRoot);
  const out = { kind: 'sceneSmoke', browser: which, set, query: opts.query, rows: [] };
  const write = () => fs.writeFileSync(path.resolve(String(args.output ?? 'scene-smoke.json')), `${JSON.stringify(out, null, 1)}\n`);
  let browser = await launch(which);
  out.version = browser.version();
  const probe = await browser.newPage();
  await probe.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html`, { waitUntil: 'load' });
  out.gpu = await probeGpu(probe).catch((e) => ({ error: e.message }));
  await probe.close();
  console.log(`${which} ${out.version}`, JSON.stringify(out.gpu));
  try {
    for (const s of scenes) {
      // A scene that took the browser down with it: the next one gets a new browser.
      if (!browser.isConnected()) browser = await launch(which);
      const row = await runScene(browser, server.port, s, opts);
      out.rows.push(row);
      write();
      console.log(`${row.booted ? 'ok  ' : 'DEAD'} ${row.scene.padEnd(30)} boot ${row.bootMs ?? '-'} ms  fps ${JSON.stringify(row.fps ?? null)}`);
      for (const t of row.logs) console.log(`       ${t}`);
    }
  } finally {
    write();
    await within(browser.close().catch(() => {}), 15000);
    await server.close?.();
  }
  console.log(`${out.rows.filter((r) => r.booted).length} of ${out.rows.length} booted`);
}

if (isCli(import.meta.url)) {
  await main();
  process.exit(0);
}
