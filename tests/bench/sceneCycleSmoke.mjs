// Scene-cycle smoke test: repeatedly load + destroy a scene in one page and
// verify teardown leaves no broken state behind (Layer/NavGrid/Sound statics),
// no page errors occur, and the JS heap does not grow monotonically.
// --commit (Windows; WASM_HYPOTHESES L3): also the commit charge (private bytes) of this process, the browser and
// every process under it, before the first scene, after each cycle and after the engine is destroyed: every shared memory a scene
// makes (Box2D's with the engine block, the particle, decal, navigation and spatial memories) is committed whole
// when it is made, and the scene's teardown must give it back. Fails when the last cycle's commit is more than
// 128 MB over the first's, or the commit after destroy more than 128 MB over the start.
//
// Usage: node tests/bench/sceneCycleSmoke.mjs [--cycles 4] [--scene /demos/ballsScene/ballsScene.js] [--scene-export BallsScene] [--headed] [--commit]

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Windows: the commit charge of process `rootPid` and every process under it, in MB (null elsewhere). */
function commitMB(rootPid) {
  if (process.platform !== 'win32' || !rootPid) return null;
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

function parseArgs(argv) {
  const parsed = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cycles = Math.max(2, Number(args.cycles) || 4);
  const sceneModule = args.scene || '/demos/ballsScene/ballsScene.js';
  const sceneExport = args['scene-export'] || 'BallsScene';
  const headed = Boolean(args.headed);
  const sampleCommit = Boolean(args.commit);

  const server = await createStaticBenchmarkServer(repoRoot);
  const pageUrl = `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html`;

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--js-flags=--expose-gc'],
  });

  const pageErrors = [];
  const consoleErrors = [];

  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, {
      timeout: 30000,
    });

    // One evaluate sets the engine up, one runs each cycle (so the commit can be read between them), one destroys it.
    // The browser is a child of this process: its tree and this process (a steady base) are what is summed.
    const pid = process.pid;
    const commit = () => (sampleCommit ? commitMB(pid) : null);
    await page.evaluate(
      async ({ sceneModule, sceneExport }) => {
        const [{ default: WEED }, sceneExports] = await Promise.all([
          import('/src/index.js'),
          import(sceneModule),
        ]);
        if (typeof WEED.ensureEmbeddedSources === 'function') {
          await WEED.ensureEmbeddedSources();
        }
        const SceneClass = sceneExports[sceneExport];
        if (!SceneClass) throw new Error(`Scene export "${sceneExport}" not found in ${sceneModule}`);

        const game = new WEED.GameEngine({
          autoResize: false,
          canvasWidth: 800,
          canvasHeight: 600,
          injectStyles: false,
          preventContextMenu: false,
          preventDefaultKeys: false,
          debug: false,
        });
        globalThis.__cycleSmoke = { WEED, game, sceneModule, sceneExport };
      },
      { sceneModule, sceneExport }
    );
    const startCommitMB = commit();

    const cyclesReport = [];
    for (let i = 0; i < cycles; i++) {
      const cycle = await page.evaluate(
        async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const forceGC = () => {
            if (typeof globalThis.gc === 'function') globalThis.gc();
          };
          const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
          const { WEED, game, sceneModule, sceneExport } = globalThis.__cycleSmoke;
          const { Layer } = WEED;
          await game.loadScene(sceneModule, { export: sceneExport });
          await sleep(2500); // let workers run for a bit

          const running = {
            postToRendererSet: typeof Layer._postToRenderer === 'function',
            layerCount: Layer.count,
            workerCount: game.currentScene.getAllWorkers().filter(Boolean).length,
          };

          // loadScene destroys the previous scene on the next cycle; the engine is destroyed after the last.
          forceGC();
          await sleep(200);
          forceGC();
          return { usedJSHeapSizeMB: +(heap() / (1024 * 1024)).toFixed(1), ...running };
        }
      );
      cyclesReport.push({ cycle: i + 1, ...cycle, commitMB: commit() });
    }

    const afterDestroy = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const forceGC = () => {
        if (typeof globalThis.gc === 'function') globalThis.gc();
      };
      const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
      const { WEED, game } = globalThis.__cycleSmoke;
      const { Layer, NavGrid, SoundManager } = WEED;
      await game.destroy();
      globalThis.__cycleSmoke = null;
      forceGC();
      await sleep(200);
      forceGC();
      // The workers' memories go when their threads have exited and the next collection runs.
      await sleep(2000);
      forceGC();
      return {
        usedJSHeapSizeMB: +(heap() / (1024 * 1024)).toFixed(1),
        layerPostToRenderer: Layer._postToRenderer,
        layerCount: Layer.count,
        navWorkerPort: NavGrid._navWorkerPort,
        soundCtx: SoundManager._audioCtx ? 'alive' : null,
        soundWorkletNode: SoundManager._workletNode ? 'alive' : null,
      };
    });
    afterDestroy.commitMB = commit();
    const report = { cycles: cyclesReport, afterDestroy };

    console.log('\n=== Scene cycle smoke report ===');
    for (const c of report.cycles) {
      console.log(
        `cycle ${c.cycle}: heap=${c.usedJSHeapSizeMB}MB, workers=${c.workerCount}, ` +
          `layers=${c.layerCount}, postToRenderer=${c.postToRendererSet}` +
          (c.commitMB !== null ? `, commit=${c.commitMB}MB` : '')
      );
    }
    console.log('after destroy:', JSON.stringify(report.afterDestroy));

    let failed = false;

    if (pageErrors.length > 0) {
      failed = true;
      console.error(`\nFAIL: ${pageErrors.length} page error(s):`);
      for (const e of pageErrors.slice(0, 10)) console.error('  ', e);
    }

    const realConsoleErrors = consoleErrors.filter(
      (t) =>
        !t.includes('Failed to load resource') && // demo assets that 404 in the bare harness
        !t.includes('wasm streaming compile failed') && // static server MIME; emscripten falls back
        !t.includes('falling back to ArrayBuffer instantiation')
    );
    if (realConsoleErrors.length > 0) {
      failed = true;
      console.error(`\nFAIL: ${realConsoleErrors.length} console error(s):`);
      for (const e of realConsoleErrors.slice(0, 10)) console.error('  ', e);
    }

    for (const c of report.cycles) {
      if (!c.postToRendererSet) {
        failed = true;
        console.error(`FAIL: cycle ${c.cycle} - Layer._postToRenderer not connected while scene running`);
      }
    }

    const ad = report.afterDestroy;
    if (ad.layerPostToRenderer !== null) {
      failed = true;
      console.error('FAIL: Layer._postToRenderer not cleared after destroy');
    }
    if (ad.navWorkerPort !== null) {
      failed = true;
      console.error('FAIL: NavGrid._navWorkerPort not cleared after destroy');
    }
    if (ad.soundCtx !== null || ad.soundWorkletNode !== null) {
      failed = true;
      console.error('FAIL: SoundManager not disposed after engine destroy');
    }

    const first = report.cycles[0].usedJSHeapSizeMB;
    const last = report.cycles[report.cycles.length - 1].usedJSHeapSizeMB;
    console.log(`\nHeap drift across ${report.cycles.length} cycles: ${first}MB -> ${last}MB`);
    if (last > first * 2 && last - first > 50) {
      failed = true;
      console.error('FAIL: JS heap roughly doubled across scene cycles - probable leak');
    }
    if (sampleCommit) {
      const c0 = report.cycles[0].commitMB;
      const cN = report.cycles[report.cycles.length - 1].commitMB;
      console.log(`Commit: ${startCommitMB}MB before the first scene, ${c0}MB after cycle 1, ${cN}MB after cycle ${report.cycles.length}, ${ad.commitMB}MB after destroy`);
      if (cN - c0 > 128) {
        failed = true;
        console.error('FAIL: the commit grew more than 128 MB across scene cycles - a memory not given back');
      }
      if (ad.commitMB - startCommitMB > 128) {
        failed = true;
        console.error('FAIL: the commit after destroy is more than 128 MB over the start');
      }
    }

    if (failed) {
      process.exitCode = 1;
      console.error('\nRESULT: FAILED');
    } else {
      console.log('RESULT: OK');
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
