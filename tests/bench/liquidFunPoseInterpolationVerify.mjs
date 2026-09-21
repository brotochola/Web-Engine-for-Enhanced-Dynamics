// liquidFunPoseInterpolationVerify.mjs — objective check for preRender.interpolation
// on LiquidFun particles specifically (poseInterpolationVerify.mjs only covers
// rigid bodies). Same technique: sample the *resolved render-queue* position
// (what pixi actually draws) every rAF tick, grouped by physics poseSync
// readyFrame, and check for graduated intra-interval motion.
//
// The render queue has no per-sprite entity id. LiquidFun rows are type 7
// with no per-particle id to filter on.
// Dodge that by spawning one otherwise-empty scene's worth of particles (a
// single coherent free-falling/settling blob) and sampling whichever type===7
// row appears first each tick - good enough to see graduated vs frozen motion
// without needing a stable per-particle id.
//
// Also runs verifyReorderMitigation(): proves the count-drop reseed fix in
// weedjs_post.js's syncLiquidFunParticlesToSharedBuffers (see docs/LIQUIDFUN_HYPOTHESES.md,
// "Render extension") by reading the LiquidFun render SAB's px/py/x/y directly
// (bypassing the render queue - no per-particle id needed this way, since it
// checks *every currently-live slot* on every SolveZombie compaction frame,
// not one tracked particle) while particle lifespans expire and trigger
// repeated swap-with-last compactions.
//
// Usage: node tests/bench/liquidFunPoseInterpolationVerify.mjs [--headed]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXED_FPS = 10; // real physics interval ~100ms
const SAMPLE_MS = 900;
const MODES = [false, true];

async function sampleMode(browser, baseUrl, mode) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(`[verify:${mode}] page error`, error));
  try {
    await page.goto(`${baseUrl}/tests/bench/integratedWorkerBenchmark.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });

    return await page.evaluate(
      async ({ mode, fixedFps, sampleMs }) => {
        const sceneModule = '/demos/liquidFunDemoScene/liquidFunDemoScene.js';
        const [{ LiquidFunDemoScene }, RenderQueueLayout] = await Promise.all([
          import(sceneModule),
          import('/src/render/renderQueueLayout.js'),
        ]);

        LiquidFunDemoScene.config = {
          ...LiquidFunDemoScene.config,
          physics: {
            ...LiquidFunDemoScene.config.physics,
            fixedFps,
            liquidFun: { ...LiquidFunDemoScene.config.physics.liquidFun },
          },
          preRender: {
            ...LiquidFunDemoScene.config.preRender,
            interpolation: mode,
          },
        };

        await window.__WEED_BENCHMARK__.prepare({
          sceneModule,
          sceneExport: 'LiquidFunDemoScene',
          warmupMs: 1,
          durationMs: 1,
        });
        const scene = window.__WEED_BENCHMARK__.getScene();

        // Let box2d finish booting before emitting.
        await new Promise((resolve) => setTimeout(resolve, 800));

        const { LiquidFun } = await import('/src/index.js').then((m) => m.default);
        const LiquidFunRenderModule = await import('/src/render/liquidFunRender.js');
        const lfViews = LiquidFunRenderModule.bindLiquidFunRender(scene.buffers.liquidFunRender, scene.liquidFunMaxCount);

        LiquidFun.emit({
          flags: 0,
          shape: 'circle',
          posX: 2000,
          posY: 800,
          radius: 40,
        });

        // Poll (not a blind wait) until the LiquidFun render SAB shows the
        // new particle(s), up to 3s, logging the progression for diagnosis.
        const pollLog = [];
        let waited = 0;
        while (lfViews.count[0] === 0 && waited < 3000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waited += 100;
          pollLog.push({ waitedMs: waited, count: lfViews.count[0] });
        }
        const diag = {
          liquidFunMaxCount: scene.liquidFunMaxCount,
          hasLiquidFunBuffer: Boolean(scene.buffers.liquidFunRender),
          liquidFunRenderCount: lfViews.count[0],
          liquidFunRenderX0: lfViews.count[0] > 0 ? lfViews.x[0] : null,
          liquidFunRenderY0: lfViews.count[0] > 0 ? lfViews.y[0] : null,
          pollLog,
        };

        const poseSync = new Int32Array(scene.buffers.poseSync);
        const maxItems = scene.maxVisibleRenderables;
        const rqSync = new Int32Array(scene.buffers.renderQueueSync);
        const rqViewsByIdx = [
          RenderQueueLayout.createViews(scene.buffers.renderQueueDataA, maxItems),
          RenderQueueLayout.createViews(scene.buffers.renderQueueDataB, maxItems),
        ];

        const samples = [];
        const start = performance.now();
        let particleCount = 0;
        await new Promise((resolve) => {
          function tick() {
            const rqReady = Atomics.load(rqSync, 0);
            const poseReady = Atomics.load(poseSync, 0);
            if (rqReady > 0) {
              const views = rqViewsByIdx[(rqReady - 1) % 2];
              const count = views.count[0] | 0;
              for (let slot = 0; slot < count; slot++) {
                if (views.type[slot] === 1) {
                  // type 1 = particle batch (CPU ParticleComponent + LiquidFun
                  // both write type 1 for GPU depth purposes - this scene
                  // never spawns CPU particles, so any type-1 row here is our
                  // one LiquidFun particle).
                  particleCount++;
                  samples.push({ t: performance.now() - start, y: views.y[slot], poseReady });
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

        return { samples, sawParticleRows: particleCount, diag };
      },
      { mode, fixedFps: FIXED_FPS, sampleMs: SAMPLE_MS }
    );
  } finally {
    await page.close();
  }
}

/** Same grouping/lag-correction as poseInterpolationVerify.mjs. */
function analyze(samples) {
  const groups = new Map();
  for (const s of samples) {
    if (!groups.has(s.poseReady)) groups.set(s.poseReady, []);
    groups.get(s.poseReady).push(s.y);
  }
  const readyFrames = [...groups.keys()].sort((a, b) => a - b);
  const middle = readyFrames.slice(1, -1);
  const spreads = middle.map((rf) => {
    const ys = groups.get(rf).slice(1); // drop one-sample pipeline-lag carryover
    const spread = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;
    return { readyFrame: rf, samples: ys.length, spread };
  });
  const multiSampleGroups = spreads.filter((g) => g.samples >= 2);
  const graduatedGroups = multiSampleGroups.filter((g) => g.spread > 0.5);
  return { totalSamples: samples.length, groupCount: readyFrames.length, spreads, multiSampleGroups, graduatedGroups };
}

/**
 * Proves the count-drop reseed fix (weedjs_post.js's syncLiquidFunParticlesToSharedBuffers):
 * on any step where SolveZombie's swap-with-last compaction shrinks the
 * particle count, every currently-live particle's px/py must be reseeded to
 * equal its own x/y that same frame (nothing may claim to have "moved" via
 * an index that just got reassigned to a different physical particle).
 *
 * Spawns one blob that never expires (so there's always something left to
 * observe) plus one blob with a short, tightly-bounded lifespan (so many
 * individual particles expire - and trigger a compaction - at scattered
 * times across the sample window). Reads the LiquidFun render SAB directly
 * (count/x/y/px/py), not the render queue - this way every currently-live
 * slot can be checked on every compaction frame without needing a stable
 * per-particle id (which this SAB does not have).
 */
async function verifyReorderMitigation(browser, baseUrl) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[verify:reorder] page error', error));
  try {
    await page.goto(`${baseUrl}/tests/bench/integratedWorkerBenchmark.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });

    return await page.evaluate(async () => {
      const sceneModule = '/demos/liquidFunDemoScene/liquidFunDemoScene.js';
      const [{ LiquidFunDemoScene }] = await Promise.all([import(sceneModule)]);

      LiquidFunDemoScene.config = {
        ...LiquidFunDemoScene.config,
        physics: { ...LiquidFunDemoScene.config.physics, fixedFps: 30 },
        preRender: { ...LiquidFunDemoScene.config.preRender, interpolation: true },
      };

      await window.__WEED_BENCHMARK__.prepare({
        sceneModule,
        sceneExport: 'LiquidFunDemoScene',
        warmupMs: 1,
        durationMs: 1,
      });
      const scene = window.__WEED_BENCHMARK__.getScene();
      await new Promise((resolve) => setTimeout(resolve, 800));

      const { LiquidFun } = await import('/src/index.js').then((m) => m.default);
      const LiquidFunRenderModule = await import('/src/render/liquidFunRender.js');
      const lfViews = LiquidFunRenderModule.bindLiquidFunRender(scene.buffers.liquidFunRender, scene.liquidFunMaxCount);

      // Never-expiring blob first, so there's always a survivor to reseed.
      LiquidFun.emit({ flags: 0, shape: 'circle', posX: 2000, posY: 700, radius: 40 });
      // Independently-randomized short lifespans -> particles expire (and
      // trigger SolveZombie compaction) at scattered times, not all at once.
      LiquidFun.emit({
        flags: 0,
        shape: 'circle',
        posX: 2200,
        posY: 700,
        radius: 40,
        lifespan: { min: 150, max: 500 },
      });

      let waited = 0;
      while (lfViews.count[0] === 0 && waited < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waited += 100;
      }

      let prevCount = lfViews.count[0];
      let compactionFrames = 0;
      let badBlends = 0;
      const badDetails = [];
      const start = performance.now();
      await new Promise((resolve) => {
        function tick() {
          const count = lfViews.count[0] | 0;
          if (count < prevCount) {
            compactionFrames++;
            // Reseed invariant: on the exact frame the count drops, every
            // still-live slot must look "freshly spawned" (px===x, py===y) -
            // no index may show a blend toward a position that belonged to
            // whatever particle previously occupied that slot.
            for (let i = 0; i < count; i++) {
              if (lfViews.px[i] !== lfViews.x[i] || lfViews.py[i] !== lfViews.y[i]) {
                badBlends++;
                if (badDetails.length < 5) {
                  badDetails.push({ i, x: lfViews.x[i], y: lfViews.y[i], px: lfViews.px[i], py: lfViews.py[i] });
                }
              }
            }
          }
          prevCount = count;
          if (performance.now() - start < 4000) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        }
        requestAnimationFrame(tick);
      });

      return { compactionFrames, badBlends, badDetails, finalCount: lfViews.count[0] };
    });
  } finally {
    await page.close();
  }
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
      const { samples, sawParticleRows, diag } = await sampleMode(browser, baseUrl, mode);
      if (sawParticleRows === 0) {
        console.log(`\n=== mode: ${mode} ===\n  NO type=1 render-queue rows ever observed - particle never became visible/collected.`);
        console.log('  diag:', JSON.stringify(diag));
        continue;
      }
      const a = analyze(samples);
      console.log(`\n=== mode: ${mode} (fixedFps: ${FIXED_FPS}) ===`);
      console.log(`  ${a.totalSamples} render-queue samples across ${a.groupCount} physics readyFrame groups`);
      console.log(`  ${a.multiSampleGroups.length} groups had >=2 samples`);
      console.log(
        `  ${a.graduatedGroups.length}/${a.multiSampleGroups.length} multi-sample groups show Y changing between physics publishes (spread > 0.5px)`
      );
      for (const g of a.spreads) {
        console.log(`    readyFrame ${g.readyFrame}: ${g.samples} samples, Y spread ${g.spread.toFixed(3)}px`);
      }
    }

    console.log('\n=== reorder mitigation: lifespan-driven SolveZombie compaction ===');
    const r = await verifyReorderMitigation(browser, baseUrl);
    console.log(`  ${r.compactionFrames} compaction frame(s) observed (particle count dropped), final count ${r.finalCount}`);
    console.log(`  ${r.badBlends} bad blend(s) (px/py !== x/y on a compaction frame)`);
    if (r.badBlends > 0) {
      console.log('  sample bad blends:', JSON.stringify(r.badDetails));
      process.exitCode = 1;
    } else if (r.compactionFrames === 0) {
      console.log('  WARNING: no compaction observed - lifespan never triggered SolveZombie during the sample window, check unverified.');
      process.exitCode = 1;
    } else {
      console.log('  PASS: every compaction frame reseeded px/py for every live particle (no wrong-direction blends possible).');
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
