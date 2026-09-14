/**
 * liquidFun-gpu-trace.mjs — headed CDP Performance trace for LiquidFun + metaball layer.
 *
 * Approximates GPU / raster cost via Chromium tracing categories. This is NOT the
 * DevTools "Composite Layers" panel. For present-bound jank, prefer overlay
 * Main Fps vs Main Step (e.g. 20 fps with 0.4 ms step).
 *
 * Usage:
 *   node tests/bench/liquidFun-gpu-trace.mjs
 *   node tests/bench/liquidFun-gpu-trace.mjs --headless
 *
 * Writes tests/results/liquidFun-gpu-trace.json (+ optional .trace.json.gz raw events).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const resultsDir = path.join(repoRoot, 'tests', 'results');
const WARMUP_MS = 2000;
const TRACE_MS = 3000;
const SPRAY_PARTICLE_TARGET = 8000;

const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-gpu.device',
  'disabled-by-default-gpu.proc_gpu',
  'disabled-by-default-gpu.debug',
  'disabled-by-default-raster',
  'disabled-by-default-v8.cpu_profiler',
  'toplevel',
  'blink.console',
  'disabled-by-default-loading',
].join(',');

function summarizeEvents(events) {
  const byName = new Map();
  let gpuishMs = 0;
  let totalMs = 0;

  for (const ev of events) {
    if (!ev || ev.ph !== 'X' || typeof ev.dur !== 'number') continue;
    const ms = ev.dur / 1000;
    totalMs += ms;
    const name = ev.name || '(unnamed)';
    const cat = String(ev.cat || '');
    const prev = byName.get(name) || { name, count: 0, ms: 0, cat };
    prev.count += 1;
    prev.ms += ms;
    byName.set(name, prev);

    const gpuHint =
      /gpu|raster|Draw|Composite|Viz|GL|WebGL|GPU/i.test(name) ||
      /gpu|raster/i.test(cat);
    if (gpuHint) gpuishMs += ms;
  }

  const top = [...byName.values()].sort((a, b) => b.ms - a.ms).slice(0, 25);
  return { eventCount: events.length, totalCompleteMs: totalMs, gpuishMs, top };
}

async function main() {
  const headless = process.argv.includes('--headless');
  await fs.mkdir(resultsDir, { recursive: true });

  const server = await createStaticBenchmarkServer(repoRoot);
  const baseUrl = `http://127.0.0.1:${server.port}`;

  let browser;
  try {
    try {
      browser = await chromium.launch({
        headless,
        channel: 'chrome',
        args: ['--enable-gpu', '--ignore-gpu-blocklist'],
      });
    } catch {
      browser = await chromium.launch({
        headless,
        args: ['--enable-gpu', '--ignore-gpu-blocklist'],
      });
    }

    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[gpu-trace] page error', error));

    await page.goto(`${baseUrl}/tests/bench/integrated-worker-benchmark.html`, {
      waitUntil: 'networkidle',
    });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, {
      timeout: 60000,
    });

    await page.evaluate(async () => {
      const sceneModule = '/demos/liquidFunDemoScene/liquidFunDemoScene.js';
      await window.__WEED_BENCHMARK__.prepare({
        sceneModule,
        sceneExport: 'LiquidFunDemoScene',
        warmupMs: 1,
        durationMs: 1,
      });
    });

    // Wait for LiquidFun / box2dReady
    await page.waitForFunction(
      () => {
        try {
          const scene = window.__WEED_BENCHMARK__.getScene();
          return Boolean(scene?.buffers?.liquidFunRender);
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 30000 }
    );
    await page.waitForTimeout(800);

    // Spray until we have a meaningful particle count for GPU fill.
    await page.evaluate(async (target) => {
      const { LiquidFun, Layer, LIQUIDFUN_FLAGS } = await import('/src/index.js').then((m) => m.default);
      const F = LIQUIDFUN_FLAGS;
      const layerId = Layer.getId('dulceDeLeche') || Layer.getId('water') || 0;
      let guard = 0;
      while (guard++ < 80) {
        const views = LiquidFun.getViews();
        const n = views?.count ? views.count[0] | 0 : 0;
        if (n >= target) break;
        LiquidFun.emit({
          flags: F.VISCOUS | F.TENSILE,
          viscousScale: 10,
          tint: 0xc6862a,
          shape: 'circle',
          posX: 1800 + (guard % 7) * 40,
          posY: 600 + (guard % 5) * 30,
          radius: 110,
          texture: '_metaball',
          layerId,
          scale: 19,
          alpha: 0.25,
        });
        await new Promise((r) => setTimeout(r, 50));
      }
    }, SPRAY_PARTICLE_TARGET);

    await page.waitForTimeout(WARMUP_MS);

    const client = await page.context().newCDPSession(page);
    await client.send('Tracing.start', {
      categories: TRACE_CATEGORIES,
      options: 'sampling-frequency=10000',
      transferMode: 'ReportEvents',
    });

    const chunks = [];
    client.on('Tracing.dataCollected', (params) => {
      if (params?.value?.length) chunks.push(...params.value);
    });

    const tracingComplete = new Promise((resolve) => {
      client.once('Tracing.tracingComplete', resolve);
    });

    await page.waitForTimeout(TRACE_MS);
    await client.send('Tracing.end');
    await tracingComplete;

    const events = chunks;
    const summary = summarizeEvents(events);
    const particleCount = await page.evaluate(() => {
      try {
        const { LiquidFun } = window.WEED || {};
        const views = LiquidFun?.getViews?.();
        return views?.count ? views.count[0] | 0 : -1;
      } catch {
        return -1;
      }
    });

    const out = {
      meta: {
        headless,
        warmupMs: WARMUP_MS,
        traceMs: TRACE_MS,
        particleCount,
        note:
          'CDP GPU/raster event sums — not DevTools Composite Layers UI. Prefer Main Fps vs Main Step for present-bound diagnosis.',
      },
      summary,
    };

    const jsonPath = path.join(resultsDir, 'liquidFun-gpu-trace.json');
    await fs.writeFile(jsonPath, JSON.stringify(out, null, 2));

    const rawPath = path.join(resultsDir, 'liquidFun-gpu-trace.events.json');
    await fs.writeFile(rawPath, JSON.stringify(events));

    console.log('\n=== LiquidFun GPU CDP trace ===');
    console.log(`  particles≈${particleCount}  headless=${headless}`);
    console.log(`  complete-events totalMs=${summary.totalCompleteMs.toFixed(1)}`);
    console.log(`  gpu/raster-ish Ms=${summary.gpuishMs.toFixed(1)}`);
    console.log('  top events:');
    for (const row of summary.top.slice(0, 12)) {
      console.log(`    ${row.ms.toFixed(1)} ms  ×${row.count}  ${row.name}`);
    }
    console.log(`  wrote ${jsonPath}`);
    console.log(`  wrote ${rawPath}`);

    await page.close();
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
