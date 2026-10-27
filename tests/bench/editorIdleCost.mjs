#!/usr/bin/env node
/**
 * ED-44, ED-70 (VISUAL_EDITOR_PLAN.md): what the editor costs while it is open and idle. One headless Chrome page (the
 * bench page, ?src=1), a scene file (--scene, the platformer's 1-1 by default) with the debug UI on. Three windows, in
 * one page: edit mode off; on and idle (nothing selected, the pointer still); on with the file's first placed entity
 * selected and the grid's lines shown at 16 px (the overlay draws every frame then: the selection's box, its handles,
 * the rotate handle, the grid), each for --sample-ms after --settle-ms:
 *   - allocation, sampled on the page and on every worker the page starts (CDP HeapProfiler sampling, counting the
 *     objects minor and major GCs have already collected), in KB/s;
 *   - the page's frames: the rAF interval and the time updateInternal takes (scene.mainStepMs), median and p95;
 *   - each worker's work per frame, STEP_MS − WAIT_MS, from the engine's frame totals over the window.
 * Edit mode holds the world still (Time.scale 0), so the workers have less to do then: the claim is that nothing
 * rises with the editor open, not that the two windows are alike.
 *
 *   node tests/bench/editorIdleCost.mjs [--scene /demos/littleCity/levels/city.scene.json] [--settle-ms 4000]
 *     [--sample-ms 8000] [--output path]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argValue = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SETTLE_MS = Number(argValue('settle-ms', 4000));
const SAMPLE_MS = Number(argValue('sample-ms', 8000));
const OUTPUT = argValue('output', null);
const SCENE = argValue('scene', '/demos/platformerGameScene/levels/1-1.scene.json');

const server = await createStaticBenchmarkServer(repoRoot);
const launchArgs = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (os.platform() === 'win32') launchArgs.push('--disable-features=CalculateNativeWinOcclusion');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  const cdp = await page.context().newCDPSession(page);

  // Workers: through the page's auto-attach (heapSampleWorkers.mjs).
  let nextId = 1;
  const pending = new Map();
  const workers = new Map();
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const m = JSON.parse(message);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  const sendTo = (sessionId, method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
  };
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type === 'worker') workers.set(sessionId, targetInfo.url.split('/').pop().split('?')[0]);
  });
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => workers.delete(sessionId));
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });

  await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, { timeout: 30000 });
  await page.evaluate(async (sceneUrl) => {
    const [{ default: WEED }, totals, clock] = await Promise.all([
      import('/src/index.js'),
      import('/src/util/frameTotals.js'),
      import('/src/util/frameClock.js'),
    ]);
    if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
    const game = new WEED.GameEngine({ autoResize: false, canvasWidth: 1280, canvasHeight: 720, injectStyles: false, debug: true });
    await game.loadScene(sceneUrl);
    const slots = { ...clock.FRAME_CLOCK_SLOTS, logic0: clock.LOGIC_SLOT0, spatial0: clock.SPATIAL_SLOT0 };
    /** Every slot's totals now; `workSince(start)` turns two reads into each worker's ms of work per frame. */
    const readAll = () => {
      const view = totals.bindFrameTotals(game.currentScene.buffers.frameTotals);
      return Object.fromEntries(Object.entries(slots).map(([name, slot]) => [name, totals.readTotals(view, slot)]));
    };
    const workSince = (start) => {
      const end = readAll();
      const out = {};
      for (const name of Object.keys(slots)) {
        const w = totals.totalsWindow(start[name], end[name]);
        if (w) out[name] = { workMs: +w.workMs.toFixed(3), p95Ms: +w.p95Ms.toFixed(3), frames: w.frames };
      }
      return out;
    };
    /** rAF intervals and updateInternal times over `ms`. */
    const frames = (ms) =>
      new Promise((resolve) => {
        const intervals = [];
        const steps = [];
        let last = performance.now();
        const end = last + ms;
        const tick = (now) => {
          intervals.push(now - last);
          last = now;
          const step = game.currentScene?.mainStepMs;
          if (Number.isFinite(step)) steps.push(step);
          if (now < end) requestAnimationFrame(tick);
          else resolve({ intervals, steps });
        };
        requestAnimationFrame(tick);
      });
    globalThis.__idle = { game, frames, readAll, workSince };
  }, SCENE);

  const stats = (values) => {
    const v = values.slice().sort((a, b) => a - b);
    if (!v.length) return null;
    const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
    return { median: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), n: v.length };
  };

  /** Allocation KB/s per target over SAMPLE_MS, and the page's frames over the same window. */
  async function sampleWindow() {
    const targets = [...workers];
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (const [sid] of targets) {
      await sendTo(sid, 'HeapProfiler.enable');
      await sendTo(sid, 'HeapProfiler.startSampling', {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    await page.evaluate(() => {
      globalThis.__idle.workStart = globalThis.__idle.readAll();
    });
    const framesRun = page.evaluate((ms) => globalThis.__idle.frames(ms), SAMPLE_MS);
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    const work = await page.evaluate(() => globalThis.__idle.workSince(globalThis.__idle.workStart));
    const total = (profile) => {
      let bytes = 0;
      const walk = (node) => {
        bytes += node.selfSize;
        for (const child of node.children || []) walk(child);
      };
      walk(profile.head);
      return +(bytes / 1024 / (SAMPLE_MS / 1000)).toFixed(1);
    };
    const out = { allocationKbPerS: {} };
    out.allocationKbPerS.page = total((await cdp.send('HeapProfiler.stopSampling')).profile);
    const stops = await Promise.allSettled(targets.map(([sid]) => sendTo(sid, 'HeapProfiler.stopSampling')));
    targets.forEach(([, name], k) => {
      if (stops[k].status !== 'fulfilled') return;
      const key = out.allocationKbPerS[name] === undefined ? name : `${name} #${k}`;
      out.allocationKbPerS[key] = total(stops[k].value.profile);
    });
    const { intervals, steps } = await framesRun;
    out.frameIntervalMs = stats(intervals);
    out.updateInternalMs = stats(steps);
    out.workerWorkMs = work;
    return out;
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const closed = await sampleWindow();

  await page.keyboard.press('Shift+E');
  // The first Shift+E loads the editor (ED-29: on demand), then enters edit mode.
  await page.waitForFunction(() => globalThis.__idle.game.debugUI.editing === true, undefined, { timeout: 15000 }).catch(() => {
    throw new Error('Shift+E did not enter edit mode');
  });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const open = await sampleWindow();

  // Editing: the first placed entity selected (the inspector shown) and the grid's lines on.
  const picked = await page.evaluate(() => {
    const { game } = globalThis.__idle;
    const scene = game.currentScene;
    const editMode = game.debugUI.editMode;
    const record = scene.sceneFile.entities[0];
    editMode.selectFromList(scene.getByName(record.name).index, false);
    editMode.setSnap(16);
    if (!editMode.grid.show) editMode.toggleGrid();
    return `${record.name} (${record.class})`;
  });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const selected = await sampleWindow();

  const report = { scene: SCENE, settleMs: SETTLE_MS, sampleMs: SAMPLE_MS, closed, open, selected, picked };
  if (OUTPUT) fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  const windows = [closed, open, selected];
  console.log(`${SCENE}; selected: ${picked}`);
  const names = [...new Set(windows.flatMap((w) => Object.keys(w.allocationKbPerS)))];
  console.log('allocation KB/s                closed     open selected');
  for (const name of names) {
    console.log(`  ${name.padEnd(28)} ${windows.map((w) => String(w.allocationKbPerS[name] ?? '-').padStart(8)).join(' ')}`);
  }
  for (const [label, key] of [['frame interval ms', 'frameIntervalMs'], ['updateInternal ms', 'updateInternalMs']]) {
    console.log(`${label.padEnd(20)} closed ${JSON.stringify(closed[key])}  open ${JSON.stringify(open[key])}  selected ${JSON.stringify(selected[key])}`);
  }
  console.log('work per frame ms   closed            open        selected   (STEP_MS − WAIT_MS, p95)');
  for (const name of new Set(windows.flatMap((w) => Object.keys(w.workerWorkMs)))) {
    const fmt = (w) => (w ? `${w.workMs} (${w.p95Ms})` : '-');
    console.log(`  ${name.padEnd(16)} ${windows.map((w) => fmt(w.workerWorkMs[name]).padStart(16)).join(' ')}`);
  }
} finally {
  await browser.close();
  await server.close();
}
