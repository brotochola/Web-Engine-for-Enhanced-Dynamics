/**
 * Painter vs useZBuffer at the overlap pixel. Headed. Not a speed bench.
 * Writes tests/results/gpu-ysort/pixel-probe.md
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { CASES, CANVAS_W, CANVAS_H } from './stressScenes/gpuYSortProbeLayout.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const outDir = path.join(repoRoot, 'tests/results/gpu-ysort');

function label(r, g, b) {
  if (r > 180 && b < 50 && g < 50) return 'red';
  if (b > 180 && r < 50 && g < 50) return 'blue';
  if (r < 12 && g < 12 && b < 12) return 'black';
  return `rgb(${r},${g},${b})`;
}

async function sample(page, png) {
  const b64 = png.toString('base64');
  const points = CASES.map((c) => ({ id: c.id, x: c.sampleX, y: c.sampleY }));
  return page.evaluate(async ({ b64, points }) => {
    const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return points.map((p) => {
      const x = Math.max(0, Math.min(bmp.width - 1, p.x | 0));
      const y = Math.max(0, Math.min(bmp.height - 1, p.y | 0));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { id: p.id, x, y, r: d[0], g: d[1], b: d[2] };
    });
  }, { b64, points });
}

async function shoot(port, useZ) {
  const errors = [];
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' || /error|fail|warn/i.test(t)) console.log(`[${useZ ? 'z' : 'painter'}] ${t}`);
  });
  try {
    console.log(useZ ? 'boot z-buffer' : 'boot painter');
    await page.setViewportSize({ width: CANVAS_W, height: CANVAS_H });
    const q = useZ ? '&useZBuffer=1' : '';
    await page.goto(
      `http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1${q}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(({ w, h }) => window.__WEED_BENCHMARK__.prepare({
      warmupMs: 1500,
      durationMs: 500,
      sampleIntervalMs: 100,
      sceneModule: '/tests/bench/stressScenes/gpuYSortProbeScene.js',
      sceneExport: 'GpuYSortProbeScene',
      canvasWidth: w,
      canvasHeight: h,
    }), { w: CANVAS_W, h: CANVAS_H });
    await page.waitForTimeout(2500);
    const canvas = page.locator('canvas').first();
    const png = await canvas.screenshot();
    const pixels = await sample(page, png);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, useZ ? 'zbuffer.png' : 'painter.png'), png);
    if (errors.length) throw new Error(errors.slice(0, 6).join('\n'));
    return pixels;
  } finally {
    await browser.close();
  }
}

const server = await createStaticBenchmarkServer(repoRoot);
let painter;
let zbuffer;
try {
  painter = await shoot(server.port, false);
  zbuffer = await shoot(server.port, true);
} finally {
  await server.close();
}

const lines = ['# Y-sort GPU: píxel de solape', '', 'Painter es la referencia. Un caso coincide cuando el color del sample es el mismo.', ''];
const bad = [];
for (let i = 0; i < CASES.length; i++) {
  const a = painter[i];
  const b = zbuffer[i];
  const la = label(a.r, a.g, a.b);
  const lb = label(b.r, b.g, b.b);
  const same = la === lb;
  if (!same) bad.push(a.id);
  lines.push(`- ${a.id}: painter ${la}, z-buffer ${lb}${same ? '' : ' — desacuerdo'}`);
}
lines.push('', bad.length ? `Desacuerdos: ${bad.join(', ')}.` : 'Ningún desacuerdo.');
await fs.writeFile(path.join(outDir, 'pixel-probe.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (painter.some((p) => label(p.r, p.g, p.b) === 'black') && zbuffer.every((p) => label(p.r, p.g, p.b) === 'black')) {
  process.exitCode = 1;
}
