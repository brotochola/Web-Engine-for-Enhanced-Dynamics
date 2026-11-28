#!/usr/bin/env node
/**
 * E-525: the render targets a scene's renderer holds, and their bytes. Opens the bench page on a scene, waits, and reads in
 * the Pixi worker every surface Pixi's RenderTargetSystem has drawn into (the canvas left out): its colour textures and its
 * depth-stencil texture, their sizes and formats, the bytes they take at every mip level, and the paths from the renderer
 * (self.pixiRenderer) that reach each one (customLayers.byId.7.rt, screenLayers.sceneRT, lighting.lightingRT ...). A
 * target made and never drawn into is not counted: Pixi allocates it on its first draw.
 *
 *   node tests/bench/renderTargetProbe.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene \
 *     [--query k=v (repeatable)] [--canvas 1920x1080] [--wait-ms 8000] [--resize 1280x720] [--headless] [--json out.json]
 *
 * --resize WxH: reads once, resizes the canvas (window.scene.resize), waits --wait-ms again and reads again: what the scene
 * holds at the new size, the old size's targets gone. --json: both reads, every target, to a file. From Git Bash set
 * MSYS_NO_PATHCONV=1. Read-only: it changes nothing in the worker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function parseSize(text, what) {
  const m = /^(\d+)x(\d+)$/.exec(String(text));
  if (!m) throw new Error(`renderTargetProbe: ${what} is WxH (1920x1080), not ${text}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseCli(argv) {
  const opts = { query: [], canvas: { width: 1920, height: 1080 }, waitMs: 8000, resize: null, headless: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--scene') opts.scene = next();
    else if (arg === '--scene-export') opts.sceneExport = next();
    else if (arg === '--query') opts.query.push(next());
    else if (arg === '--canvas') opts.canvas = parseSize(next(), '--canvas');
    else if (arg === '--wait-ms') opts.waitMs = Number(next());
    else if (arg === '--resize') opts.resize = parseSize(next(), '--resize');
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--json') opts.json = next();
    else throw new Error(`renderTargetProbe: unknown argument ${arg}`);
  }
  if (!opts.scene || !opts.sceneExport) throw new Error('renderTargetProbe: --scene and --scene-export are required');
  return opts;
}

/** Runs in the Pixi worker: every target drawn into, its bytes and the renderer's paths to it. */
function readTargets() {
  const px = self.pixiRenderer;
  const renderer = px?.pixiApp?.renderer;
  const hash = renderer?.renderTarget?._renderSurfaceToRenderTargetHash;
  if (!hash) return { error: 'no Pixi render target system in the worker' };
  const BYTES = {
    r8unorm: 1, r8snorm: 1, r8uint: 1, rg8unorm: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4,
    rgba8snorm: 4, rgba8uint: 4, r16float: 2, rg16float: 4, rgba16float: 8, r32float: 4, rg32float: 8, rgba32float: 16,
    r32uint: 4, rg32uint: 8, rgba32uint: 16, rgb10a2unorm: 4, rg11b10ufloat: 4, depth16unorm: 2, depth24plus: 4,
    'depth24plus-stencil8': 4, depth32float: 4, 'depth32float-stencil8': 5, stencil8: 1,
  };
  const entries = new Map();
  // A depth-stencil texture is named after its target's colour texture.
  const depthOf = new Map();
  const add = (source, kind) => {
    if (!source || entries.has(source)) return;
    const per = BYTES[source.format] ?? 4;
    let w = Math.max(1, Math.floor(source.pixelWidth));
    let h = Math.max(1, Math.floor(source.pixelHeight));
    const size = [w, h];
    let bytes = 0;
    const levels = Math.max(1, source.mipLevelCount | 0);
    for (let l = 0; l < levels; l++) {
      bytes += w * h * per;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    entries.set(source, { kind, width: size[0], height: size[1], format: String(source.format), levels, bytes, names: [] });
  };
  // The canvas: the root target, its colour texture the canvas itself (isRoot is set on every target on WebGPU).
  const isCanvas = (source) => typeof OffscreenCanvas !== 'undefined' && source?.resource instanceof OffscreenCanvas;
  hash.forEach((target) => {
    const colors = target.colorTextures || [];
    if (target === renderer.renderTarget.rootRenderTarget || (colors.length > 0 && isCanvas(colors[0]))) return;
    for (let i = 0; i < colors.length; i++) add(colors[i], 'color');
    add(target.depthStencilTexture, 'depth');
    if (target.depthStencilTexture && colors.length > 0) depthOf.set(target.depthStencilTexture, colors[0]);
  });

  // The renderer's paths to each target, shortest first (breadth first, a few levels down, Pixi's own objects not entered).
  const SKIP = new Set(['pixiApp', 'worker', 'parent', 'renderer', '_events', 'gl', 'gpu', 'device', 'config']);
  const MAX_DEPTH = 6;
  const MAX_NAMES = 6;
  const MAX_NODES = 400000;
  const seen = new Set();
  const queue = [[px, '', 0]];
  let nodes = 0;
  for (let q = 0; q < queue.length && nodes < MAX_NODES; q++) {
    const [obj, at, depth] = queue[q];
    if (obj === null || typeof obj !== 'object' || seen.has(obj)) continue;
    seen.add(obj);
    nodes++;
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer
      || (typeof SharedArrayBuffer !== 'undefined' && obj instanceof SharedArrayBuffer)) continue;
    const visit = (value, name) => {
      if (value === null || typeof value !== 'object') return;
      const hit = entries.get(value) || (value.isTexture === true ? entries.get(value.source) : undefined);
      if (hit !== undefined) {
        if (hit.names.length < MAX_NAMES) hit.names.push(name);
        return;
      }
      if (value.isTexture === true || (value.uid !== undefined && value.pixelWidth !== undefined)) return;
      if (depth + 1 < MAX_DEPTH) queue.push([value, name, depth + 1]);
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj) visit(value, `${at}.get(${String(key)})`);
      continue;
    }
    if (obj instanceof Set) continue;
    const keys = Object.keys(obj);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (SKIP.has(key)) continue;
      let value;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      visit(value, at ? `${at}.${key}` : key);
    }
  }
  depthOf.forEach((color, depth) => {
    const d = entries.get(depth);
    const c = entries.get(color);
    if (d.names.length === 0 && c) d.names = c.names.map((n) => `depth of ${n}`);
  });
  const targets = [...entries.values()].sort((a, b) => b.bytes - a.bytes || a.names.join().localeCompare(b.names.join()));
  let bytes = 0;
  for (const t of targets) bytes += t.bytes;
  return {
    backend: px._useWebGpu ? 'webgpu' : 'webgl',
    canvas: [px.canvasWidth, px.canvasHeight],
    count: targets.length,
    colorCount: targets.filter((t) => t.kind === 'color').length,
    bytes,
    targets,
  };
}

function report(label, read) {
  if (read.error) {
    console.log(`${label}: ${read.error}`);
    return;
  }
  const mb = (b) => (b / (1024 * 1024)).toFixed(2);
  console.log(`${label}: ${read.backend}, canvas ${read.canvas.join('x')}: ${read.count} targets (${read.colorCount} colour), ` +
    `${mb(read.bytes)} MiB`);
  for (const t of read.targets) {
    const names = t.names.length ? t.names.join(', ') : '(no path from the renderer)';
    console.log(`  ${`${t.width}x${t.height}`.padEnd(10)} ${t.format.padEnd(21)} ${t.kind.padEnd(5)} ${mb(t.bytes).padStart(7)} MiB  ${names}`);
  }
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const server = await createStaticBenchmarkServer(repoRoot);
  const browser = await chromium.launch({
    headless: opts.headless,
    channel: 'chrome',
    args: ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu'],
  });
  const errors = [];
  const reads = [];
  try {
    const page = await browser.newPage({ viewport: opts.canvas });
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const params = new URLSearchParams('src=1');
    for (const pair of opts.query) {
      const [key, value = ''] = pair.split('=');
      params.set(key, value);
    }
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(({ scene, sceneExport, size }) => window.__WEED_BENCHMARK__.prepare({
      warmupMs: 1000, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport,
      canvasWidth: size.width, canvasHeight: size.height,
    }), { scene: opts.scene, sceneExport: opts.sceneExport, size: opts.canvas });
    await page.waitForTimeout(opts.waitMs);
    const worker = () => {
      const w = page.workers().find((x) => x.url().includes('pixiWorker'));
      if (!w) throw new Error(`renderTargetProbe: no Pixi worker (${page.workers().map((x) => x.url()).join(', ')})`);
      return w;
    };
    reads.push(await worker().evaluate(readTargets));
    report(`${opts.sceneExport} [${opts.query.join(' ')}]`, reads[0]);
    if (opts.resize) {
      await page.evaluate(({ width, height }) => window.scene.resize(width, height), opts.resize);
      await page.waitForTimeout(opts.waitMs);
      reads.push(await worker().evaluate(readTargets));
      report(`after resize to ${opts.resize.width}x${opts.resize.height}`, reads[1]);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (errors.length) console.log(`page errors: ${errors.slice(0, 5).join(' | ')}`);
  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify({ scene: opts.scene, sceneExport: opts.sceneExport, query: opts.query, reads, errors }, null, 2));
  }
  process.exitCode = errors.length ? 1 : 0;
}

await main();
