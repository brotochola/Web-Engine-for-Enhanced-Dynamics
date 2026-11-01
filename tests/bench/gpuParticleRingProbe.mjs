#!/usr/bin/env node
/**
 * GPU particle rings over a window (E-161): for every GPU_PARTICLES layer of a running scene, each writer ring's
 * groups, records and overflows a second, read from the ring headers on the main thread (GpuParticles.layers).
 * Headed Chrome, the source, detailed stats off. The bench runner's timings say what the frame costs; this says how
 * many groups the calls made and whether writers lapped live particles.
 *
 *   node tests/bench/gpuParticleRingProbe.mjs [--scene /tests/bench/stressScenes/gpuParticlesStressScene.js]
 *        [--scene-export GpuParticlesStressScene] [--query "trail=300&sort=0"] [--warmup-ms 6000] [--window-ms 5000]
 *        [--root <dir>]   serve another tree (an ABAB worktree) with this script
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = parseArgs();
const sceneModule = String(args.scene ?? '/tests/bench/stressScenes/gpuParticlesStressScene.js');
const sceneExport = String(args['scene-export'] ?? 'GpuParticlesStressScene');
const query = typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '';
const warmupMs = Number(args['warmup-ms'] ?? 6000);
const windowMs = Number(args['window-ms'] ?? 5000);
const serveRoot = args.root ? path.resolve(String(args.root)) : repoRoot;

/** Every GPU layer's ring headers: [groups, published, overflow] per ring. */
async function readRings() {
  const { GpuParticles } = await import('/src/core/gpuParticles.js');
  const { GPU_RING } = await import('/src/util/gpuParticleLayout.js');
  return GpuParticles.layers.filter(Boolean).map((l) => ({
    name: l.name,
    sorted: l.sortWithEntities,
    rings: l.rings.map((r) => [
      Atomics.load(r.header, GPU_RING.GROUPS) >>> 0,
      Atomics.load(r.header, GPU_RING.PUBLISHED) >>> 0,
      Atomics.load(r.header, GPU_RING.OVERFLOW) >>> 0,
      r.capacity,
      r.groupCapacity,
    ]),
  }));
}

const server = await createStaticBenchmarkServer(serveRoot);
const url = `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${query ? `&${query}` : ''}`;
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (err) => console.error('[page error]', err));
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') console.log(`[page ${msg.type()}] ${msg.text().slice(0, 300)}`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(
    ({ m, e }) =>
      window.__WEED_BENCHMARK__.prepare({
        warmupMs: 1000,
        durationMs: 1000,
        sampleIntervalMs: 100,
        sceneModule: m,
        sceneExport: e,
        collectDetailedStats: false,
        collectGpuStats: false,
      }),
    { m: sceneModule, e: sceneExport },
  );
  await page.waitForTimeout(warmupMs);
  const a = await page.evaluate(readRings);
  const t0 = Date.now();
  await page.waitForTimeout(windowMs);
  const b = await page.evaluate(readRings);
  const s = (Date.now() - t0) / 1000;
  console.log(`${sceneExport}${query ? ` ?${query}` : ''}: ${s.toFixed(1)} s window`);
  for (let i = 0; i < b.length; i++) {
    const before = a[i];
    const after = b[i];
    after.rings.forEach((r, k) => {
      const [g0, p0, o0] = before.rings[k];
      const groups = ((r[0] - g0) >>> 0) / s;
      const records = ((r[1] - p0) >>> 0) / s;
      const overflows = ((r[2] - o0) >>> 0) / s;
      if (groups === 0 && records === 0 && overflows === 0) return;
      console.log(
        `  ${after.name}${after.sorted ? ' (sorted)' : ''} ring ${k}: ${groups.toFixed(0)} groups/s, ${records.toFixed(0)} records/s, ` +
          `${overflows.toFixed(0)} overflows/s (holds ${r[3]} records, ${r[4]} groups)`,
      );
    });
  }
} finally {
  await browser.close();
  await server.close();
}
