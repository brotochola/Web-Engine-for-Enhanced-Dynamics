#!/usr/bin/env node
/**
 * E-160's capture: the shadow stamp's inputs as a running scene gives them (Predator by default), for
 * shadowStampReplayKernel.mjs. Headed Chrome, the source, detailed stats off. The kernel's own fixture
 * (predator-frame.bin through shadowStampKernel.mjs) rebuilds one frame's lights and casters by hand; this records
 * what pre-render really passes, frame after frame.
 *
 * It wraps pre-render's `_stampRange` through the worker's global (`self.preRenderWorker`) and copies, on every
 * `--every`-th call until it has `--frames`: the sun caster rows, the light table (five doubles a light, as
 * shadowStampClient.js writes it), the call's limits and capacities, the stamp it wrote (rows and light indices)
 * and the call's own time. The wrapper is an own property of the worker, so the worker's methods deoptimize once:
 * `--settle-ms` waits that out before the first copy. Nothing the scene reads is written. A capture is large and
 * local: it stays under tests/results/ (format: stampCapture.mjs).
 *
 *   node tests/bench/captureStampInputs.mjs [--frames 48] [--every 4] [--warmup-ms 12000] [--settle-ms 3000]
 *        [--scene /demos/predatorScene/predatorScene.js] [--scene-export PredatorScene] [--query "hour=0"]
 *        [--output tests/results/stamp-capture/predator.bin] [--root <dir>] [--frames-only]
 * --root serves another tree (an ABAB worktree) with this script; --frames 0 records no frame and only times the
 * stamp in the scene (the mean over the calls of --window-ms).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { parseArgs } from './microbenchHelpers.mjs';
import { encodeStampCapture } from './stampCapture.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = parseArgs();
const frames = Number(args.frames ?? 48);
const every = Math.max(1, Number(args.every ?? 4));
const warmupMs = Number(args['warmup-ms'] ?? 12000);
const settleMs = Number(args['settle-ms'] ?? 3000);
const timeoutMs = Number(args['timeout-ms'] ?? 60000);
const sceneModule = String(args.scene ?? '/demos/predatorScene/predatorScene.js');
const sceneExport = String(args['scene-export'] ?? 'PredatorScene');
const query = typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '';
const out = path.resolve(repoRoot, String(args.output ?? 'tests/results/stamp-capture/predator.bin'));
const serveRoot = args.root ? path.resolve(String(args.root)) : repoRoot;
const windowMs = Number(args['window-ms'] ?? 5000);

/** Installed in the pre-render worker: the wrapper and its store (self.__stampCapture). */
function installCapture({ max, every: k }) {
  const w = self.preRenderWorker;
  if (!w || typeof w._stampRange !== 'function') throw new Error('no pre-render worker with a _stampRange');
  const orig = w._stampRange;
  const cap = { frames: [], calls: 0, recording: false, msSum: 0, msCount: 0 };
  self.__stampCapture = cap;
  w._stampRange = function (spec, sunN, stampBase) {
    const t0 = performance.now();
    const written = orig.call(this, spec, sunN, stampBase);
    const ms = performance.now() - t0;
    if (!cap.recording) return written;
    cap.msSum += ms;
    cap.msCount++;
    if (cap.frames.length >= max) return written;
    if (cap.calls++ % k !== 0) return written;
    const n = sunN | 0;
    const sf = spec.sunFloats | 0;
    const df = spec.stampFloats | 0;
    const capL = spec.lightEnd | 0;
    const lights = new Float64Array(capL * 5);
    for (let i = 0; i < capL; i++) {
      const L = spec.lights ? spec.lights[i] : null;
      if (!L) {
        lights[i * 5 + 3] = NaN;
        continue;
      }
      lights[i * 5] = L.x;
      lights[i * 5 + 1] = L.y;
      lights[i * 5 + 2] = L.intensity;
      lights[i * 5 + 3] = L.rangeSq;
      lights[i * 5 + 4] = L.maxShadows;
    }
    const b = this._stampWasm;
    const base = stampBase | 0;
    cap.frames.push({
      ms,
      sunN: n,
      sunFloats: sf,
      lightBegin: spec.lightBegin | 0,
      lightEnd: capL,
      lightStride: spec.lightStride | 0,
      maxPerLight: spec.maxPerLight | 0,
      maxPerEntity: spec.maxPerEntity | 0,
      stampCap: spec.stampCap | 0,
      stampBase: base,
      stampFloats: df,
      written,
      tmpLen: spec.tmpIdx ? spec.tmpIdx.length : 0,
      gridCountsLen: spec.gridCounts && spec.gridStarts && spec.gridItems ? spec.gridCounts.length : 0,
      gridItemsLen: spec.gridItems ? spec.gridItems.length : 0,
      lightIdxOn: spec.stampLightIdx ? 1 : 0,
      regionMaxSun: b ? b.maxSun : 0,
      regionMaxPerEntity: b ? b.maxPerEntity : 0,
      regionMaxLights: b ? b.maxLights : 0,
      sun: spec.sun && n > 0 ? spec.sun.slice(0, n * sf) : new Float32Array(0),
      lights,
      stamp: written > base ? spec.stamp.slice(base * df, written * df) : new Float32Array(0),
      lightIdx: spec.stampLightIdx && written > base ? spec.stampLightIdx.slice(base, written) : new Uint16Array(0),
    });
    return written;
  };
}

/** One recorded frame from the worker, its arrays as base64. */
function readFrame(i) {
  const f = self.__stampCapture.frames[i];
  const b64 = (ta) => {
    const u8 = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
    let s = '';
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
    return btoa(s);
  };
  const res = {};
  for (const [k, v] of Object.entries(f)) res[k] = ArrayBuffer.isView(v) ? b64(v) : v;
  return res;
}

const TYPED = { sun: Float32Array, lights: Float64Array, stamp: Float32Array, lightIdx: Uint16Array };

const server = await createStaticBenchmarkServer(serveRoot);
const url = `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${query ? `&${query}` : ''}`;
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-webgpu-developer-features',
    '--enable-dawn-features=allow_unsafe_apis',
  ],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (err) => console.error('[page error]', err));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(
    ({ sceneModule: m, sceneExport: e }) =>
      window.__WEED_BENCHMARK__.prepare({
        warmupMs: 1000,
        durationMs: 1000,
        sampleIntervalMs: 100,
        sceneModule: m,
        sceneExport: e,
        collectDetailedStats: false,
        collectGpuStats: false,
      }),
    { sceneModule, sceneExport },
  );
  await page.waitForTimeout(warmupMs);
  const worker = page.workers().find((w) => w.url().includes('preRenderWorker'));
  if (!worker) throw new Error(`no pre-render worker among ${page.workers().map((w) => w.url()).join(', ')}`);
  await worker.evaluate(installCapture, { max: frames, every });
  await page.waitForTimeout(settleMs);
  await worker.evaluate(() => {
    self.__stampCapture.recording = true;
  });
  if (frames === 0) {
    await page.waitForTimeout(windowMs);
    const { msSum, msCount } = await worker.evaluate(() => ({ msSum: self.__stampCapture.msSum, msCount: self.__stampCapture.msCount }));
    console.log(`${path.relative(repoRoot, serveRoot) || '.'}: the stamp in the scene ${(msSum / msCount).toFixed(3)} ms a call over ${msCount} calls`);
    process.exitCode = 0;
  } else {
  const t0 = Date.now();
  for (;;) {
    const have = await worker.evaluate(() => self.__stampCapture.frames.length);
    if (have >= frames) break;
    if (Date.now() - t0 > timeoutMs) throw new Error(`only ${have} of ${frames} stamp calls in ${timeoutMs} ms`);
    await page.waitForTimeout(250);
  }
  const { msSum, msCount } = await worker.evaluate(() => ({ msSum: self.__stampCapture.msSum, msCount: self.__stampCapture.msCount }));
  const captured = [];
  for (let i = 0; i < frames; i++) {
    const raw = await worker.evaluate(readFrame, i);
    const f = {};
    for (const [k, v] of Object.entries(raw)) {
      const T = TYPED[k];
      f[k] = T ? new T(new Uint8Array(Buffer.from(v, 'base64')).buffer) : v;
    }
    captured.push(f);
  }
  const range = (k) => [Math.min(...captured.map((f) => f[k])), Math.max(...captured.map((f) => f[k]))];
  const meta = {
    scene: sceneModule,
    sceneExport,
    query,
    date: new Date().toISOString(),
    chrome: browser.version(),
    warmupMs,
    settleMs,
    every,
    frames,
    sceneMsPerCall: msCount ? msSum / msCount : NaN,
    sceneCalls: msCount,
    sunN: range('sunN'),
    lights: range('lightEnd'),
    written: range('written'),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodeStampCapture({ meta, frames: captured }));
  console.log(`${frames} stamp calls → ${path.relative(repoRoot, out)}`);
  console.log(`  in the scene: ${meta.sceneMsPerCall.toFixed(3)} ms a call over ${msCount} calls`);
  console.log(`  casters ${meta.sunN.join('–')}, lights ${meta.lights.join('–')}, rows written ${meta.written.join('–')}`);
  }
} finally {
  await browser.close();
  await server.close();
}
