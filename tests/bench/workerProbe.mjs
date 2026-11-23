// Reads a running scene's worker state (E-395's question: why a frame's caster rows go whole). Opens the bench page on
// a scene, waits, then evaluates an expression inside each worker whose URL matches, with the worker's global as `self`
// (pre-render's instance is self.preRenderWorker, Pixi's self.pixiWorker), a few times a second; prints what it read.
//   node tests/bench/workerProbe.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene \
//     --query "dayCycle=0" --worker preRenderWorker --expr "({ kinds: self.preRenderWorker._casterKindsOn })"
//     [--wait-ms 12000] [--samples 5] [--interval-ms 250]
// Each line starts with the wall-clock seconds since the scene was prepared, so a long series (--samples 60
// --interval-ms 1000) shows how a state evolves.
// From Git Bash set MSYS_NO_PATHCONV=1. Headed Chrome (the bench's flags); read-only: the expression should not write.
import { chromium } from 'playwright';
import { parseArgs } from './microbenchHelpers.mjs';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { repoRoot } from './measureLib.mjs';

const args = parseArgs();
const scene = String(args.scene || '/demos/predatorScene/predatorScene.js');
const sceneExport = String(args['scene-export'] || 'PredatorScene');
const query = typeof args.query === 'string' ? args.query : '';
const match = String(args.worker || 'preRenderWorker');
const expr = String(args.expr || '({})');
const waitMs = Number(args['wait-ms'] ?? 12000);
const samples = Number(args.samples ?? 5);
const intervalMs = Number(args['interval-ms'] ?? 250);

const server = await createStaticBenchmarkServer(repoRoot);
const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const params = new URLSearchParams(`src=1&${query}`);
  await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(({ scene, sceneExport }) => window.__WEED_BENCHMARK__.prepare({
    warmupMs: 1000, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport, canvasWidth: 1280, canvasHeight: 720,
  }), { scene, sceneExport });
  const preparedAt = Date.now();
  await page.waitForTimeout(waitMs);
  const workers = page.workers().filter((w) => w.url().includes(match));
  if (workers.length === 0) throw new Error(`no worker matches ${match}: ${page.workers().map((w) => w.url()).join(', ')}`);
  for (let s = 0; s < samples; s++) {
    for (const w of workers) {
      const out = await w.evaluate(`(() => { try { return JSON.stringify(${expr}); } catch (e) { return 'error: ' + e.message; } })()`);
      const at = ((Date.now() - preparedAt) / 1000).toFixed(1);
      console.log(`${w.url().split('/').pop().split('?')[0]} [${s}] ${at} s: ${out}`);
    }
    await page.waitForTimeout(intervalMs);
  }
} finally {
  await browser.close();
  await server.close();
}
