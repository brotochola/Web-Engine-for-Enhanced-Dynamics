/**
 * Headed WebGPU terrain: compile, hold C (remesh), hold D (follow).
 * Fails if the page logs a shader compile / GPUDevice error.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const outDir = path.join(repoRoot, 'tests/results/mesh-renderer-arch/webgpu/correctness');

const errors = [];

const server = await createStaticBenchmarkServer(repoRoot);
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => {
  const t = msg.text();
  if (/Failed to compile|textureSample must|GPUDevice is missing|Invalid ShaderModule/i.test(t)) {
    errors.push(t);
  }
});

try {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(
    `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1&benchRemesh=1`,
    { waitUntil: 'networkidle' },
  );
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(() =>
    window.__WEED_BENCHMARK__.prepare({
      warmupMs: 4000,
      durationMs: 1000,
      sampleIntervalMs: 100,
      sceneModule: '/demos/destructibleTerrainScene/destructibleTerrainScene.js',
      sceneExport: 'DestructibleTerrainScene',
      canvasWidth: 1920,
      canvasHeight: 1080,
    }),
  );
  await page.waitForTimeout(4500);
  await fs.mkdir(outDir, { recursive: true });
  const canvas = page.locator('canvas').first();
  await canvas.click({ position: { x: 960, y: 320 } });
  await canvas.screenshot({ path: path.join(outDir, '04-before-laser.png') });

  // Laser is C + left mouse, aimed at world under the cursor.
  await page.mouse.move(960, 280);
  await page.mouse.down();
  await page.keyboard.down('c');
  await page.waitForTimeout(2800);
  await canvas.screenshot({ path: path.join(outDir, '05-after-laser.png') });
  await page.keyboard.up('c');
  await page.mouse.up();

  await page.keyboard.down('d');
  await page.waitForTimeout(2000);
  await canvas.screenshot({ path: path.join(outDir, '06-after-thrust.png') });
  await page.keyboard.up('d');

  if (errors.length) {
    throw new Error(`WebGPU terrain correctness failed:\n${errors.slice(0, 8).join('\n')}`);
  }
  console.log(`ok WebGPU terrain compile + laser + thrust. shots in ${outDir}`);
} finally {
  await browser.close();
  await server.close();
}
