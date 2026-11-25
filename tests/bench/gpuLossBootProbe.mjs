/**
 * N-458's probe: what does the player see when the WebGL context is lost while the scene loads? A scene runs on the bench
 * page, and the Pixi worker's source is served with a prelude that takes its canvas's context and loses it
 * (WEBGL_lose_context) at a point of the load:
 *
 *   created   as soon as Pixi makes it (a GPU process that has gone)
 *   boot      a moment after, while the renderer's boot goes on (--boot-ms after it was made, default 30)
 *   init      as the worker's 'init' message arrives (the atlas, the shared buffers)
 *   late      --late-ms after 'init' (default 60): as the first frames are made
 *
 * (none: never, the control), and gives it back after --restore-ms (default -1: never). Each case prints whether the load
 * ended and when, whether the fatal error showed and what it says, how much of the canvas changed over a second (0: it draws
 * nothing), and the page's errors.
 *
 *   node tests/bench/gpuLossBootProbe.mjs [--case created] [--scene /demos/ballsScene/ballsScene.js] [--scene-export BallsScene]
 *     [--restore-ms -1] [--wait-ms 25000]
 *
 * Exit 1 when a case neither draws nor says so (the load waits for ever, or a black canvas without a word).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const CASES = ['none', 'created', 'boot', 'init', 'late'];
const cases = arg('case', '') ? arg('case', '').split(',') : CASES;
const sceneModule = arg('scene', '/demos/ballsScene/ballsScene.js');
const sceneExport = arg('scene-export', 'BallsScene');
const bootMs = Number(arg('boot-ms', '30'));
const lateMs = Number(arg('late-ms', '60'));
const restoreIndex = process.argv.indexOf('--restore-ms');
const restoreMs = restoreIndex >= 0 ? Number(process.argv[restoreIndex + 1]) : -1;
const waitMs = Number(arg('wait-ms', '25000'));

/** Runs in the worker, before its module's own code: the context Pixi makes on the page's canvas is lost at `when`. */
function prelude(o) {
  const real = OffscreenCanvas.prototype.getContext;
  let taken = null;
  const lose = () => {
    const ext = taken && taken.getExtension('WEBGL_lose_context');
    if (!ext) return;
    ext.loseContext();
    if (o.restoreMs >= 0) setTimeout(() => ext.restoreContext(), o.restoreMs);
  };
  OffscreenCanvas.prototype.getContext = function (kind, ...rest) {
    const gl = real.call(this, kind, ...rest);
    // The page's canvas is the big one; Pixi tests the browser on small ones of its own.
    if (gl && String(kind).startsWith('webgl') && taken === null && this.width >= 640) {
      taken = gl;
      if (o.when === 'created') lose();
      else if (o.when === 'boot') setTimeout(lose, o.bootMs);
    }
    return gl;
  };
  if (o.when === 'init' || o.when === 'late') {
    addEventListener('message', (e) => {
      if (e.data && e.data.msg === 'init') {
        if (o.when === 'init') lose();
        else setTimeout(lose, o.lateMs);
      }
    });
  }
}

async function probe(browser, port, when) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on('pageerror', (e) => messages.push(`pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || /lost|restor/i.test(m.text())) messages.push(`${m.type()}: ${m.text()}`);
  });
  let served = 0;
  await page.route(/\/src\/workers\/pixiWorker\.js/, async (route) => {
    const response = await route.fetch();
    served++;
    const body = await response.text();
    await route.fulfill({ response, body: `(${prelude.toString()})(${JSON.stringify({ when, restoreMs, bootMs, lateMs })});\n${body}` });
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1&backend=webgl`, {
      waitUntil: 'domcontentloaded', timeout: 120000,
    });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 60000 });
    const t0 = Date.now();
    await page.evaluate((o) => {
      window.__weedLoad = { done: false, error: '' };
      window.__WEED_BENCHMARK__.prepare({
        warmupMs: 100, durationMs: 100, sampleIntervalMs: 50, sceneModule: o.sceneModule, sceneExport: o.sceneExport,
        canvasWidth: 1280, canvasHeight: 720,
      }).then(() => { window.__weedLoad.done = true; }, (e) => { window.__weedLoad.error = String(e && e.message || e); });
    }, { sceneModule, sceneExport });
    let endMs = -1;
    try {
      await page.waitForFunction(() => {
        const overlay = document.getElementById('fatal-error-overlay');
        return window.__weedLoad.done || window.__weedLoad.error || overlay;
      }, undefined, { timeout: waitMs, polling: 50 });
      endMs = Date.now() - t0;
    } catch {
      // nothing in --wait-ms
    }
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => {
      const scene = window.__WEED_BENCHMARK__.getScene?.();
      const overlay = document.getElementById('fatal-error-overlay');
      return {
        ...window.__weedLoad,
        overlay: overlay ? overlay.innerText.replace(/\s+/g, ' ').slice(0, 220) : '',
        waiting: scene?.workerReadyStates ? Object.entries(scene.workerReadyStates).filter(([, r]) => !r).map(([n]) => n) : [],
      };
    });
    let moved = -1;
    try {
      const first = await captureCanvasPng(page);
      await page.waitForTimeout(1000);
      moved = (await diffPngs(page, first, await captureCanvasPng(page))).differing;
    } catch {
      // no canvas to capture
    }
    return { endMs, moved, served, state, messages };
  } finally {
    await page.close();
  }
}

const server = await createStaticBenchmarkServer(repoRoot, 0, {});
const launchArgs = ['--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows'];
let browser;
try {
  browser = await chromium.launch({ headless: false, channel: 'chrome', args: launchArgs });
} catch {
  browser = await chromium.launch({ headless: false, args: launchArgs });
}
let failed = false;
try {
  for (const when of cases) {
    const r = await probe(browser, server.port, when);
    const says = r.state.overlay !== '' || r.state.error !== '';
    const ok = r.served > 0 && (says || (r.state.done && r.moved > 0));
    if (!ok) failed = true;
    console.log(`${when}${restoreMs >= 0 ? ` (restored after ${restoreMs} ms)` : ''}: ${r.endMs >= 0 ? `ended ${r.endMs} ms` : `nothing in ${waitMs} ms`}, `
      + `loaded ${r.state.done ? 'yes' : 'no'}, moved ${r.moved} px, waiting for [${r.state.waiting.join(', ')}] -> ${ok ? (says ? 'SAYS SO' : 'DRAWS') : 'SILENT'}`);
    if (r.state.overlay) console.log(`  overlay: ${r.state.overlay}`);
    if (r.state.error) console.log(`  load error: ${r.state.error}`);
    for (const m of [...new Set(r.messages)].slice(0, 8)) console.log(`  ${m.slice(0, 240)}`);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
