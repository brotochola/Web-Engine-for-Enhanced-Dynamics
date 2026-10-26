#!/usr/bin/env node
/**
 * ED-39 (VISUAL_EDITOR_PLAN.md): how long a full scene load takes, phase by phase, so the fast swap (ED-35) knows
 * which phases it skips and what they cost.
 *
 * One page (the integrated benchmark page, source tree with ?src=1), one GameEngine, the scene loaded N + 1 times in
 * a row: the first load is the cold one a player sees (modules and WASM compiled, assets fetched for the first
 * time), the rest are the scene changes a game makes, which is what a fast swap replaces. Each load runs 2 s before
 * the next, so the next one also pays the previous scene's teardown.
 *
 * Phases come from three sources, all read on the page:
 *   - loadScene's onProgress stages (audio, scripts, buffers, workers, adobe, the asset stages, world);
 *   - the scene's own hooks, wrapped on the page's copy of the scene module (preload, create, createNewGame,
 *     _flushCreateSpawns) and Layer.applyConfiguredContent; the workers import their own copy, so nothing they run
 *     changes, and src/ gets no marks;
 *   - the previous scene's destroy, and the renderer's first published frame (frame totals, slot "renderer").
 * Each phase is the time from the event before it to its own end; a wrapped hook also reports the gap before it.
 *
 *   node tests/bench/sceneLoadPhases.mjs [--scene /demos/predatorScene/predatorScene.js] [--scene-export PredatorScene]
 *     [--loads 5] [--settle-ms 2000] [--swap] [--headed] [--dist] [--output tests/results/ed39-predator.json]
 *
 * Every load is a full one ({ fullLoad: true }); with --swap the warm loads may be fast swaps (ED-35), timed the
 * same way to the first frame the renderer publishes after them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { parseArgs, writeReport } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Median, min and max of a list of numbers. */
function spread(values) {
  const v = values.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = v.length;
  if (n === 0) return null;
  const median = n % 2 ? v[(n - 1) >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return { median: +median.toFixed(1), min: +v[0].toFixed(1), max: +v[n - 1].toFixed(1) };
}

async function runPage(page, { sceneModule, sceneExport, loads, settleMs, swap }) {
  await page.evaluate(
    async ({ sceneModule, sceneExport }) => {
      const [{ default: WEED }, sceneNs, totalsModule, clockModule] = await Promise.all([
        import('/src/index.js'),
        import(sceneModule),
        import('/src/util/frameTotals.js'),
        import('/src/util/frameClock.js'),
      ]);
      if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
      const SceneClass = sceneNs[sceneExport];
      if (!SceneClass) throw new Error(`Scene export "${sceneExport}" not found in ${sceneModule}`);

      const state = { events: [], t0: 0 };
      const now = () => performance.now() - state.t0;
      const mark = (name) => state.events.push({ name, t: now() });

      // Wrap a method so its start and end are events. `owner` is a prototype or a class (static).
      const wrap = (owner, key, label) => {
        const original = owner[key];
        if (typeof original !== 'function') return;
        owner[key] = async function wrapped(...args) {
          mark(`${label}:start`);
          try {
            return await original.apply(this, args);
          } finally {
            mark(label);
          }
        };
      };
      const proto = SceneClass.prototype;
      wrap(proto, 'preload', 'preload');
      wrap(proto, 'create', 'create');
      wrap(proto, 'createNewGame', 'createNewGame');
      wrap(proto, '_flushCreateSpawns', 'flushCreateSpawns');
      wrap(proto, 'destroy', 'previousDestroy');
      wrap(WEED.Layer, 'applyConfiguredContent', 'applyConfiguredContent');

      const game = new WEED.GameEngine({
        autoResize: false,
        canvasWidth: 800,
        canvasHeight: 600,
        injectStyles: false,
        preventContextMenu: false,
        preventDefaultKeys: false,
        debug: false,
      });
      globalThis.__loadPhases = { WEED, game, sceneModule, sceneExport, state, mark, totalsModule, clockModule };
    },
    { sceneModule, sceneExport }
  );

  const results = [];
  for (let i = 0; i <= loads; i++) {
    // The first load is always full; with --swap the warm ones may be fast swaps (ED-35).
    const fullLoad = i === 0 || !swap;
    const one = await page.evaluate(async ({ settleMs, fullLoad }) => {
      const { game, sceneModule, sceneExport, state, mark, totalsModule, clockModule } = globalThis.__loadPhases;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const slot = clockModule.FRAME_CLOCK_SLOTS.renderer;
      const framesOf = (scene) => {
        const view = scene?.buffers?.frameTotals ? totalsModule.bindFrameTotals(scene.buffers.frameTotals) : null;
        const totals = view ? totalsModule.readTotals(view, slot) : null;
        return { view, frames: totals ? totals.frames : 0 };
      };
      const before = game.currentScene;
      const framesBefore = framesOf(before).frames;
      state.events = [];
      state.t0 = performance.now();
      mark('start');
      await game.loadScene(sceneModule, {
        export: sceneExport,
        fullLoad,
        onProgress: (_done, _total, stage) => mark(`stage:${stage}`),
      });
      mark('loadSceneReturned');

      // First frame the renderer publishes after the load. A fast swap keeps the frame
      // totals (same scene, same buffers): its first frame is the count rising past where
      // it was before the load.
      const scene = game.currentScene;
      const swapped = scene === before;
      const { view } = framesOf(scene);
      if (view) {
        const baseline = swapped ? framesBefore : 0;
        const deadline = performance.now() + 10000;
        for (;;) {
          const totals = totalsModule.readTotals(view, slot);
          if (totals && totals.frames > baseline) break;
          if (performance.now() > deadline) break;
          await sleep(1);
        }
        mark('firstRenderedFrame');
      }
      const events = state.events.slice();
      await sleep(settleMs);
      return { events, swapped };
    }, { settleMs, fullLoad });
    results.push(one);
  }
  return results;
}

/**
 * Turn one load's events into phases: each event closes the phase that ran since the previous event. A wrapped
 * hook's ":start" event closes the gap before it, reported as "before <hook>".
 */
function phasesOf(events) {
  const out = [];
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const ms = e.t - events[i - 1].t;
    const name = e.name.endsWith(':start') ? `before ${e.name.slice(0, -6)}` : e.name;
    out.push({ name, ms });
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const sceneModule = args.scene || '/demos/predatorScene/predatorScene.js';
  const sceneExport = args['scene-export'] || 'PredatorScene';
  const loads = Math.max(1, Number(args.loads) || 5);
  const settleMs = Math.max(0, Number(args['settle-ms'] ?? 2000));

  const server = await createStaticBenchmarkServer(repoRoot);
  const pageUrl = `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html${args.dist ? '' : '?src=1'}`;
  const browser = await chromium.launch({ headless: !args.headed, args: ['--js-flags=--expose-gc'] });
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, { timeout: 30000 });

    const swap = Boolean(args.swap);
    const runs = await runPage(page, { sceneModule, sceneExport, loads, settleMs, swap });

    // Phase names in the order a warm load meets them (it has the previous scene's teardown first), then any only
    // the cold load has; a phase that occurs several times in one load (the spawn flush) is summed within that load.
    const perLoad = runs.map((run) => {
      const sums = new Map();
      for (const { name, ms } of phasesOf(run.events)) sums.set(name, (sums.get(name) || 0) + ms);
      const total = run.events[run.events.length - 1].t;
      return { sums, total };
    });
    const order = [...perLoad[perLoad.length - 1].sums.keys()];
    for (const name of perLoad[0].sums.keys()) if (!order.includes(name)) order.push(name);

    const cold = perLoad[0];
    const warm = perLoad.slice(1);
    const table = order.map((name) => ({
      phase: name,
      coldMs: cold.sums.has(name) ? +cold.sums.get(name).toFixed(1) : null,
      warm: spread(warm.filter((l) => l.sums.has(name)).map((l) => l.sums.get(name))),
    }));
    const totals = { coldMs: +cold.total.toFixed(1), warm: spread(warm.map((l) => l.total)) };

    console.log(`\n=== ED-39 load phases: ${sceneExport}, 1 cold load + ${warm.length} warm ${swap ? 'fast swaps' : 'full loads'} ===`);
    console.log('phase'.padEnd(34) + 'cold ms'.padStart(10) + '   warm median [min..max] ms');
    for (const row of table) {
      const w = row.warm ? `${row.warm.median} [${row.warm.min}..${row.warm.max}]` : '-';
      console.log(row.phase.padEnd(34) + String(row.coldMs ?? '-').padStart(10) + '   ' + w);
    }
    console.log('TOTAL'.padEnd(34) + String(totals.coldMs).padStart(10) + `   ${totals.warm.median} [${totals.warm.min}..${totals.warm.max}]`);
    if (pageErrors.length) {
      console.error(`\n${pageErrors.length} page error(s):`);
      for (const e of pageErrors.slice(0, 10)) console.error('  ', e);
      process.exitCode = 1;
    }

    if (args.output) {
      writeReport(args.output, {
        name: 'ED-39 scene load phases',
        scene: sceneModule,
        sceneExport,
        loads: { cold: 1, warm: warm.length },
        swap,
        swapped: runs.map((r) => r.swapped),
        settleMs,
        source: args.dist ? 'dist' : 'src',
        phases: table,
        totals,
        raw: runs.map((r) => r.events),
        pageErrors,
      });
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
