// Does a restored game play on as the game it was saved from? (N-329: a restored Predator looked lighter than a fresh
// one.) One run plays a scene fresh on the bench page, saves it at --save-at-ms (scene.saveGame), and samples an
// expression in the matching workers every --interval-ms for --after-ms more; a second page then starts from that very
// save (?restore=) and samples the same way. Same battle on both sides, so where the two series part is what the
// restore changed, not a different battle.
//   node tests/bench/restoreFidelity.mjs [--scene /demos/predatorScene/predatorScene.js] [--scene-export PredatorScene]
//     [--query "crowd=2.5&dayCycle=0"] [--worker logicWorker] [--expr-file <file.js>] [--save-at-ms 20000]
//     [--after-ms 10000] [--interval-ms 1000] [--measure-ms 0] [--keep <file.weedsave>]
// --measure-ms N then measures both sides over the same N ms after the series (the bench page's window): each worker's
// STEP_MS and, for physics, Moved and Awake, so the load a restored sitting sees is read against the game it came from.
// The default expression counts the active entities by type, the moving ones (speed over 0.5 px/s) and their mean
// speed; --expr-file evaluates its text (an expression) instead, with the worker's global as `self`.
// From Git Bash set MSYS_NO_PATHCONV=1. Headed Chrome (the bench's flags); the expression should not write.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseArgs } from './microbenchHelpers.mjs';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { repoRoot } from './measureLib.mjs';

const DEFAULT_EXPR = `(() => {
  const T = self.Transform, R = self.RigidBody;
  if (!T || !R) return 'no Transform/RigidBody on self';
  const rows = {};
  for (let i = 0; i < T.active.length; i++) {
    if (T.active[i] !== 1) continue;
    const t = T.entityType[i];
    const row = rows[t] || (rows[t] = { n: 0, moving: 0, speed: 0 });
    row.n++;
    if (R.active && R.active[i] === 1) {
      const v = Math.sqrt(R.vx[i] * R.vx[i] + R.vy[i] * R.vy[i]);
      if (v > 0.5) { row.moving++; row.speed += v; }
    }
  }
  const names = self.GameObject && self.GameObject.classByType;
  return Object.keys(rows).map((t) => {
    const r = rows[t];
    const name = names && names[t] ? names[t].name : t;
    return name + ' ' + r.n + '/' + r.moving + '@' + (r.moving ? (r.speed / r.moving).toFixed(1) : '0');
  }).join('  ');
})()`;

const args = parseArgs();
const scene = String(args.scene || '/demos/predatorScene/predatorScene.js');
const sceneExport = String(args['scene-export'] || 'PredatorScene');
const query = typeof args.query === 'string' ? args.query : 'crowd=2.5&dayCycle=0';
const match = String(args.worker || 'logicWorker');
const expr = args['expr-file'] ? fs.readFileSync(String(args['expr-file']), 'utf8').trim() : DEFAULT_EXPR;
const saveAtMs = Number(args['save-at-ms'] ?? 20000);
const afterMs = Number(args['after-ms'] ?? 10000);
const intervalMs = Number(args['interval-ms'] ?? 1000);
const measureMs = Number(args['measure-ms'] ?? 0);
// The save lives where the page can fetch it (the static server serves the checkout).
const savePath = path.resolve(String(args.keep || path.join(repoRoot, 'tests/results/restore/restoreFidelity.weedsave')));
const saveUrl = `/${path.relative(repoRoot, savePath).split(path.sep).join('/')}`;
if (saveUrl.startsWith('/..')) throw new Error(`--keep must be inside the checkout (${repoRoot}): ${savePath}`);

/** Opens the bench page on the scene (with `extraQuery`), returns the page once the scene runs. */
async function openScene(browser, port, extraQuery) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const params = new URLSearchParams(`src=1&${query}${extraQuery}`);
  await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(({ scene, sceneExport }) => window.__WEED_BENCHMARK__.prepare({
    warmupMs: 1000, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport, canvasWidth: 1280, canvasHeight: 720,
  }), { scene, sceneExport });
  return page;
}

/** The expression in the first matching worker (the others share the columns), with the seconds `t0` gives. */
async function sample(page, label, t0) {
  const workers = page.workers().filter((w) => w.url().includes(match));
  if (workers.length === 0) throw new Error(`no worker matches ${match}: ${page.workers().map((w) => w.url()).join(', ')}`);
  const out = await workers[0].evaluate(`(() => { try { const v = ${expr}; return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return 'error: ' + e.message; } })()`);
  console.log(`${label} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s: ${out}`);
}

/** The bench page's window of measureMs: each worker's STEP_MS (exact, all frames), WAIT_MS where it waits, physics' load. */
async function measure(page, label) {
  if (!(measureMs > 0)) return;
  await page.evaluate(() => window.__WEED_BENCHMARK__.beginMeasure());
  await page.waitForTimeout(measureMs);
  const result = await page.evaluate(() => window.__WEED_BENCHMARK__.collect());
  const parts = [];
  for (const w of result.workers || []) {
    const avg = w.statsSamplesAverage || {};
    const ex = w.exact;
    let s = `${w.id} ${(ex ? ex.stepMs : avg.STEP_MS || 0).toFixed(2)}`;
    if (ex && ex.waitMs > 0) s += ` (wait ${ex.waitMs.toFixed(2)})`;
    if (avg.BODY_MOVED_COUNT != null) s += ` moved ${Number(avg.BODY_MOVED_COUNT).toFixed(0)}`;
    if (avg.AWAKE_COUNT != null) s += ` awake ${Number(avg.AWAKE_COUNT).toFixed(0)}`;
    parts.push(s);
  }
  console.log(`${label} window ${measureMs} ms: ${parts.join(' | ')}`);
}

async function series(page, label, t0, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sample(page, label, t0);
    await page.waitForTimeout(intervalMs);
  }
}

const server = await createStaticBenchmarkServer(repoRoot);
const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  // 1. Fresh: play to the save, save, play on.
  const fresh = await openScene(browser, server.port, '');
  const freshAt = Date.now();
  await fresh.waitForTimeout(Math.max(0, saveAtMs - 2 * intervalMs));
  await sample(fresh, 'fresh   ', freshAt);
  await fresh.waitForTimeout(intervalMs);
  await sample(fresh, 'fresh   ', freshAt);
  const saved = await fresh.evaluate(async () => {
    const { default: WEED } = await import('/src/index.js');
    const slot = 'restore-fidelity';
    const meta = await window.scene.saveGame(slot);
    const bytes = await WEED.SaveStore.get(slot);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { entities: meta?.entityCount ?? null, base64: btoa(binary) };
  });
  console.log(`saved   ${((Date.now() - freshAt) / 1000).toFixed(1).padStart(5)} s: ${saved.entities} entities`);
  await series(fresh, 'fresh   ', freshAt, afterMs);
  await measure(fresh, 'fresh   ');
  await fresh.close();
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  fs.writeFileSync(savePath, Buffer.from(saved.base64, 'base64'));

  // 2. Restored from that save: the same span after it.
  const restoredAt = Date.now();
  const restored = await openScene(browser, server.port, `&restore=${encodeURIComponent(saveUrl)}`);
  const ranAt = Date.now();
  console.log(`restored (load ${((ranAt - restoredAt) / 1000).toFixed(1)} s)`);
  await series(restored, 'restored', ranAt - saveAtMs, afterMs);
  await measure(restored, 'restored');
  await restored.close();
  if (!args.keep) fs.unlinkSync(savePath);
} finally {
  await browser.close();
  await server.close();
}
