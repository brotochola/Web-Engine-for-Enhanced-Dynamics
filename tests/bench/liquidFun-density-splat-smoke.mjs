// liquidFun-density-splat-smoke.mjs — headed smoke for densitySource:'liquidFun'
// Boots liquidFunDemoScene, waits for particles, asserts no page error.
//
// Usage: node tests/bench/liquidFun-density-splat-smoke.mjs [--headed]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { LAYER_DENSITY_SOURCE } from '../../src/core/ConfigDefaults.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const headed = process.argv.includes('--headed');

async function main() {
  const server = await createStaticBenchmarkServer(repoRoot);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(String(error?.stack || error));
    console.error('[smoke] page error', error);
  });

  try {
    await page.goto(`${baseUrl}/tests/bench/integrated-worker-benchmark.html`, {
      waitUntil: 'networkidle',
    });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, {
      timeout: 30000,
    });

    const result = await page.evaluate(async () => {
      const sceneModule = '/demos/liquidFunDemoScene/liquidFunDemoScene.js';
      await window.__WEED_BENCHMARK__.prepare({
        sceneModule,
        sceneExport: 'LiquidFunDemoScene',
        warmupMs: 1,
        durationMs: 1,
      });

      const WEED = (await import('/src/index.js')).default;
      const dulce = WEED.Layer.get('dulceDeLeche');
      const densitySource = dulce?.densitySource || null;
      const hasRenderQueue = dulce ? dulce.hasRenderQueue : null;

      await new Promise((r) => setTimeout(r, 1200));

      const views = WEED.LiquidFun.getViews();
      const count = views?.count ? views.count[0] | 0 : 0;
      return {
        densitySource,
        hasRenderQueue,
        particleCount: count,
        layerId: dulce?.id ?? -1,
      };
    });

    if (pageErrors.length) {
      throw new Error(`page errors:\n${pageErrors.join('\n')}`);
    }
    if (result.densitySource !== LAYER_DENSITY_SOURCE.LIQUID_FUN) {
      throw new Error(`expected densitySource liquidFun, got ${result.densitySource}`);
    }
    if (result.hasRenderQueue !== false) {
      throw new Error(`expected hasRenderQueue false, got ${result.hasRenderQueue}`);
    }
    if (!(result.particleCount > 0)) {
      throw new Error(`expected particles > 0, got ${result.particleCount}`);
    }

    console.log('OK liquidFun density splat smoke', result);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
