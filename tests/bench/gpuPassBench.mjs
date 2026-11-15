#!/usr/bin/env node
/**
 * DX-LIGHT3D's GPU microbench (plan §9.3): the cost of one pass of the 3D light, outside the engine. The engine's GPU clock
 * hung Chrome, so a page (gpuPassBench.html, gpuPass/) builds only the measured pass from src/shaders and the engine's own
 * source transforms, and draws it K times between two waits for the GPU (WebGL gl.finish(), WebGPU
 * onSubmittedWorkDone). A real Chrome window on the real GPU, one page per case; ms per pass with its spread.
 *
 *   node tests/bench/gpuPassBench.mjs                                  the default suite, both backends
 *   node tests/bench/gpuPassBench.mjs --backend webgpu --suite quick
 *   node tests/bench/gpuPassBench.mjs --passes light,light3d --query res=0.5 --query lights=32
 *   node tests/bench/gpuPassBench.mjs --output tests/results/gpuPass/gtx1650.json
 *
 * --backend webgl|webgpu|both (both)  --suite default|quick|tournament (default; ignored with --passes)
 * --passes a,b  one case of these passes (gpuPass/passes.js: color, colorDepth, gbuffer, gbufferMrt, sunMap, sunColumns,
 *   lampMap, light, light3d, selfShadow, multiply, compose)
 * --query k=v (repeatable)  page parameters for every case (gpuPass/page.js lists them: width, height, res, lights,
 *   maxLights, silhouettes, renders, lamps, casters, tile, steps, rays, format, night, intBits, ...)
 * --samples N (12)  --target-ms N (25: K grows until one sample takes this)  --capacity  the frame-rate search instead
 *   of the waits  --timeout-ms N (120000 a case)  --headless (not the real GPU: a smoke run only)  --output path (JSON)
 *
 * If a case does not come back (a backend hung on its waits), the browser is closed and that backend's remaining cases,
 * that one first, run as the capacity search: the pass drawn N times a frame until the presented frames drop under the
 * display's rate. Exit 1 when a pass failed to build or a case failed in both modes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function light(res, lights) {
  return { passes: 'light,light3d', query: { res, lights } };
}

/** Cases: the passes of plan §9.3 at the sizes §9.5's decisions need. */
const SUITES = {
  default: [
    // G-buffer: a second pass against MRT (the colour pass alone is the second pass's other half).
    { passes: 'color,gbuffer,gbufferMrt,colorDepth', query: { res: 0.5 } },
    { passes: 'color,gbuffer,gbufferMrt', query: { res: 1 } },
    // The sun's map: N rectangles, and renders as columns; the target's format.
    { passes: 'sunMap,sunColumns', query: { silhouettes: 1000, renders: 100 } },
    { passes: 'sunMap,sunColumns', query: { silhouettes: 10000, renders: 500 } },
    { passes: 'sunMap', query: { silhouettes: 10000, format: 'r16f' } },
    // The lamps' map: one tile a lamp, 128 / 256 / 512 texels.
    { passes: 'lampMap', query: { lamps: 8, tile: 256 } },
    { passes: 'lampMap', query: { lamps: 48, tile: 128 } },
    { passes: 'lampMap', query: { lamps: 48, tile: 256 } },
    { passes: 'lampMap', query: { lamps: 48, tile: 512 } },
    // The light pass: 0.25, 0.5 and 1 resolution with 8, 32 and 256 lights (today's and the 3D one).
    ...[0.25, 0.5, 1].flatMap((res) => [8, 32, 256].map((lights) => light(res, lights))),
    // Self-shadow: 1, 2 and 4 rays.
    ...[1, 2, 4].map((rays) => ({ passes: 'light3d,selfShadow', query: { res: 1, lights: 32, rays } })),
    // The composition: today's light layer, and the emissive composition.
    { passes: 'multiply,compose', query: { res: 0.5 } },
  ],
  quick: [
    { passes: 'color,gbuffer', query: { res: 0.5 } },
    { passes: 'sunMap', query: { silhouettes: 2000 } },
    { passes: 'lampMap', query: { lamps: 16 } },
    light(0.5, 32),
    { passes: 'selfShadow', query: { res: 0.5, rays: 1 } },
    { passes: 'compose', query: { res: 0.5 } },
  ],
  // §9.5's GPU decisions, each against its candidates in one case.
  tournament: [
    { passes: 'color,gbuffer,gbufferMrt', query: { res: 0.5 } },
    { passes: 'color,gbuffer,gbufferMrt', query: { res: 1 } },
    { passes: 'sunMap', query: { format: 'rgba8', silhouettes: 5000 } },
    { passes: 'sunMap', query: { format: 'r16f', silhouettes: 5000 } },
    { passes: 'sunMap', query: { format: 'r32f', silhouettes: 5000 } },
    ...[128, 256, 512].map((tile) => ({ passes: 'lampMap', query: { lamps: 48, tile } })),
    ...[0.25, 0.5, 1].map((res) => ({ passes: 'light3d', query: { res, lights: 32 } })),
    ...[1, 2, 4].map((rays) => ({ passes: 'selfShadow', query: { res: 1, lights: 32, rays } })),
  ],
};

function parseCli(argv) {
  const opts = { backend: 'both', suite: 'default', passes: null, query: [], samples: 12, targetMs: 25, capacity: false, timeoutMs: 120000, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--backend') opts.backend = next();
    else if (a === '--suite') opts.suite = next();
    else if (a === '--passes') opts.passes = next();
    else if (a === '--query') opts.query.push(next());
    else if (a === '--samples') opts.samples = Number(next());
    else if (a === '--target-ms') opts.targetMs = Number(next());
    else if (a === '--capacity') opts.capacity = true;
    else if (a === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (a === '--headless') opts.headless = true;
    else if (a === '--output') opts.output = next();
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`gpuPassBench: unknown argument ${a}`);
  }
  if (!['webgl', 'webgpu', 'both'].includes(opts.backend)) throw new Error('gpuPassBench: --backend webgl|webgpu|both');
  if (!opts.passes && !SUITES[opts.suite]) throw new Error(`gpuPassBench: no suite ${opts.suite} (${Object.keys(SUITES).join(', ')})`);
  return opts;
}

async function launch(headless) {
  const args = [
    '--enable-unsafe-webgpu',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (os.platform() === 'win32') args.push('--disable-features=CalculateNativeWinOcclusion');
  return chromium.launch({ channel: 'chrome', headless, args });
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`hang: ${what} took more than ${ms} ms`)), ms);
    }),
  ]);
}

async function closeQuietly(browser) {
  try {
    await withTimeout(browser.close(), 15000, 'closing the browser');
  } catch {
    // A wedged GPU process can keep Chrome from closing politely; the next case launches a new one.
  }
}

/** One case: a fresh page, its parameters, its run. */
async function runCase(browser, server, backend, kase, opts, capacity) {
  const params = new URLSearchParams({ backend, passes: kase.passes, samples: String(opts.samples), targetMs: String(opts.targetMs) });
  for (const [k, v] of Object.entries(kase.query || {})) params.set(k, String(v));
  for (const pair of opts.query) {
    const at = pair.indexOf('=');
    params.set(at < 0 ? pair : pair.slice(0, at), at < 0 ? '' : pair.slice(at + 1));
  }
  if (capacity) params.set('capacity', '1');
  const url = `http://127.0.0.1:${server.port}/tests/bench/gpuPassBench.html?${params}`;
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__GPU_PASS_BENCH__), undefined, { timeout: 30000 });
    const result = await withTimeout(page.evaluate(() => window.__GPU_PASS_BENCH__.run()), opts.timeoutMs, `${backend} ${kase.passes}`);
    return { url, result, errors };
  } finally {
    await withTimeout(page.close(), 15000, 'closing the page').catch(() => {});
  }
}

function describeQuery(kase, opts) {
  return [...Object.entries(kase.query || {}).map(([k, v]) => `${k}=${v}`), ...opts.query].join(' ');
}

function line(backend, name, query, r) {
  if (!r) return `${backend.padEnd(6)} ${name.padEnd(11)} ${query}: no result`;
  if (r.error) return `${backend.padEnd(6)} ${name.padEnd(11)} ${query}: ERROR ${r.error}`;
  if (r.mode === 'capacity') {
    const bound = r.msPerPassBound === null ? 'none fit' : `<= ${r.msPerPassBound.toFixed(3)} ms`;
    return `${backend.padEnd(6)} ${name.padEnd(11)} ${query}: ${r.passesPerFrame} a frame at ${r.baselineFps.toFixed(0)} fps (${bound}) [capacity]`;
  }
  return (
    `${backend.padEnd(6)} ${name.padEnd(11)} ${query}: ${r.median.toFixed(3)} ms ` +
    `[${r.p25.toFixed(3)}-${r.p75.toFixed(3)}] spread ${(r.spread * 100).toFixed(1)} % (K ${r.k}, ${r.samples.length} samples, ` +
    `clock ${r.overheadMs.toFixed(3)} ms)${r.notes ? `; ${r.notes}` : ''}`
  );
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const cases = opts.passes ? [{ passes: opts.passes, query: {} }] : SUITES[opts.suite];
  const backends = opts.backend === 'both' ? ['webgl', 'webgpu'] : [opts.backend];
  const server = await createStaticBenchmarkServer(repoRoot);
  const report = { tool: 'gpuPassBench', startedAt: new Date().toISOString(), suite: opts.passes ? null : opts.suite, query: opts.query, host: os.hostname(), cases: [] };
  let failed = false;
  try {
    for (const backend of backends) {
      let browser = await launch(opts.headless);
      report.chrome ??= browser.version();
      let capacity = opts.capacity;
      for (const kase of cases) {
        const query = describeQuery(kase, opts);
        let entry = { backend, passes: kase.passes, query: kase.query || {}, capacity };
        try {
          const { url, result, errors } = await runCase(browser, server, backend, kase, opts, capacity);
          entry = { ...entry, url, result, pageErrors: errors };
          const hung = Object.values(result.passes || {}).some((r) => r?.hang);
          if (hung && !capacity) throw new Error('hang: a wait for the GPU did not end');
        } catch (err) {
          if (!/^hang:/.test(String(err.message)) || capacity) {
            entry.error = String(err.message || err);
          } else {
            // The fallback: a new browser, this backend's cases from here as the capacity search.
            console.log(`${backend}: ${err.message}; the rest of ${backend} runs as the capacity search`);
            await closeQuietly(browser);
            browser = await launch(opts.headless);
            capacity = true;
            entry.capacity = true;
            entry.hungTimed = true;
            try {
              const { url, result, errors } = await runCase(browser, server, backend, kase, opts, true);
              entry = { ...entry, url, result, pageErrors: errors };
            } catch (err2) {
              entry.error = String(err2.message || err2);
            }
          }
        }
        report.cases.push(entry);
        if (entry.error) {
          failed = true;
          console.log(`${backend.padEnd(6)} ${kase.passes} ${query}: ERROR ${entry.error}`);
          continue;
        }
        const res = entry.result;
        if (res.error) {
          failed = true;
          console.log(`${backend.padEnd(6)} ${kase.passes} ${query}: ERROR ${res.error}`);
        }
        if (report.cases.filter((c) => c.backend === backend).length === 1 && res.info) console.log(`${backend}: ${JSON.stringify(res.info)}`);
        for (const name of kase.passes.split(',')) {
          const r = res.passes?.[name];
          if (!r || r.error) failed = true;
          console.log(line(backend, name, query, r));
        }
        if (res.inputs && Object.keys(res.inputs).length) {
          const parts = Object.entries(res.inputs).map(([k, v]) => `${k} ${v === null ? 'n/a' : `${(v * 100).toFixed(1)} %`}`);
          console.log(`${''.padEnd(6)} inputs drawn (share of pixels): ${parts.join(', ')}`);
        }
      }
      await closeQuietly(browser);
    }
  } finally {
    await server.close();
  }
  report.finishedAt = new Date().toISOString();
  if (opts.output) {
    const out = path.resolve(opts.output);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
