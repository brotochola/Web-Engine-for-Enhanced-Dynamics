#!/usr/bin/env node
/**
 * The fast swap's four checks, in Chromium (VISUAL_EDITOR_PLAN.md ED-35, D3's tests). Each prints PASS or FAIL with
 * what it read; the exit code is the number of failures.
 *
 *   parity        the platformer, 1-1 then a swap to 1-2, against a full load of 1-2 in another page: the same
 *                 entities of each class, and every entity the file placed with the same components
 *   no leftovers  Predator (particles, decals, bullets, decorations, soldiers), run 4 s, then a swap to Predator:
 *                 right after it, every class holds what it held right after the first, full load, and no pool
 *                 warned it was full
 *   fallback      another scene class, and a scene marked dirty (as a runtime scenery change marks it), each load
 *                 fully, with the console line that says why
 *   no leak       100 swaps between 1-1 and 1-2: the page's heap after a full GC, and the commit charge of the
 *                 browser's processes (Windows), after the last against after the first
 *
 * The page is the bench page with ?src=1 (the source tree), headless, --expose-gc.
 *
 *   node tests/bench/fastSwapSmoke.mjs [--headed] [--swaps 100] [--only parity,leftovers,fallback,leak]
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const LEVELS = '/demos/platformerGameScene/levels';
const PREDATOR = '/demos/predatorScene/predatorScene.js';
const BALLS = '/demos/ballsScene/ballsScene.js';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SWAPS = Number(arg('swaps', 100));
const ONLY = new Set(String(arg('only', 'parity,leftovers,fallback,leak')).split(','));
/** What "within noise" allows after the last of the swaps, against after the first. */
const HEAP_GROWTH_MB = 5;
const COMMIT_GROWTH_MB = 64;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/** Windows: the commit charge (MB) of process `rootPid` and every process under it (sceneCycleSmoke.mjs). */
function commitMB(rootPid) {
  if (process.platform !== 'win32') return null;
  const json = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount | ConvertTo-Json -Compress'],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
  const rows = JSON.parse(json);
  const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ParentProcessId)) children.set(r.ParentProcessId, []);
    children.get(r.ParentProcessId).push(r.ProcessId);
  }
  let bytes = 0;
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    bytes += Number(byPid.get(pid)?.PrivatePageCount || 0);
    for (const child of children.get(pid) || []) stack.push(child);
  }
  return +(bytes / 1048576).toFixed(1);
}

async function enginePage(browser, port, log) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => log.errors.push(String(error)));
  page.on('console', (message) => log.console.push(message.text()));
  await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, { timeout: 30000 });
  await page.evaluate(async () => {
    const { default: WEED } = await import('/src/index.js');
    if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
    const game = new WEED.GameEngine({ autoResize: false, canvasWidth: 1280, canvasHeight: 720, injectStyles: false, debug: false });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    /** Each registered class's active entities, and the effect pools' active slots. */
    const counts = () => {
      const scene = game.currentScene;
      const out = {};
      for (const { class: C } of scene.registeredClasses) {
        let n = 0;
        for (let i = C.startIndex; i < C.endIndex; i++) n += WEED.Transform.active[i] ? 1 : 0;
        out[C.name] = n;
      }
      const activeOf = (Comp) => {
        const a = Comp.active;
        let n = 0;
        if (a) for (let i = 0; i < a.length; i++) n += a[i] ? 1 : 0;
        return n;
      };
      out['(particles)'] = activeOf(WEED.ParticleComponent);
      out['(bullets)'] = activeOf(WEED.BulletComponent);
      out['(decorations)'] = activeOf(WEED.DecorationComponent);
      return out;
    };
    /** The components of every entity the running file placed, by name (the fields a level sets). */
    const placed = () => {
      const scene = game.currentScene;
      const { Transform, Collider, SpriteRenderer, RigidBody } = WEED;
      const read = (Comp, fields, i) => Object.fromEntries(fields.map((f) => [f, Comp[f] ? Comp[f][i] : null]));
      const out = {};
      for (const record of scene.sceneFile?.entities || []) {
        const entity = scene.getByName(record.name);
        if (!entity) {
          out[record.name] = null;
          continue;
        }
        const i = entity.index;
        out[record.name] = {
          class: record.class,
          transform: read(Transform, ['x', 'y', 'rotation', 'active'], i),
          collider: read(Collider, ['active', 'shapeType', 'width', 'height', 'radius', 'offsetX', 'offsetY'], i),
          sprite: read(SpriteRenderer, ['active', 'baseTint', 'scaleX', 'scaleY', 'anchorX', 'anchorY', 'alpha'], i),
          body: read(RigidBody, ['active', 'static'], i),
        };
      }
      return out;
    };
    const heapMB = async () => {
      for (let k = 0; k < 3; k++) {
        if (typeof globalThis.gc === 'function') globalThis.gc();
        await sleep(100);
      }
      return +(performance.memory.usedJSHeapSize / 1048576).toFixed(2);
    };
    globalThis.__swap = { WEED, game, sleep, counts, placed, heapMB };
  });
  return page;
}

const load = (page, source, ms, options = {}) =>
  page.evaluate(
    async ({ source, ms, options }) => {
      const { game, sleep } = globalThis.__swap;
      const before = game.currentScene;
      await game.loadScene(source, options);
      await sleep(ms);
      return { sameScene: before !== null && game.currentScene === before };
    },
    { source, ms, options },
  );

const diff = (a, b) => {
  const out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(`${key}: ${JSON.stringify(a[key])} ≠ ${JSON.stringify(b[key])}`);
  }
  return out;
};

async function checkParity(browser, port, log) {
  let page = await enginePage(browser, port, log);
  await load(page, `${LEVELS}/1-1.scene.json`, 1000);
  const swap = await load(page, `${LEVELS}/1-2.scene.json`, 500);
  const swapped = await page.evaluate(() => ({ counts: globalThis.__swap.counts(), placed: globalThis.__swap.placed() }));
  await page.close();
  page = await enginePage(browser, port, log);
  await load(page, `${LEVELS}/1-2.scene.json`, 500);
  const full = await page.evaluate(() => ({ counts: globalThis.__swap.counts(), placed: globalThis.__swap.placed() }));
  await page.close();
  check('parity: 1-1 → 1-2 was a fast swap', swap.sameScene === true);
  const countDiff = diff(swapped.counts, full.counts);
  check('parity: the same entities of each class as a full load of 1-2', countDiff.length === 0, countDiff.join('; ') || JSON.stringify(full.counts));
  const placedDiff = diff(swapped.placed, full.placed);
  check('parity: every placed entity has the same components', placedDiff.length === 0 && Object.keys(full.placed).length > 0,
    placedDiff.slice(0, 3).join('; ') || `${Object.keys(full.placed).length} placed entities`);
}

async function checkLeftovers(browser, port, log) {
  const page = await enginePage(browser, port, log);
  let warnFrom = log.console.length;
  await load(page, PREDATOR, 300, { fullLoad: true });
  const first = await page.evaluate(() => globalThis.__swap.counts());
  await page.evaluate(() => globalThis.__swap.sleep(4000));
  // A pool Predator fills in play (its Flash pool, 32) warns in a full load too, and the swap re-arms the warning
  // as a new scene does: only a pool that did not fill in the full load would be the swap's leftovers.
  const fullInPlay = new Set(log.console.slice(warnFrom).filter((line) => line.includes('pool is full')).map(poolOf));
  const busy = await page.evaluate(() => globalThis.__swap.counts());
  // The world as the swap's clear leaves it, before the next level spawns anything.
  await page.evaluate(() => {
    const scene = globalThis.__swap.game.currentScene;
    const clear = scene._clearWorldForSwap;
    scene._clearWorldForSwap = async function () {
      await clear.call(this);
      globalThis.__swap.atClear = globalThis.__swap.counts();
    };
  });
  warnFrom = log.console.length;
  const swap = await load(page, PREDATOR, 300);
  const atClear = await page.evaluate(() => {
    delete globalThis.__swap.game.currentScene._clearWorldForSwap;
    return globalThis.__swap.atClear;
  });
  const after = await page.evaluate(() => globalThis.__swap.counts());
  await page.close();
  const newlyFull = log.console.slice(warnFrom).filter((line) => line.includes('pool is full') && !fullInPlay.has(poolOf(line)));
  check('no leftovers: Predator → Predator was a fast swap', swap.sameScene === true);
  const left = Object.entries(atClear || {}).filter(([, n]) => n !== 0);
  check('no leftovers: the clear leaves no entity of any class and nothing in the effect pools', atClear !== null && left.length === 0,
    left.length ? left.map(([k, n]) => `${k} ${n}`).join(', ') : `before the swap: ${JSON.stringify(busy)}`);
  const entityDiff = diff(
    Object.fromEntries(Object.entries(after).filter(([k]) => !k.startsWith('('))),
    Object.fromEntries(Object.entries(first).filter(([k]) => !k.startsWith('('))),
  );
  check('no leftovers: right after the swap each class holds what it held after the first load', entityDiff.length === 0,
    entityDiff.join('; ') || 'every class the same');
  check('no leftovers: no pool fills that a full load did not fill', newlyFull.length === 0,
    newlyFull.slice(0, 2).join(' | ') || `full in play as in a full load: ${[...fullInPlay].join(', ') || 'none'}`);
}

/** The pool a "pool is full" warning names. */
function poolOf(line) {
  return (/the (\S+) pool is full/.exec(line) || /the joint pool/.exec(line) || [line, line])[1];
}

async function checkFallback(browser, port, log) {
  const page = await enginePage(browser, port, log);
  await load(page, `${LEVELS}/1-1.scene.json`, 800);
  let from = log.console.length;
  const other = await load(page, BALLS, 800);
  let lines = log.console.slice(from).filter((line) => line.includes('loadScene: full load'));
  check('fallback: another scene class loads fully, and says why', other.sameScene === false && lines.some((l) => l.includes('BallsScene is not the running PlatformerGameScene')),
    lines.join(' | ') || 'no full-load line');

  await load(page, `${LEVELS}/1-1.scene.json`, 800);
  // What a runtime scenery change does (Layer.setStatic, setTilemap, clear, …): the scene is marked dirty.
  await page.evaluate(() => globalThis.__swap.WEED.Layer._sceneryChanged({ name: 'ground' }, 'setTilemap'));
  from = log.console.length;
  const dirty = await load(page, `${LEVELS}/1-2.scene.json`, 800);
  lines = log.console.slice(from).filter((line) => line.includes('loadScene: full load'));
  check('fallback: a dirty scene loads fully, and says why', dirty.sameScene === false && lines.some((l) => l.includes('the scene is dirty: layer "ground" changed its scenery (setTilemap)')),
    lines.join(' | ') || 'no full-load line');
  const clean = await load(page, `${LEVELS}/1-1.scene.json`, 500);
  check('fallback: the scene the full load made is clean again: the next load swaps', clean.sameScene === true);
  await page.close();
}

async function checkLeak(browser, port, log) {
  const page = await enginePage(browser, port, log);
  await load(page, `${LEVELS}/1-1.scene.json`, 800);
  await load(page, `${LEVELS}/1-2.scene.json`, 300);
  const heapFirst = await page.evaluate(() => globalThis.__swap.heapMB());
  const commitFirst = commitMB(process.pid);
  let swaps = 1;
  let allFast = true;
  const started = Date.now();
  while (swaps < SWAPS) {
    const r = await load(page, `${LEVELS}/${swaps % 2 ? '1-1' : '1-2'}.scene.json`, 50);
    allFast = allFast && r.sameScene;
    swaps++;
  }
  const seconds = (Date.now() - started) / 1000;
  await page.evaluate(() => globalThis.__swap.sleep(2000));
  const heapLast = await page.evaluate(() => globalThis.__swap.heapMB());
  const commitLast = commitMB(process.pid);
  await page.close();
  check(`no leak: ${SWAPS} loads in a row were all fast swaps`, allFast, `${(seconds / (SWAPS - 1)).toFixed(3)} s a swap with 50 ms of play`);
  check(`no leak: the page heap after ${SWAPS} swaps`, heapLast - heapFirst < HEAP_GROWTH_MB, `${heapFirst} MB after the first, ${heapLast} MB after the last`);
  if (commitFirst !== null) {
    check(`no leak: the browser's commit charge after ${SWAPS} swaps`, commitLast - commitFirst < COMMIT_GROWTH_MB, `${commitFirst} MB after the first, ${commitLast} MB after the last`);
  }
}

async function main() {
  const headed = process.argv.includes('--headed');
  const server = await createStaticBenchmarkServer(repoRoot);
  const browser = await chromium.launch({ headless: !headed, args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  const log = { errors: [], console: [] };
  try {
    if (ONLY.has('parity')) await checkParity(browser, server.port, log);
    if (ONLY.has('leftovers')) await checkLeftovers(browser, server.port, log);
    if (ONLY.has('fallback')) await checkFallback(browser, server.port, log);
    if (ONLY.has('leak')) await checkLeak(browser, server.port, log);
  } finally {
    await browser.close();
    await server.close();
  }
  check('no page errors', log.errors.length === 0, log.errors.slice(0, 3).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed;
}

await main();
