#!/usr/bin/env node
/**
 * What the renderer asks of WebGPU in a frame, and what each pass and draw costs on the GPU (E-230): glFrameRecorder's
 * WebGPU side. The device is the Pixi worker's, so this wraps the WebGPU prototypes in that worker for a window of
 * frames and counts, per frame:
 *   - passes (render, compute), draws (draw, drawIndexed and the indirect forms) and their instances, dispatches
 *   - state calls (setPipeline, setBindGroup, setVertexBuffer, setIndexBuffer, viewport, scissor, ...) and the ones
 *     that set what the pass had set already (redundant)
 *   - uploads (queue.writeBuffer, writeTexture, copyExternalImageToTexture, in bytes), copies and buffer clears
 *   - the objects made in the window (bind groups, buffers, textures, views, samplers), encoders and submits
 *
 * GPU time (timestamp queries; the engine's device asks for 'timestamp-query'):
 *   --gpu-passes    each render and compute pass from timestamps at its beginning and end (timestampWrites, core
 *                   WebGPU), labelled by its first colour attachment (texture id, size, format, label or 'canvas') and
 *                   its first pipeline. A pass's time is its own: a command buffer reaches the GPU whole, so no pass
 *                   waits for the CPU inside (WebGL's timer ranges do). The frame's span on the GPU, from its first pass
 *                   to its last, also counts the gaps between its submits.
 *   --gpu-draws     a timestamp before and after each draw and dispatch as well: writeTimestamp inside the pass, Chrome's
 *                   'chromium-experimental-timestamp-query-inside-passes', which the bench page asks the device for
 *                   (config.debug.gpuTimestampsInsidePasses). Each draw is labelled by its pass, its place in it, its
 *                   pipeline (the label: Pixi's names the program; else an id) with the names its shaders bind, and the
 *                   textures of its bind groups. A pass's own share is timed too: from its beginning to its first draw
 *                   (the attachments' load or clear) and from its last draw to its end (store, MSAA resolve); the pass
 *                   minus its draws and those two is the gaps between draws (state changes). A timestamp is written when
 *                   the work before it is done, so a draw's time runs from the end of what came before it to its own
 *                   end, and draws that overlap on the GPU are not counted twice. Without the feature, pass times only.
 *   --split-passes  per draw without that feature: each draw and dispatch in a pass of its own, timed by that pass's
 *                   timestampWrites. The caller's pass is a stand-in that keeps the pass's state and sets it again in
 *                   each new pass; a first pass clears, the draws' passes load and store, a last pass stores or
 *                   resolves as the caller's would have. Each draw's time then includes its own pass's beginning and
 *                   end: an empty pass, timed once per caller's pass, shows how much. The frame drawn is the same.
 *
 * Chrome (157 here) quantizes timestamps to 2^16 ns unless --enable-webgpu-developer-features is on, and reports the
 * inside-passes feature only with unsafe WebGPU APIs allowed (the developer features alone do not). This tool launches
 * Chrome with --enable-webgpu-developer-features --enable-unsafe-webgpu; --no-dev-features leaves both off (for a
 * check) and --chrome-args "<flags>" sets others. Timestamps are read back per command buffer: the queries an encoder
 * wrote are resolved into a buffer at its finish() and a copy is mapped after its submit. A query set is not written
 * again until its copy has been read (R-0204: rewriting one with a map pending hung Chrome's GPU process).
 *
 * The objects' names (each shader's binding names, each pipeline's descriptor, each view's texture, each bind group's
 * textures) come from hooks on the creation calls, put in the Pixi worker when it starts, before it creates its device
 * (webgpuRecorderWorker.mjs); views Pixi made are also named from its own record. The wrappers add CPU time to each
 * call and the timestamps add GPU work, so the scene's speed in the window is not a measurement.
 *
 *   node tests/bench/webgpuFrameRecorder.mjs --scene /demos/gpuGalaxyScene/gpuGalaxyScene.js --scene-export GpuGalaxyScene
 *     [--query k=v&k2=v2] [--warmup-ms 12000] [--record-ms 3000] [--gpu-passes | --gpu-draws | --split-passes]
 *     [--no-dev-features | --chrome-args "<flags>"] [--output wgpu.json]
 * From Git Bash set MSYS_NO_PATHCONV=1. Headed Chrome. A scene whose backend is WebGL by default needs
 * --query backend=webgpu.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { withGpuClocks } from './glFrameRecorder.mjs';
import { installCreationHooks, recordInWorker } from './webgpuRecorderWorker.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { benchWindowArgs, rememberBenchWindow } from './benchWindow.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function recordWebGpuFrames(opts) {
  const server = await createStaticBenchmarkServer(repoRoot);
  // The developer features turn the quantization of timestamps off; the inside-passes feature is experimental in Dawn,
  // which reports it only with unsafe APIs allowed (Chrome 157: not with the developer features alone).
  const flags = opts.chromeArgs || (opts.devFeatures === false ? [] : ['--enable-webgpu-developer-features', '--enable-unsafe-webgpu']);
  const args = ['--mute-audio', ...flags, ...benchWindowArgs()];
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    let hooks = null;
    page.on('worker', (w) => {
      if (!w.url().includes('pixiWorker')) return;
      hooks = w.evaluate(installCreationHooks).catch((e) => `failed: ${e.message}`);
    });
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${opts.query ? `&${opts.query}` : ''}`);
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__));
    await page.evaluate(({ m, e, inside }) => window.__WEED_BENCHMARK__.prepare({ warmupMs: 600000, durationMs: 600000, sampleIntervalMs: 1000,
      sceneModule: m, sceneExport: e, collectDetailedStats: false, collectGpuStats: false, gpuTimestampsInsidePasses: inside }),
    { m: opts.scene, e: opts.sceneExport, inside: opts.mode === 'draws' });
    await page.waitForTimeout(opts.warmupMs);
    const worker = page.workers().find((w) => w.url().includes('pixiWorker'));
    if (!worker) throw new Error('no Pixi worker');
    const hookState = await hooks;
    // A GPU process that stops answering (R-0204) leaves the evaluate pending: give up after the window and 30 s.
    let timer = 0;
    const stuck = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ error: `the Pixi worker did not answer within ${opts.recordMs + 30000} ms (GPU process stuck?)` }), opts.recordMs + 30000);
    });
    const { result, clocks } = await withGpuClocks(() => Promise.race([worker.evaluate(recordInWorker, { ms: opts.recordMs, mode: opts.mode }), stuck]));
    clearTimeout(timer);
    await rememberBenchWindow(page);
    if (result && !result.error) {
      result.gpuClocks = clocks;
      result.hookState = hookState;
      result.chrome = browser.version();
      result.devFeatures = flags.includes('--enable-webgpu-developer-features');
      result.chromeArgs = flags;
    }
    return result;
  } finally {
    await browser.close();
    await server.close?.();
  }
}

export function printResult(r) {
  const p = r.perFrame;
  console.log(`${r.frames} frames in ${r.ms} ms (Chrome ${r.chrome}${r.devFeatures ? ', WebGPU developer features' : ''}; ` +
    `${r.adapter ? `${r.adapter.description || r.adapter.vendor} ${r.adapter.architecture || ''}`.trim() : 'adapter ?'})`);
  console.log(`per frame: ${p.calls} WebGPU calls, ${p.renderPasses} render passes, ${p.computePasses} compute passes, ${p.draws} draws ` +
    `(${p.instances} instances), ${p.dispatches} dispatches, ${p.redundant} redundant, ${(p.bytesBuffer / 1024).toFixed(1)} KB buffers, ` +
    `${(p.bytesTexture / 1024).toFixed(1)} KB textures, ${p.submits} submits`);
  for (const row of r.top.slice(0, 30)) console.log(`  ${String(row.perFrame).padStart(7)}  ${row.name}${row.redundantPerFrame ? `  (${row.redundantPerFrame} redundant)` : ''}`);
  console.log('uploads, copies and objects made, per frame:');
  for (const row of r.detail.slice(0, 20)) console.log(`  ${String(row.perFrame).padStart(6)} calls ${String(row.kbPerFrame).padStart(7)} KB  ${row.key}`);
  if (r.hooks) {
    console.log(`names: creation hooks ${r.hookState}${r.hooks.beforeDevice ? ' before the device' : ' (not before the device: some objects unnamed)'}; ` +
      `${r.hooks.unknownViews} unnamed views, ${r.hooks.unknownPipelines} unnamed pipelines in the window`);
  }
  if (r.errors?.length) console.log(`WebGPU errors in the window: ${r.errors.join(' | ')}`);
  const g = r.gpu;
  if (g) {
    const q = g.quantized === null ? '' : g.quantized > 0.9 ? ', QUANTIZED (65.5 or 100 us steps)' : '';
    const how = g.perDraw ? ' + a timestamp around each draw' : g.split ? ': each draw in a pass of its own' : '';
    console.log(`GPU time by pass (timestampWrites${how}${q}; ${g.invalid} invalid, ${g.lost} unread, ` +
      `${g.skippedEncoders} encoders untimed): ${g.msPerFrame.toFixed(3)} ms a frame in passes; a frame's span on the GPU (first pass begin to last ` +
      `pass end, median of ${g.framesTimed}): ${g.spanMsMedian.toFixed(3)} ms, its passes summed ${g.passSumMsMedian.toFixed(3)} ms`);
    if (!g.perDraw && !g.split && !g.insidePasses) console.log('  (no timestamps inside passes on this device: pass times only; --split-passes times each draw in a pass of its own)');
    if (g.split) {
      const e = g.passes.reduce((t, p) => [t[0] + p.emptyPassNs, t[1] + p.emptyPasses], [0, 0]);
      console.log(`  a pass's draws, clear and end each in a pass of their own; an empty pass took ${e[1] ? (e[0] / e[1] / 1000).toFixed(1) : '?'} us on average (in each draw's time)`);
    }
    for (const row of g.passes.slice(0, 25)) {
      const parts = g.perDraw || g.split ? `  [draws ${row.drawsMsPerFrame.toFixed(3)}, to 1st draw ${row.preMsPerFrame.toFixed(3)}, end ${row.postMsPerFrame.toFixed(3)}]` : '';
      console.log(`  ${row.msPerFrame.toFixed(3).padStart(7)} ms  x${row.passesPerFrame.toFixed(1).padStart(4)} ${row.drawsPerFrame.toFixed(1).padStart(6)} draws ` +
        `${String(Math.round(row.instancesPerFrame)).padStart(8)} inst  ${row.label}${parts}`);
    }
    if (g.draws) {
      console.log('the costliest draws (and the passes\' own parts):');
      for (const row of g.draws.slice(0, 30)) {
        console.log(`  ${row.msPerFrame.toFixed(3).padStart(7)} ms  x${row.perFrame.toFixed(1).padStart(5)} ${String(Math.round(row.instancesPerFrame)).padStart(8)} inst  ${row.label}`);
      }
    }
  }
  if (r.gpuClocks) {
    const c = r.gpuClocks;
    console.log(`GPU clocks in the window (nvidia-smi, ${c.samples} samples): ${Object.entries(c.pstates).map(([k, v]) => `${k} ${v} %`).join(', ')}; ` +
      `median ${c.clockMHz} MHz, ${c.utilization} % busy`);
  }
}

async function main() {
  const args = parseArgs();
  if (!args.scene || !args['scene-export']) {
    console.error('usage: webgpuFrameRecorder.mjs --scene <module> --scene-export <Class> [--query k=v] [--warmup-ms N] [--record-ms N] ' +
      '[--gpu-passes | --gpu-draws | --split-passes] [--no-dev-features | --chrome-args "<flags>"] [--output file]');
    process.exit(2);
  }
  const r = await recordWebGpuFrames({
    scene: String(args.scene),
    sceneExport: String(args['scene-export']),
    query: typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '',
    warmupMs: Number(args['warmup-ms'] ?? 12000),
    recordMs: Number(args['record-ms'] ?? 3000),
    mode: args['split-passes'] ? 'split' : args['gpu-draws'] ? 'draws' : args['gpu-passes'] ? 'passes' : 'counts',
    devFeatures: !args['no-dev-features'],
    // --chrome-args "<flags>": Chrome's WebGPU flags instead of the developer features and unsafe APIs.
    chromeArgs: typeof args['chrome-args'] === 'string' ? args['chrome-args'].split(/\s+/).filter(Boolean) : null,
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  printResult(r);
  if (args.output) fs.writeFileSync(String(args.output), JSON.stringify(r, null, 1));
}

if (isCli(import.meta.url)) await main();
