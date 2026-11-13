#!/usr/bin/env node
/**
 * Every worker's own time (STEP_MS - WAIT_MS) over a long run, in buckets (E-243): does a scene get cheaper once V8 has
 * had time to optimize its once-a-frame functions as a whole? Reads the workers' stats buffers from the page about ten
 * times a second and averages them per bucket; with --v8-log-dir (V8's --log-code) the code log of the same run says
 * when each function reached each tier.
 *
 *   node tests/bench/stepOverTime.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
 *     [--query k=v&k2=v2] [--seconds 150] [--bucket-s 10] [--v8-log-dir dir] [--output file]
 * From Git Bash set MSYS_NO_PATHCONV=1. Headed Chrome, the source, detailed stats off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function stepOverTime(opts) {
  const server = await createStaticBenchmarkServer(repoRoot);
  const args = ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  let userDataDir = null;
  if (opts.v8LogDir) {
    fs.mkdirSync(opts.v8LogDir, { recursive: true });
    args.push(`--js-flags=--logfile=${path.join(opts.v8LogDir, 'v8.log').replace(/\\/g, '/')} --log-code --log-deopt`, '--no-sandbox');
  }
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-step-'));
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, channel: 'chrome', args, viewport: { width: 1280, height: 720 } });
  try {
    const page = context.pages()[0] || (await context.newPage());
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${opts.query ? `&${opts.query}` : ''}`);
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__));
    await page.evaluate(({ m, e }) => window.__WEED_BENCHMARK__.prepare({ warmupMs: 3600000, durationMs: 3600000, sampleIntervalMs: 1000,
      sceneModule: m, sceneExport: e, collectDetailedStats: false, collectGpuStats: false }), { m: opts.scene, e: opts.sceneExport });
    await page.waitForFunction(() => window.scene && window.scene.frameNumber > 10, undefined, { timeout: 120000 });
    // Sampled in the page: each worker's STEP_MS and WAIT_MS from its stats buffer, ten times a second.
    const buckets = await page.evaluate(async ({ seconds, bucketS }) => {
      const U = await import('/src/util/workersUtils.js');
      const s = window.scene;
      const read = () => {
        const one = (sab, schema) => {
          if (!sab) return null;
          const v = new Float32Array(sab);
          return { step: v[schema.STEP_MS] || 0, wait: schema.WAIT_MS !== undefined ? v[schema.WAIT_MS] || 0 : 0 };
        };
        const multi = (sab, schema, count) => {
          if (!sab || count < 1) return null;
          const v = new Float32Array(sab);
          let step = 0;
          let wait = 0;
          for (let i = 0; i < count; i++) {
            step += v[i * schema.STRIDE_FLOATS + schema.STEP_MS] || 0;
            wait += schema.WAIT_MS !== undefined ? v[i * schema.STRIDE_FLOATS + schema.WAIT_MS] || 0 : 0;
          }
          return { step, wait };
        };
        const b = s.buffers;
        return {
          physics: one(b.physicsStats, U.PHYSICS_STATS),
          particle: one(b.particleStats, U.PARTICLE_STATS),
          renderer: one(b.rendererStats, U.RENDERER_STATS),
          preRender: one(b.preRenderStats, U.PRE_RENDER_STATS),
          spatial: multi(b.spatialStats, U.SPATIAL_STATS, s.numberOfSpatialWorkers),
          logic: multi(b.logicStats, U.LOGIC_STATS, s.config.logic?.numberOfLogicWorkers || 1),
        };
      };
      const out = [];
      const t0 = performance.now();
      let bucket = null;
      while (performance.now() - t0 < seconds * 1000) {
        const k = Math.floor((performance.now() - t0) / (bucketS * 1000));
        if (!bucket || bucket.k !== k) {
          if (bucket) out.push(bucket);
          bucket = { k, n: 0, sums: {} };
        }
        const r = read();
        bucket.n++;
        for (const [name, v] of Object.entries(r)) {
          if (!v) continue;
          const acc = bucket.sums[name] || (bucket.sums[name] = 0);
          bucket.sums[name] = acc + (v.step - v.wait);
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      if (bucket) out.push(bucket);
      return out.map((b) => ({ fromS: b.k * bucketS, own: Object.fromEntries(Object.entries(b.sums).map(([k, v]) => [k, Math.round((v / b.n) * 1000) / 1000])) }));
    }, { seconds: opts.seconds, bucketS: opts.bucketS });
    return buckets;
  } finally {
    await context.close();
    await server.close?.();
    // The code logs land in the profile's directory when the renderer cannot write the given path: copy them out.
    if (opts.v8LogDir && userDataDir) {
      for (const f of fs.readdirSync(userDataDir).filter((n) => /v8\.log$|isolate-.*\.log$/.test(n))) {
        fs.copyFileSync(path.join(userDataDir, f), path.join(opts.v8LogDir, f));
      }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs();
  if (!args.scene || !args['scene-export']) {
    console.error('usage: stepOverTime.mjs --scene <module> --scene-export <Class> [--query k=v] [--seconds 150] [--bucket-s 10] [--v8-log-dir dir] [--output file]');
    process.exit(2);
  }
  const buckets = await stepOverTime({
    scene: String(args.scene),
    sceneExport: String(args['scene-export']),
    query: typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '',
    seconds: Number(args.seconds ?? 150),
    bucketS: Number(args['bucket-s'] ?? 10),
    v8LogDir: args['v8-log-dir'] ? path.resolve(String(args['v8-log-dir'])) : null,
  });
  const names = Object.keys(buckets[0]?.own || {});
  console.log(`own ms (STEP - WAIT) per ${buckets[1] ? buckets[1].fromS - buckets[0].fromS : '?'} s bucket after the scene's first frames:`);
  console.log(`  from s  ${names.map((n) => n.padStart(9)).join('')}`);
  for (const b of buckets) console.log(`  ${String(b.fromS).padStart(6)}  ${names.map((n) => (b.own[n] ?? 0).toFixed(3).padStart(9)).join('')}`);
  if (args.output) fs.writeFileSync(String(args.output), JSON.stringify(buckets, null, 1));
}

if (isCli(import.meta.url)) await main();
