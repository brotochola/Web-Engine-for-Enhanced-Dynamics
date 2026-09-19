/**
 * Headed MESH look Y: WebGL vs WebGPU on MeshFillLookPanScene.
 * Compile must succeed. Screenshots are for Y (sky/empty vs fill), not speed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const outDir = path.join(repoRoot, 'tests/results/pixi-peel/h3-mesh-look/correctness');

async function runBackend(backend, port) {
  const errors = [];
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
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(
      `http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1&backend=${backend}`,
      { waitUntil: 'networkidle' },
    );
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(() =>
      window.__WEED_BENCHMARK__.prepare({
        warmupMs: 2500,
        durationMs: 800,
        sampleIntervalMs: 100,
        sceneModule: '/tests/bench/stressScenes/meshFillLookPanScene.js',
        sceneExport: 'MeshFillLookPanScene',
        canvasWidth: 1280,
        canvasHeight: 720,
      }),
    );
    await page.waitForTimeout(2800);
    await fs.mkdir(outDir, { recursive: true });
    const canvas = page.locator('canvas').first();
    await canvas.screenshot({ path: path.join(outDir, `${backend}.png`) });
    if (errors.length) {
      throw new Error(`${backend} look compile failed:\n${errors.slice(0, 8).join('\n')}`);
    }
    console.log(`ok MESH look ${backend} → ${outDir}/${backend}.png`);
  } finally {
    await browser.close();
  }
}

const server = await createStaticBenchmarkServer(repoRoot);
try {
  await runBackend('webgl', server.port);
  await runBackend('webgpu', server.port);
} finally {
  await server.close();
}
