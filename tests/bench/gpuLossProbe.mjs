/**
 * N-301's probe: does a game come back after its GPU is lost? A scene runs on the bench page; the Pixi worker's
 * loseGpuForTest message loses the GPU as a driver reset would (WebGL: WEBGL_lose_context, restored after
 * --restore-ms; WebGPU: the device destroyed). The probe then waits for the engine to restart the scene from its save
 * and captures the canvas twice, a second apart. It prints whether the scene was replaced and how long that took,
 * whether the fatal error overlay showed, the lit pixels of each capture, how many pixels changed between the two
 * captures after the restart (0: the canvas is frozen) and against the one before the loss, and the page's errors.
 * The PNGs go to --out.
 *
 *   node tests/bench/gpuLossProbe.mjs [--backend webgl|webgpu] [--scene /demos/predatorScene/predatorScene.js]
 *     [--scene-export PredatorScene] [--query k=v&k=v] [--warmup-ms 5000] [--restore-ms 300] [--out tests/results/gpu-loss]
 *
 * Headed: WebGPU needs the GPU. Exit 1 when a backend does not come back (no restart, the overlay, or a frozen canvas).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { analyzePng, captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const backends = arg('backend', '') ? [arg('backend', '')] : ['webgl', 'webgpu'];
const sceneModule = arg('scene', '/demos/predatorScene/predatorScene.js');
const sceneExport = arg('scene-export', 'PredatorScene');
const query = arg('query', '');
const warmupMs = Number(arg('warmup-ms', '5000'));
const restoreMs = Number(arg('restore-ms', '300'));
const outDir = path.resolve(repoRoot, arg('out', 'tests/results/gpu-loss'));
const label = path.basename(sceneModule, '.js');

async function probe(browser, port, backend) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const messages = [];
  page.on('pageerror', (e) => messages.push(`pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || /lost|restor|GPU/i.test(m.text())) messages.push(`${m.type()}: ${m.text()}`);
  });
  try {
    const params = new URLSearchParams(`src=1&backend=${backend}${query ? `&${query}` : ''}`);
    await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?${params}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 60000 });
    await page.evaluate(
      (o) => {
        window.__weedGpuLossPrepare = window.__WEED_BENCHMARK__.prepare({
          warmupMs: o.warmupMs, durationMs: 1000, sampleIntervalMs: 100, sceneModule: o.sceneModule,
          sceneExport: o.sceneExport, canvasWidth: 1280, canvasHeight: 720,
        });
      },
      { warmupMs, sceneModule, sceneExport }
    );
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__.getScene()?.workers?.renderer), undefined, {
      timeout: 120000,
    });
    await page.waitForTimeout(warmupMs);
    const before = await captureCanvasPng(page);
    const lostAt = messages.length;
    const t0 = Date.now();
    await page.evaluate((ms) => {
      const scene = window.__WEED_BENCHMARK__.getScene();
      window.__weedGpuLossOld = scene;
      scene.workers.renderer.postMessage({ msg: 'loseGpuForTest', restoreAfterMs: ms });
    }, restoreMs);
    let restartMs = -1;
    try {
      await page.waitForFunction(
        () => {
          const old = window.__weedGpuLossOld;
          const game = old?.game;
          return Boolean(game && game.currentScene && game.currentScene !== old && game.state === 1);
        },
        undefined,
        { timeout: 30000, polling: 50 }
      );
      restartMs = Date.now() - t0;
    } catch {
      // no restart: the captures below show what stayed on screen
    }
    await page.waitForTimeout(2000);
    const after = await captureCanvasPng(page);
    await page.waitForTimeout(1000);
    const later = await captureCanvasPng(page);
    const overlay = await page.evaluate(() => Boolean(document.getElementById('fatal-error-overlay')));
    const lit = await Promise.all([before, after, later].map((png) => analyzePng(page, png)));
    const moving = await diffPngs(page, after, later);
    const againstBefore = await diffPngs(page, before, after);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, `${label}-${backend}-before.png`), before);
    await fs.writeFile(path.join(outDir, `${label}-${backend}-after.png`), after);
    // The page's load marks of the restart (the save's parts, then the load's), from the loss on.
    const marks = await page.evaluate(() => {
      const scene = window.__weedGpuLossOld?.game?.currentScene;
      return scene && scene !== window.__weedGpuLossOld ? scene._loadMarks.main.slice() : [];
    });
    return { restartMs, overlay, lit, moving, againstBefore, marks, messages: messages.slice(lostAt) };
  } finally {
    await page.close();
  }
}

const server = await createStaticBenchmarkServer(repoRoot, 0, {});
const launchArgs = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
let browser;
try {
  browser = await chromium.launch({ headless: false, channel: 'chrome', args: launchArgs });
} catch {
  browser = await chromium.launch({ headless: false, args: launchArgs });
}
let failed = false;
try {
  for (const backend of backends) {
    const r = await probe(browser, server.port, backend);
    const back = r.restartMs >= 0 && !r.overlay && r.moving.differing > 0 && r.lit[1].nonBlack > 0;
    if (!back) failed = true;
    const pct = (d) => `${((100 * d.differing) / d.pixels).toFixed(1)} %`;
    console.log(
      `${label} ${backend}: restart ${r.restartMs >= 0 ? `${r.restartMs} ms` : 'none'}, overlay ${r.overlay ? 'yes' : 'no'}, ` +
        `lit before/after ${r.lit[0].nonBlack}/${r.lit[1].nonBlack} of ${r.lit[0].pixels}, ` +
        `changed over the next second ${pct(r.moving)}, against before the loss ${pct(r.againstBefore)} -> ${back ? 'BACK' : 'NOT BACK'}`
    );
    const from = r.marks.indexOf('gpu lost');
    if (from >= 0) {
      const steps = [];
      for (let i = from + 2; i < r.marks.length; i += 2) {
        steps.push(`${r.marks[i]} +${Math.round(r.marks[i + 1] - r.marks[i - 1])}`);
      }
      console.log(`  restart marks (ms since the previous): ${steps.join(', ')}`);
    }
    for (const m of r.messages.slice(0, 12)) console.log(`  ${m}`);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
