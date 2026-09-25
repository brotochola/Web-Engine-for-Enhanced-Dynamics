/**
 * Headed F5/reload of Predator bitonic + collectDetailedStats.
 * Hang = fail. Not a speed bench.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const query = process.argv[2] || 'hour=0&zoom=1.5&bitonicEnc=one';

const server = await createStaticBenchmarkServer(repoRoot);
const url =
  `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1&${query}`;

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--enable-webgpu-developer-features',
    '--enable-dawn-features=allow_unsafe_apis',
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.setDefaultTimeout(60000);

let ok = false;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(() => window.__WEED_BENCHMARK__.prepare({
    warmupMs: 2000,
    durationMs: 500,
    sampleIntervalMs: 100,
    sceneModule: '/demos/predatorScene/predatorScene.js',
    sceneExport: 'PredatorScene',
    collectDetailedStats: true,
    collectGpuStats: true,
  }));
  await page.waitForTimeout(8000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(() => window.__WEED_BENCHMARK__.prepare({
    warmupMs: 2000,
    durationMs: 500,
    sampleIntervalMs: 100,
    sceneModule: '/demos/predatorScene/predatorScene.js',
    sceneExport: 'PredatorScene',
    collectDetailedStats: true,
    collectGpuStats: true,
  }));
  await page.waitForTimeout(5000);
  const alive = await page.evaluate(() => Boolean(window.__WEED_BENCHMARK__));
  ok = alive && errors.length === 0;
  console.log(ok ? 'F5 reload: ok' : `F5 reload: FAIL errors=${errors.join(' | ')}`);
} catch (e) {
  console.error('F5 reload: hang or throw', e.message || e);
  ok = false;
} finally {
  await browser.close();
  await server.close();
}
process.exit(ok ? 0 : 1);
