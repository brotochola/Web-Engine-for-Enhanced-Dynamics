#!/usr/bin/env node
/**
 * N-148: a still scene captured many times in one run (page screenshots of the canvas, headed Chrome on the real GPU):
 * for each capture, its pixels against the run's first capture, so a frame that drops what the others draw shows as an
 * outlier. A check, not a timing.
 *
 *   node tests/bench/captureSeriesProbe.mjs --scene /tests/bench/stressScenes/dxCaptureScene.js \
 *     --scene-export DxCaptureScene [--query k=v ...] [--wait-ms 3000] [--count 30] [--every-ms 100] [--save dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const opts = { query: [], waitMs: 3000, count: 30, everyMs: 100, save: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--scene') opts.scene = argv[++i];
  else if (a === '--scene-export') opts.sceneExport = argv[++i];
  else if (a === '--query') opts.query.push(argv[++i]);
  else if (a === '--wait-ms') opts.waitMs = Number(argv[++i]);
  else if (a === '--count') opts.count = Number(argv[++i]);
  else if (a === '--every-ms') opts.everyMs = Number(argv[++i]);
  else if (a === '--save') opts.save = argv[++i];
}
if (!opts.scene || !opts.sceneExport) throw new Error('usage: --scene <path> --scene-export <Class>');

const server = await createStaticBenchmarkServer(repoRoot);
const browser = await chromium.launch({ headless: false, args: ['--mute-audio'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const params = new URLSearchParams('src=1');
  for (const pair of opts.query) {
    const [k, v = ''] = pair.split('=');
    params.set(k, v);
  }
  await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(({ scene, sceneExport, waitMs }) => window.__WEED_BENCHMARK__.prepare({
    warmupMs: waitMs, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport, canvasWidth: 1280, canvasHeight: 720,
  }), { scene: opts.scene, sceneExport: opts.sceneExport, waitMs: opts.waitMs });
  await page.waitForTimeout(opts.waitMs);
  const shots = [];
  for (let k = 0; k < opts.count; k++) {
    shots.push(await captureCanvasPng(page));
    await page.waitForTimeout(opts.everyMs);
  }
  const rows = [];
  for (let k = 0; k < shots.length; k++) {
    const d = await diffPngs(page, shots[0], shots[k]);
    rows.push(d.differing);
  }
  console.log(JSON.stringify({ scene: opts.sceneExport, query: opts.query, againstFirst: rows }));
  if (opts.save) {
    fs.mkdirSync(opts.save, { recursive: true });
    shots.forEach((png, k) => fs.writeFileSync(path.join(opts.save, `shot-${String(k).padStart(2, '0')}.png`), png));
  }
} finally {
  await browser.close();
  await server.close();
}
