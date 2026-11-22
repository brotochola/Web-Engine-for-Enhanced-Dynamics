#!/usr/bin/env node
/**
 * DBG-5's render views on a still scene, as the debug UI's Render tab asks for them: the page posts
 * `{ msg: 'setRenderView', view, opacity }` to the renderer worker for each view the scene has (its answer,
 * `renderViews`, lists them), captures the canvas, and ends on Final. It prints, per view, how much of the picture it
 * changed against Final, and whether Final came back pixel-equal (a still scene must). --save keeps every capture.
 *
 *   node tests/bench/renderViewProbe.mjs --scene /demos/lightBenchScene/lightBenchScene.js --scene-export LightBenchScene \
 *     --query still=1 [--query backend=webgpu] [--views 1,2,5] [--opacity 1] [--save <dir>]
 *
 * --views: only these view ids (renderViews.js RENDER_VIEW), else every one the scene has. --wait-ms (default 3000)
 * before the first capture, --step-ms (default 800) after each view. Headed Chrome (a real GPU); --headless for a check
 * without one. Exit 1 on a page error, or when Final does not come back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';
import { RENDER_VIEWS } from '../../src/render/renderViews.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };

function parseCli(argv) {
  const opts = { query: [], views: null, opacity: 1, waitMs: 3000, stepMs: 800, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--scene') opts.scene = next();
    else if (arg === '--scene-export') opts.sceneExport = next();
    else if (arg === '--query') opts.query.push(next());
    else if (arg === '--views') opts.views = next().split(',').map(Number);
    else if (arg === '--opacity') opts.opacity = Number(next());
    else if (arg === '--wait-ms') opts.waitMs = Number(next());
    else if (arg === '--step-ms') opts.stepMs = Number(next());
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--save') opts.save = next();
    else throw new Error(`renderViewProbe: unknown argument ${arg}`);
  }
  if (!opts.scene || !opts.sceneExport) throw new Error('renderViewProbe: --scene and --scene-export are required');
  return opts;
}

/** Posts a message to the renderer worker and waits for its renderViews answer. */
function askRenderer(page, message) {
  return page.evaluate((message) => new Promise((resolve, reject) => {
    const worker = window.scene?.workers?.renderer;
    if (!worker) {
      reject(new Error('no window.scene.workers.renderer'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('no renderViews answer in 5 s')), 5000);
    const onMessage = (e) => {
      if (e.data?.msg !== 'renderViews') return;
      worker.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve({ views: e.data.views, view: e.data.view });
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(message);
  }), message);
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const browser = await chromium.launch({
    headless: opts.headless,
    channel: 'chrome',
    args: ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu'],
  });
  const server = await createStaticBenchmarkServer(repoRoot);
  const errors = [];
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const params = new URLSearchParams('src=1');
    for (const pair of opts.query) {
      const [key, value = ''] = pair.split('=');
      params.set(key, value);
    }
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(
      ({ scene, sceneExport, waitMs, size }) =>
        window.__WEED_BENCHMARK__.prepare({
          warmupMs: waitMs, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport,
          canvasWidth: size.width, canvasHeight: size.height,
        }),
      { scene: opts.scene, sceneExport: opts.sceneExport, waitMs: opts.waitMs, size: VIEWPORT },
    );
    await page.waitForTimeout(opts.waitMs);
    const diffPage = await browser.newPage();
    const save = (name, png) => {
      if (!opts.save) return;
      fs.mkdirSync(opts.save, { recursive: true });
      fs.writeFileSync(path.join(opts.save, `${name}.png`), png);
    };
    const pixels = VIEWPORT.width * VIEWPORT.height;
    const pct = (d) => `${((100 * d.differing) / pixels).toFixed(2)} % (max ${d.maxDelta})`;
    const has = await askRenderer(page, { msg: 'listRenderViews' });
    const labels = Object.fromEntries(RENDER_VIEWS.map((v) => [v.id, v.label]));
    console.log(`renderViewProbe ${opts.sceneExport} [${opts.query.join(' ')}]: views ${has.views.map((v) => `${v} ${labels[v]}`).join(', ')}`);
    const final = await captureCanvasPng(page);
    save('00-final', final);
    const views = (opts.views || has.views).filter((v) => v !== 0);
    for (const view of views) {
      const got = await askRenderer(page, { msg: 'setRenderView', view, opacity: opts.opacity });
      await page.waitForTimeout(opts.stepMs);
      const png = await captureCanvasPng(page);
      const d = await diffPngs(diffPage, final, png);
      save(`${String(view).padStart(2, '0')}-${labels[view].replace(/[^A-Za-z]+/g, '-')}`, png);
      console.log(`  ${String(view).padStart(2)} ${String(labels[view]).padEnd(20)} ${got.view === view ? 'drawn' : `refused (got ${got.view})`}, against Final ${pct(d)}`);
    }
    await askRenderer(page, { msg: 'setRenderView', view: 0, opacity: 1 });
    await page.waitForTimeout(opts.stepMs);
    const back = await captureCanvasPng(page);
    save('99-final-after', back);
    const restored = await diffPngs(diffPage, final, back);
    console.log(`  Final again: still differs ${pct(restored)}`);
    if (restored.differing > 0) failed = true;
    await diffPage.close();
    await page.close();
  } finally {
    await server.close();
    await browser.close();
  }
  if (errors.length) {
    failed = true;
    console.log(`page errors: ${errors.slice(0, 5).join(' | ')}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
