// Scene-cycle smoke test: repeatedly load + destroy a scene in one page and
// verify teardown leaves no broken state behind (Layer/NavGrid/Sound statics),
// no page errors occur, and the JS heap does not grow monotonically.
//
// Usage: node tests/bench/scene-cycle-smoke.mjs [--cycles 4] [--scene /demos/scenes/BallsScene.js] [--scene-export BallsScene] [--headed]

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

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
  const sceneModule = args.scene || '/demos/scenes/BallsScene.js';
  const sceneExport = args['scene-export'] || 'BallsScene';
  const headed = Boolean(args.headed);

  const server = await createStaticBenchmarkServer(repoRoot);
  const pageUrl = `http://127.0.0.1:${server.port}/tests/bench/integrated-worker-benchmark.html`;

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

    const report = await page.evaluate(
      async ({ cycles, sceneModule, sceneExport }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const forceGC = () => {
          if (typeof globalThis.gc === 'function') globalThis.gc();
        };
        const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);

        const [{ default: WEED }, sceneExports, { Layer }, { NavGrid }, { SoundManager }] =
          await Promise.all([
            import('/src/index.js'),
            import(sceneModule),
            import('/src/core/Layer.js'),
            import('/src/core/NavGrid.js'),
            import('/src/core/SoundManager.js'),
          ]);
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

        const cyclesReport = [];

        for (let i = 0; i < cycles; i++) {
          await game.loadScene(SceneClass);
          await sleep(2500); // let workers run for a bit

          const running = {
            postToRendererSet: typeof Layer._postToRenderer === 'function',
            layerCount: Layer.count,
            workerCount: game.currentScene.getAllWorkers().filter(Boolean).length,
          };

          // Destroy by loading-next or final explicit destroy below; here we
          // exercise the scene-switch path every iteration except the last.
          if (i < cycles - 1) {
            // loadScene destroys the previous scene internally on next iteration;
            // to measure post-teardown state explicitly, destroy via engine on last only.
          }

          forceGC();
          await sleep(200);
          forceGC();

          cyclesReport.push({
            cycle: i + 1,
            usedJSHeapSizeMB: +(heap() / (1024 * 1024)).toFixed(1),
            ...running,
          });
        }

        await game.destroy();
        forceGC();
        await sleep(200);
        forceGC();

        return {
          cycles: cyclesReport,
          afterDestroy: {
            usedJSHeapSizeMB: +(heap() / (1024 * 1024)).toFixed(1),
            layerPostToRenderer: Layer._postToRenderer,
            layerCount: Layer.count,
            navWorkerPort: NavGrid._navWorkerPort,
            soundCtx: SoundManager._audioCtx ? 'alive' : null,
            soundWorkletNode: SoundManager._workletNode ? 'alive' : null,
          },
        };
      },
      { cycles, sceneModule, sceneExport }
    );

    console.log('\n=== Scene cycle smoke report ===');
    for (const c of report.cycles) {
      console.log(
        `cycle ${c.cycle}: heap=${c.usedJSHeapSizeMB}MB, workers=${c.workerCount}, ` +
          `layers=${c.layerCount}, postToRenderer=${c.postToRendererSet}`
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
      (t) => !t.includes('Failed to load resource') // demo assets that 404 in the bare harness
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
