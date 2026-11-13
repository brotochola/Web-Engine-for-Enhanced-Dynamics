#!/usr/bin/env node
/**
 * What the renderer asks of WebGL in a frame (E-230): Spector.js's capture, for a context that lives in a worker. Spector
 * needs the page's DOM and our WebGL context is Pixi's, on an OffscreenCanvas in the Pixi worker, so this wraps that
 * context's methods from inside the worker for a window of frames and counts, per frame:
 *   - draw calls (drawElements/drawArrays and their instanced forms) and the instances they draw
 *   - state binds (program, textures per unit, buffers per target, vertex arrays, framebuffers, render buffers) and how
 *     many of them bind what was bound already (redundant)
 *   - uniform calls, and the ones that set the same value again where it can tell (uniform1i/1f)
 *   - other state (enable/disable, blend, depth, color mask, viewport, scissor) and its redundant calls
 *   - bytes sent: bufferData/bufferSubData, texImage2D/texSubImage2D/texImage3D/texSubImage3D (from the view or w*h*bpp)
 *   - clears, framebuffer blits, and the calls that make the CPU wait for the GPU (readPixels, getError, finish,
 *     clientWaitSync, getQueryParameter, getBufferSubData)
 * GPU time per frame when EXT_disjoint_timer_query_webgl2 is there (most Windows Chrome builds do not expose it).
 *
 *   node tests/bench/glFrameRecorder.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
 *     [--query k=v&k2=v2] [--warmup-ms 12000] [--record-ms 3000] [--output gl.json]
 * From Git Bash set MSYS_NO_PATHCONV=1. Headed Chrome (a headless one draws on a software path). The wrappers add a
 * little time to each call, so the scene's speed during the window is not a measurement; the counts are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Runs in the Pixi worker: wrap the context, record `ms`, unwrap, return the totals. */
async function recordInWorker({ ms }) {
  const px = self.pixiRenderer;
  const gl = px?.pixiApp?.renderer?.gl;
  if (!gl) return { error: 'no WebGL context in the Pixi worker (a WebGPU backend?)' };
  const proto = Object.getPrototypeOf(gl);
  const counts = Object.create(null);
  const redundant = Object.create(null);
  let draws = 0;
  let instances = 0;
  let bytesBuffer = 0;
  let bytesTexture = 0;
  const bound = { program: null, vao: null, fbo: new Map(), rbo: null, unit: 0, tex: new Map(), buf: new Map() };
  const state = new Map(); // a state call's last arguments, by name and first argument
  const uniformLast = new Map();
  const bpp = (format, type) => {
    const c = { 6408: 4, 6407: 3, 6410: 2, 6409: 1, 6406: 1, 6403: 1, 33319: 2, 36249: 4, 36248: 3, 33320: 1, 36244: 1 }[format] || 4;
    const b = { 5121: 1, 5126: 4, 5131: 2, 36193: 2, 5125: 4, 5124: 4, 5123: 2, 5122: 2 }[type] || 1;
    return c * b;
  };
  const viewBytes = (v) => (v && typeof v.byteLength === 'number' ? v.byteLength : 0);
  const wrapped = [];
  const wrap = (name, before) => {
    // The descriptor's value: reading proto[name] runs a getter (canvas, drawingBufferWidth) on the prototype and throws.
    const orig = Object.getOwnPropertyDescriptor(proto, name)?.value;
    if (typeof orig !== 'function') return;
    const fn = function (...args) {
      counts[name] = (counts[name] || 0) + 1;
      if (before) before(args);
      return orig.apply(this, args);
    };
    gl[name] = fn;
    wrapped.push(name);
  };
  const redo = (name) => {
    redundant[name] = (redundant[name] || 0) + 1;
  };
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value !== 'function' || name === 'constructor') continue;
    let hook = null;
    if (name === 'drawElements' || name === 'drawArrays') hook = () => { draws++; instances++; };
    else if (name === 'drawElementsInstanced') hook = (a) => { draws++; instances += a[4] | 0; };
    else if (name === 'drawArraysInstanced') hook = (a) => { draws++; instances += a[3] | 0; };
    else if (name === 'useProgram') hook = (a) => { if (bound.program === a[0]) redo(name); bound.program = a[0]; };
    else if (name === 'bindVertexArray') hook = (a) => { if (bound.vao === a[0]) redo(name); bound.vao = a[0]; };
    else if (name === 'activeTexture') hook = (a) => { if (bound.unit === a[0]) redo(name); bound.unit = a[0]; };
    else if (name === 'bindTexture') hook = (a) => { const k = `${bound.unit}:${a[0]}`; if (bound.tex.get(k) === a[1]) redo(name); bound.tex.set(k, a[1]); };
    else if (name === 'bindBuffer') hook = (a) => { if (bound.buf.get(a[0]) === a[1]) redo(name); bound.buf.set(a[0], a[1]); };
    else if (name === 'bindFramebuffer') hook = (a) => { if (bound.fbo.get(a[0]) === a[1]) redo(name); bound.fbo.set(a[0], a[1]); };
    else if (name === 'bindRenderbuffer') hook = (a) => { if (bound.rbo === a[1]) redo(name); bound.rbo = a[1]; };
    else if (name === 'bufferData') hook = (a) => { bytesBuffer += typeof a[1] === 'number' ? a[1] : viewBytes(a[1]); };
    else if (name === 'bufferSubData') hook = (a) => { bytesBuffer += a[4] ? (a[4] | 0) * (a[2].BYTES_PER_ELEMENT || 1) : viewBytes(a[2]); };
    else if (name === 'texImage2D' || name === 'texSubImage2D' || name === 'texImage3D' || name === 'texSubImage3D') {
      hook = (a) => {
        const view = a.find((x) => x && typeof x.byteLength === 'number');
        if (view) bytesTexture += view.byteLength;
        else if (name === 'texSubImage2D' && typeof a[4] === 'number' && typeof a[5] === 'number') bytesTexture += a[4] * a[5] * bpp(a[6], a[7]);
        else if (name === 'texImage2D' && typeof a[3] === 'number' && typeof a[4] === 'number') bytesTexture += a[3] * a[4] * bpp(a[6], a[7]);
        else if (a[a.length - 1] && a[a.length - 1].width) bytesTexture += a[a.length - 1].width * a[a.length - 1].height * 4;
      };
    } else if (name === 'uniform1i' || name === 'uniform1f') {
      hook = (a) => { const k = a[0]; if (k && uniformLast.get(k) === a[1]) redo(name); uniformLast.set(k, a[1]); };
    } else if (['enable', 'disable', 'blendFunc', 'blendFuncSeparate', 'blendEquation', 'blendEquationSeparate', 'depthMask', 'depthFunc', 'colorMask', 'viewport', 'scissor', 'cullFace', 'frontFace', 'clearColor', 'pixelStorei', 'stencilMask', 'stencilFunc', 'stencilOp'].includes(name)) {
      hook = (a) => {
        const key = name === 'enable' || name === 'disable' ? `cap:${a[0]}` : name === 'pixelStorei' ? `${name}:${a[0]}` : name;
        const val = name === 'enable' ? 1 : name === 'disable' ? 0 : a.join(',');
        if (state.get(key) === val) redo(name);
        state.set(key, val);
      };
    }
    wrap(name, hook);
  }
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const f0 = px.frameNumber | 0;
  const t0 = performance.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const frames = (px.frameNumber | 0) - f0;
  const elapsed = performance.now() - t0;
  for (const name of wrapped) delete gl[name];
  const per = (v) => Math.round((v / Math.max(1, frames)) * 10) / 10;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, perFrame: per(n), redundantPerFrame: per(redundant[name] || 0) }));
  return {
    frames,
    ms: Math.round(elapsed),
    timerQuery: Boolean(timer),
    perFrame: {
      calls: per(Object.values(counts).reduce((s, n) => s + n, 0)),
      draws: per(draws),
      instances: per(instances),
      bytesBuffer: per(bytesBuffer),
      bytesTexture: per(bytesTexture),
      redundant: per(Object.values(redundant).reduce((s, n) => s + n, 0)),
      syncCalls: per(['readPixels', 'getError', 'finish', 'clientWaitSync', 'getQueryParameter', 'getBufferSubData', 'getParameter'].reduce((s, n) => s + (counts[n] || 0), 0)),
    },
    top,
  };
}

export async function recordGlFrames(opts) {
  const server = await createStaticBenchmarkServer(repoRoot);
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${opts.query ? `&${opts.query}` : ''}`);
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__));
    await page.evaluate(({ m, e }) => window.__WEED_BENCHMARK__.prepare({ warmupMs: 600000, durationMs: 600000, sampleIntervalMs: 1000,
      sceneModule: m, sceneExport: e, collectDetailedStats: false, collectGpuStats: false }), { m: opts.scene, e: opts.sceneExport });
    await page.waitForTimeout(opts.warmupMs);
    const worker = page.workers().find((w) => w.url().includes('pixiWorker'));
    if (!worker) throw new Error('no Pixi worker');
    return await worker.evaluate(recordInWorker, { ms: opts.recordMs });
  } finally {
    await browser.close();
    await server.close?.();
  }
}

async function main() {
  const args = parseArgs();
  if (!args.scene || !args['scene-export']) {
    console.error('usage: glFrameRecorder.mjs --scene <module> --scene-export <Class> [--query k=v] [--warmup-ms N] [--record-ms N] [--output file]');
    process.exit(2);
  }
  const r = await recordGlFrames({
    scene: String(args.scene),
    sceneExport: String(args['scene-export']),
    query: typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '',
    warmupMs: Number(args['warmup-ms'] ?? 12000),
    recordMs: Number(args['record-ms'] ?? 3000),
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  const p = r.perFrame;
  console.log(`${r.frames} frames in ${r.ms} ms; per frame: ${p.calls} GL calls, ${p.draws} draws (${p.instances} instances), ` +
    `${p.redundant} redundant, ${(p.bytesBuffer / 1024).toFixed(1)} KB buffers, ${(p.bytesTexture / 1024).toFixed(1)} KB textures, ` +
    `${p.syncCalls} calls that wait for the GPU; timer queries: ${r.timerQuery ? 'yes' : 'no'}`);
  for (const row of r.top.slice(0, 30)) console.log(`  ${String(row.perFrame).padStart(7)}  ${row.name}${row.redundantPerFrame ? `  (${row.redundantPerFrame} redundant)` : ''}`);
  if (args.output) fs.writeFileSync(String(args.output), JSON.stringify(r, null, 1));
}

if (isCli(import.meta.url)) await main();
