#!/usr/bin/env node
/**
 * SST-0, the load waterfall (SCENE_STARTUP_TIME_PLAN.md): every phase of a scene's start on the page and in each
 * worker, on one clock, from `game.loadScene` to the renderer's first drawn frame, and the longest step of each worker in
 * the first seconds after it.
 *
 * The engine marks its phases (src/util/loadMarks.js: `loadMark(name)`, performance.timeOrigin + performance.now(), the
 * same clock on every thread); each worker posts its marks with its ready message and Pixi again at its first frame
 * drawn once the game runs ('first draw'); the page keeps them on the scene (scene._loadMarks). This runner opens the
 * bench page (tests/bench/integratedWorkerBenchmark.html, the engine from source unless --bundle), loads the scene
 * through __WEED_BENCHMARK__.prepare, waits for 'first draw' and then --settle-ms more, and reads:
 *   - the marks, as each thread's timeline in ms after the page's `loadScene` mark (t0); the page's own marks also
 *     after navigation start (the page's timeOrigin: the module loads and the bench page's own setup come before t0);
 *   - the chain that ended last at each join of the load (which asset branch the workers' init waited for, which
 *     worker the start waited for, then the renderer's first draw): the load's critical path;
 *   - each worker's longest own step (STEP_MS - WAIT_MS, frameTotals' histogram, 0.125 ms bins) from the start to the
 *     end of the settle window: a load that leaves work for the first frames shows there.
 *
 *   node tests/bench/loadWaterfall.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
 *     [--query "light3d=1&hour=22"] [--runs 3] [--visits cold,warm] [--settle-ms 5000] [--bundle] [--headless]
 *     [--canvas 1920x1080] [--output report.json]
 *
 * --visits: `cold` is a fresh browser context (empty HTTP and code caches); `warm` is a second load of the same page in
 * that context (its caches filled by the cold visit). Each run makes the visits in that order. Medians over runs are
 * printed for the milestones. From Git Bash set MSYS_NO_PATHCONV=1 (the scene path) and give --output a Windows path.
 * Headed by default: a headless Chrome draws on a software path, whose start is not the real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { benchWindowArgs, rememberBenchWindow } from './benchWindow.mjs';
import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page's milestones the summary prints, in load order (a missing one prints as a dash). */
export const MILESTONES = [
  'scene init',
  'audio',
  'scripts',
  'box2d block',
  'buffers',
  'workers made',
  'atlas',
  'tilemaps',
  'flowfields',
  'shaders',
  'sounds',
  'assets',
  'init sent',
  'workers',
  'preload',
  'create',
  'world',
  'start',
  'loadScene end',
];
/** The asset branches preloadAssets runs side by side; the workers' init waits for the last. */
const ASSET_BRANCHES = ['adobe', 'atlas', 'tilemaps', 'flowfields', 'shaders', 'sounds'];

/** [name, ms, name, ms, …] as [{ name, t }]. */
export function pairs(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ name: String(flat[i]), t: Number(flat[i + 1]) });
  return out;
}

/** The first mark called `name` (or undefined). */
function at(list, name) {
  for (const m of list) if (m.name === name) return m.t;
  return undefined;
}

/**
 * The load's critical path from the marks, relative to t0: which asset branch ended last before the workers got their
 * init, which worker's ready came last before the scene's 'workers' step (and that worker's slowest phase), then the
 * page's steps to the start and the renderer's first draw.
 * @param {{ main: Array, workers: Record<string, Array> }} marks the scene's _loadMarks (flat lists)
 */
export function waterfall(marks) {
  const main = pairs(marks.main || []);
  const t0 = at(main, 'loadScene');
  if (t0 === undefined) throw new Error('no loadScene mark: is this engine older than SST-0?');
  const workers = {};
  for (const [name, flat] of Object.entries(marks.workers || {})) workers[name] = pairs(flat);
  const rel = (t) => (t === undefined ? undefined : t - t0);

  const branchEnds = ASSET_BRANCHES.map((b) => ({ name: b, t: rel(at(main, b)) })).filter((b) => b.t !== undefined);
  branchEnds.sort((a, b) => b.t - a.t);
  const readies = Object.keys(workers)
    .map((name) => ({ name, t: rel(at(main, `ready ${name}`)) }))
    .filter((r) => r.t !== undefined)
    .sort((a, b) => b.t - a.t);
  const lastWorker = readies[0]?.name;
  let slowestPhase = null;
  if (lastWorker) {
    const list = workers[lastWorker];
    // Its own work starts at its init: before that it waits for the page (the assets), which the chain names already.
    let from = list.findIndex((m) => m.name === 'init');
    if (from < 0) from = 0;
    // And it ends at its ready: after that it waits for the page's start.
    let to = list.findIndex((m) => m.name === 'ready');
    if (to < 0) to = list.length - 1;
    for (let i = from + 1; i <= to; i++) {
      const d = list[i].t - list[i - 1].t;
      if (!slowestPhase || d > slowestPhase.ms) slowestPhase = { from: list[i - 1].name, to: list[i].name, ms: d };
    }
  }
  const firstDraw = rel(at(workers.renderer || [], 'first draw'));
  return {
    t0,
    main: main.map((m) => ({ name: m.name, ms: m.t - t0 })),
    workers: Object.fromEntries(Object.entries(workers).map(([n, l]) => [n, l.map((m) => ({ name: m.name, ms: m.t - t0 }))])),
    lastAsset: branchEnds[0] || null,
    assets: rel(at(main, 'assets')),
    initSent: rel(at(main, 'init sent')),
    lastWorker: readies[0] || null,
    lastWorkerSlowest: slowestPhase,
    workersReady: rel(at(main, 'workers')),
    start: rel(at(main, 'start')),
    loadSceneEnd: rel(at(main, 'loadScene end')),
    firstDraw,
  };
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(0).padStart(6) : '     -');

/** In the page: the load marks once the renderer's first draw is in, else null. */
function readMarks() {
  const s = window.game && window.game.currentScene;
  const lm = s && s._loadMarks;
  if (!lm || !lm.workers.renderer || !lm.workers.renderer.includes('first draw')) return null;
  return { main: lm.main.slice(), workers: JSON.parse(JSON.stringify(lm.workers)), pageOrigin: performance.timeOrigin };
}

/** In the page: each frame-clock slot's frames and longest own step so far (frameTotals' histogram). */
async function readLongestSteps() {
  const s = window.game && window.game.currentScene;
  const sab = s && s.buffers && s.buffers.frameTotals;
  if (!sab) return null;
  const ft = await import('/src/util/frameTotals.js');
  const fc = await import('/src/util/frameClock.js');
  const f64 = new Float64Array(sab);
  const u32 = new Uint32Array(sab);
  const names = {};
  for (const [k, v] of Object.entries(fc.FRAME_CLOCK_SLOTS)) names[v] = k;
  const nLogic = s.numberOfLogicWorkers | 0;
  const nSpatial = (s.config && s.config.spatial && s.config.spatial.numberOfSpatialWorkers) | 0;
  for (let i = 0; i < nLogic; i++) names[fc.LOGIC_SLOT0 + i] = `logic${i}`;
  for (let i = 0; i < nSpatial; i++) names[fc.SPATIAL_SLOT0 + i] = `spatial${i}`;
  const out = {};
  for (const [slot, name] of Object.entries(names)) {
    const base = Number(slot) * ft.SLOT_BYTES;
    const frames = f64[base / 8 + 1];
    if (!(frames > 0)) continue;
    const hist = (base + ft.HEADER_BYTES) / 4;
    let top = -1;
    for (let b = ft.HIST_BINS - 1; b >= 0; b--) {
      if (u32[hist + b] > 0) {
        top = b;
        break;
      }
    }
    out[name] = { frames, longestMs: top < 0 ? 0 : (top + 1) * ft.HIST_BIN_MS, capped: top === ft.HIST_BINS - 1 };
  }
  return out;
}

async function visitOnce(page, url, opts) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 60000 });
  await page.evaluate(
    (o) => window.__WEED_BENCHMARK__.prepare(o),
    {
      sceneModule: opts.scene,
      sceneExport: opts.sceneExport,
      collectDetailedStats: false,
      canvasWidth: opts.canvasWidth,
      canvasHeight: opts.canvasHeight,
    },
  );
  const deadline = Date.now() + 120000;
  let marks = null;
  while (!marks) {
    if (Date.now() > deadline) throw new Error('no first draw within 120 s of the load');
    await sleep(100);
    marks = await page.evaluate(readMarks);
  }
  await sleep(opts.settleMs);
  const steps = await page.evaluate(readLongestSteps);
  return { marks, steps };
}

async function main() {
  const args = parseArgs();
  if (!args.scene || !args['scene-export']) {
    console.error('usage: loadWaterfall.mjs --scene /path/scene.js --scene-export Name [--query k=v&…] [--runs 3]');
    process.exit(2);
  }
  const [cw, ch] = String(args.canvas || '1920x1080').split('x').map(Number);
  const opts = {
    scene: String(args.scene),
    sceneExport: String(args['scene-export']),
    settleMs: Number(args['settle-ms'] ?? 5000),
    canvasWidth: cw,
    canvasHeight: ch,
  };
  const runs = Number(args.runs ?? 3);
  const visits = String(args.visits || 'cold').split(',');
  const headed = !args.headless;
  const qs = [];
  if (!args.bundle) qs.push('src=1');
  if (typeof args.query === 'string' && args.query) qs.push(args.query.replace(/^\?/, ''));
  const server = await createStaticBenchmarkServer(repoRoot, 0);
  const url = `${server.baseUrl ?? `http://127.0.0.1:${server.port}`}/tests/bench/integratedWorkerBenchmark.html${qs.length ? `?${qs.join('&')}` : ''}`;
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !headed,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...(headed ? benchWindowArgs() : ['--enable-unsafe-swiftshader']),
    ],
  });
  const results = [];
  try {
    for (let r = 0; r < runs; r++) {
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
      for (const visit of visits) {
        const { marks, steps } = await visitOnce(page, url, opts);
        const w = waterfall(marks);
        const navToT0 = w.t0 - marks.pageOrigin;
        results.push({ run: r, visit, navToT0, waterfall: w, steps });
        console.log(
          `run ${r} ${visit}: first draw ${w.firstDraw?.toFixed(0)} ms after loadScene (${(w.firstDraw + navToT0).toFixed(0)} after navigation); `
          + `assets ${w.assets?.toFixed(0)}, last ${w.lastAsset?.name} ${w.lastAsset?.t.toFixed(0)}; init sent ${w.initSent?.toFixed(0)}; `
          + `workers ready ${w.workersReady?.toFixed(0)} (last ${w.lastWorker?.name}); start ${w.start?.toFixed(0)}`,
        );
      }
      if (headed) await rememberBenchWindow(page).catch(() => {});
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }

  for (const visit of visits) {
    const rs = results.filter((x) => x.visit === visit);
    console.log(`\n== ${opts.sceneExport} ${args.query || ''} ${args.bundle ? 'bundle' : 'src'}, ${visit}, ${rs.length} runs: median ms after loadScene ==`);
    const last = rs[rs.length - 1].waterfall;
    console.log('page:');
    for (const name of MILESTONES) {
      const vals = rs.map((x) => x.waterfall.main.find((m) => m.name === name)?.ms);
      if (vals.every((v) => v === undefined)) continue;
      console.log(`  ${fmt(median(vals))}  ${name}`);
    }
    console.log(`  ${fmt(median(rs.map((x) => x.navToT0)))}  (loadScene after navigation)`);
    for (const name of Object.keys(last.workers).sort()) {
      console.log(`${name}:`);
      for (const m of last.workers[name]) {
        const vals = rs.map((x) => (x.waterfall.workers[name] || []).find((k) => k.name === m.name)?.ms);
        console.log(`  ${fmt(median(vals))}  ${m.name}`);
      }
    }
    console.log('critical path (last run):');
    console.log(`  assets: the last branch ${last.lastAsset?.name} at ${fmt(last.lastAsset?.t)}; init sent ${fmt(last.initSent)}`);
    console.log(
      `  workers: the last ready ${last.lastWorker?.name} at ${fmt(last.lastWorker?.t)}`
      + (last.lastWorkerSlowest ? `, its longest phase ${last.lastWorkerSlowest.from} -> ${last.lastWorkerSlowest.to} ${last.lastWorkerSlowest.ms.toFixed(0)} ms` : ''),
    );
    console.log(`  start ${fmt(last.start)}; renderer first draw ${fmt(last.firstDraw)}; loadScene resolved ${fmt(last.loadSceneEnd)}`);
    console.log(`longest own step from the start to ${opts.settleMs} ms after the first draw (median over runs, ms):`);
    const names = Object.keys(rs[0].steps || {});
    for (const n of names) {
      // The histogram's last bin holds every step from 127.875 ms up: "≥".
      const capped = rs.some((x) => x.steps?.[n]?.capped);
      console.log(`  ${capped ? '≥' : ' '}${fmt(median(rs.map((x) => x.steps?.[n]?.longestMs)))}  ${n}`);
    }
  }
  if (args.output) {
    fs.writeFileSync(String(args.output), JSON.stringify({ scene: opts, query: args.query || '', bundle: !!args.bundle, results }, null, 2));
    console.log(`\nwrote ${args.output}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
