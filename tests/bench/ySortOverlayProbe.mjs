/**
 * Painter vs useZBuffer vs bitonic at the cutout/blend crossings.
 * Headed. Not a speed bench. Writes tests/results/bitonic-ysort/overlay-probe.md
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { OVERLAY } from './stressScenes/ySortOverlayLayout.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const outDir = path.join(repoRoot, 'tests/results/bitonic-ysort');

const VARIANTS = [
  { id: 'cpu', query: 'backend=webgpu&ySort=cpu&useZBuffer=0' },
  { id: 'z', query: 'backend=webgpu&ySort=cpu&useZBuffer=1' },
  { id: 'bitonic', query: 'backend=webgpu&ySort=bitonic' },
];

function colorDist(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

function fmt(p) {
  return `rgb(${p.r},${p.g},${p.b})`;
}

async function sample(page, png) {
  const b64 = png.toString('base64');
  const points = [
    { id: 'behind', x: OVERLAY.sampleBehind.x, y: OVERLAY.sampleBehind.y },
    { id: 'front', x: OVERLAY.sampleFront.x, y: OVERLAY.sampleFront.y },
  ];
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

async function shoot(port, variant) {
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
    if (msg.type() === 'error' || /WeedJS:|error|fail/i.test(t)) {
      console.log(`[${variant.id}] ${t}`);
    }
  });
  try {
    console.log(`boot ${variant.id}`);
    await page.setViewportSize({ width: OVERLAY.canvasW, height: OVERLAY.canvasH });
    await page.goto(
      `http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1&${variant.query}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(({ w, h }) => window.__WEED_BENCHMARK__.prepare({
      warmupMs: 2000,
      durationMs: 500,
      sampleIntervalMs: 100,
      sceneModule: '/tests/bench/stressScenes/ySortOverlayScene.js',
      sceneExport: 'YSortOverlayScene',
      canvasWidth: w,
      canvasHeight: h,
    }), { w: OVERLAY.canvasW, h: OVERLAY.canvasH });
    await page.waitForTimeout(4000);
    const canvas = page.locator('canvas').first();
    const png = await canvas.screenshot();
    const pixels = await sample(page, png);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, `${variant.id}.png`), png);
    if (errors.length) throw new Error(errors.slice(0, 6).join('\n'));
    return pixels;
  } finally {
    await browser.close();
  }
}

const server = await createStaticBenchmarkServer(repoRoot);
const shots = {};
try {
  for (const v of VARIANTS) shots[v.id] = await shoot(server.port, v);
} finally {
  await server.close();
}

const lines = [
  '# Overlay Y-sort: cruce cutout / blend',
  '',
  'Painter (`ySort: cpu`) es la referencia. Bitonic tiene que coincidir en los dos samples.',
  '`useZBuffer` es el contraste: un solo lote que escribe Z rompe el cruce transparente.',
  '',
];
const tol = 25;
let mismatch = 0;
for (const id of ['behind', 'front']) {
  const cpu = shots.cpu.find((p) => p.id === id);
  const z = shots.z.find((p) => p.id === id);
  const bit = shots.bitonic.find((p) => p.id === id);
  const bitOk = colorDist(cpu, bit) <= tol;
  const zOk = colorDist(cpu, z) <= tol;
  if (!bitOk) mismatch++;
  lines.push(
    `- ${id}: cpu ${fmt(cpu)}, bitonic ${fmt(bit)}${bitOk ? '' : ' — desacuerdo'}, `
    + `useZBuffer ${fmt(z)}${zOk ? '' : ' — desacuerdo (esperado si el cruce escribe Z)'}`,
  );
}
lines.push('', mismatch ? `Bitonic no iguala al painter (${mismatch} sample(s)).` : 'Bitonic iguala al painter.');
await fs.writeFile(path.join(outDir, 'overlay-probe.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (mismatch) process.exitCode = 1;
