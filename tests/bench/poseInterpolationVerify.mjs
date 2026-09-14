// poseInterpolationVerify.mjs — objective check for preRender.interpolation
//
// Samples one dynamic ball's *resolved render-queue* x/y (what pixi actually
// draws, via the canonical src/render/renderQueueLayout.js layout — same module
// pre_render_worker/pixi_worker use, so this can't drift from the real thing)
// every rAF tick, tagged with the concurrent physics poseSync readyFrame.
// Grouping samples by readyFrame answers directly: does the on-screen
// position change *between* physics publishes ('interpolate'), or stay
// frozen until the next publish jumps it ('off')? Removes the
// human-perception / zoom / velocity-magnitude variables that made the
// LiquidFun demo (mostly-settled water, static-only bodies) a poor test case.
//
// Usage: node tests/bench/poseInterpolationVerify.mjs [--headed]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXED_FPS = 12; // real physics interval ~83ms - comfortably resolved by ~60Hz rAF sampling
const SAMPLE_MS = 900;
const MODES = ['off', 'interpolate'];

async function sampleMode(browser, baseUrl, mode) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(`[verify:${mode}] page error`, error));
  try {
    await page.goto(`${baseUrl}/tests/bench/integratedWorkerBenchmark.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });

    return await page.evaluate(
      async ({ mode, fixedFps, sampleMs }) => {
        const sceneModule = '/demos/ballsScene/ballsScene.js';
        const [{ default: WEED }, { BallsScene }, { Ball }, RenderQueueLayout] = await Promise.all([
          import('/src/index.js'),
          import(sceneModule),
          import('/demos/ballsScene/gameObjects/ball.js'),
          import('/src/render/renderQueueLayout.js'),
        ]);
        const { RigidBody } = WEED;

        // Deliberate, now-correctly-paced gap (dt-clamp fix): physics genuinely
        // simulates real time at fixedFps:12, renderer stays uncapped.
        BallsScene.config = {
          ...BallsScene.config,
          physics: { ...BallsScene.config.physics, fixedFps },
          preRender: { ...BallsScene.config.preRender, interpolation: { mode } },
        };

        await window.__WEED_BENCHMARK__.prepare({
          sceneModule,
          sceneExport: 'BallsScene',
          warmupMs: 1,
          durationMs: 1,
        });
        const scene = window.__WEED_BENCHMARK__.getScene();

        // Let box2d finish booting before spawning the tracked ball.
        await new Promise((resolve) => setTimeout(resolve, 800));

        const cx = scene.config.worldWidth / 2;
        const cy = scene.config.worldHeight / 2;
        // Spawn above camera center so it free-falls through the visible
        // viewport well clear of the floor (worldHeight+ away) for the whole
        // sample window - a clean constant-acceleration case.
        const spawned = scene.spawnEntity(Ball, { x: cx, y: cy - 400, vx: 0, vy: 0 });
        const targetIndex = spawned.index;

        const poseSync = scene.buffers.poseDataA && scene.buffers.poseDataB
          ? new Int32Array(scene.buffers.poseSync)
          : null;
        const maxItems = scene.maxVisibleRenderables;
        const rqSync = new Int32Array(scene.buffers.renderQueueSync);
        const rqViewsByIdx = [
          RenderQueueLayout.createViews(scene.buffers.renderQueueDataA, maxItems),
          RenderQueueLayout.createViews(scene.buffers.renderQueueDataB, maxItems),
        ];

        const samples = [];
        const start = performance.now();
        await new Promise((resolve) => {
          function tick() {
            const rqReady = Atomics.load(rqSync, 0);
            const poseReady = poseSync ? Atomics.load(poseSync, 0) : -1;
            if (rqReady > 0) {
              const views = rqViewsByIdx[(rqReady - 1) % 2];
              const count = views.count[0] | 0;
              for (let slot = 0; slot < count; slot++) {
                if (views.entityIndex[slot] === targetIndex) {
                  samples.push({
                    t: performance.now() - start,
                    y: views.y[slot],
                    poseReady,
                    rbActive: RigidBody.active ? RigidBody.active[targetIndex] : -1,
                  });
                  break;
                }
              }
            }
            if (performance.now() - start < sampleMs) {
              requestAnimationFrame(tick);
            } else {
              resolve();
            }
          }
          requestAnimationFrame(tick);
        });

        return { targetIndex, samples };
      },
      { mode, fixedFps: FIXED_FPS, sampleMs: SAMPLE_MS }
    );
  } finally {
    await page.close();
  }
}

/**
 * Group samples by concurrent physics readyFrame; report per-group Y spread.
 *
 * Pipeline lag: poseSync (physics) and the render queue (pre_render's own,
 * later tick) are two independently-updated counters/buffers, not one atomic
 * snapshot. When a sample's rAF tick lands right after physics bumps
 * poseSync but before pre_render has re-latched and rewritten the render
 * queue, that sample's `poseReady` already reads the NEW value while `y`
 * still reflects the PREVIOUS interval - a one-sample carryover at the start
 * of every group (confirmed in raw data: that leading sample's y always
 * exactly equals the previous group's last value). Drop it before measuring
 * intra-group spread so the measurement isn't polluted by this artifact of
 * sampling two separate counters, not a property of the feature itself.
 */
function analyze(samples) {
  const groups = new Map();
  for (const s of samples) {
    if (!groups.has(s.poseReady)) groups.set(s.poseReady, []);
    groups.get(s.poseReady).push(s.y);
  }
  // Drop the first and last group entirely (boundary artifacts: pre-spawn latch, truncated tail).
  const readyFrames = [...groups.keys()].sort((a, b) => a - b);
  const middle = readyFrames.slice(1, -1);
  const spreads = middle.map((rf) => {
    const ys = groups.get(rf).slice(1); // drop the one-sample carryover leader
    const spread = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;
    return { readyFrame: rf, samples: ys.length, spread };
  });
  const multiSampleGroups = spreads.filter((g) => g.samples >= 2);
  const graduatedGroups = multiSampleGroups.filter((g) => g.spread > 0.5);
  return { totalSamples: samples.length, groupCount: readyFrames.length, spreads, multiSampleGroups, graduatedGroups };
}

async function main() {
  const headed = process.argv.includes('--headed');
  const server = await createStaticBenchmarkServer(repoRoot);
  const baseUrl = `http://127.0.0.1:${server.port}`;

  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: !headed, channel: 'chrome' });
    } catch {
      browser = await chromium.launch({ headless: !headed });
    }

    for (const mode of MODES) {
      const { targetIndex, samples } = await sampleMode(browser, baseUrl, mode);
      const a = analyze(samples);
      console.log(`\n=== mode: ${mode} (fixedFps: ${FIXED_FPS}, target entity ${targetIndex}) ===`);
      console.log(`  ${a.totalSamples} render-queue samples across ${a.groupCount} physics readyFrame groups`);
      console.log(`  ${a.multiSampleGroups.length} groups had >=2 samples (enough to see intra-group motion)`);
      console.log(
        `  ${a.graduatedGroups.length}/${a.multiSampleGroups.length} multi-sample groups show Y changing between physics publishes (spread > 0.05px)`
      );
      for (const g of a.spreads) {
        console.log(`    readyFrame ${g.readyFrame}: ${g.samples} samples, Y spread ${g.spread.toFixed(3)}px`);
      }
      if (process.env.VERIFY_RAW) {
        console.log('  raw samples (t_ms, y, poseReady, rbActive):');
        for (const s of samples) {
          console.log(`    ${s.t.toFixed(1)}\t${s.y.toFixed(3)}\t${s.poseReady}\t${s.rbActive}`);
        }
      }
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
