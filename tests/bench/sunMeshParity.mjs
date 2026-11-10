#!/usr/bin/env node
/**
 * DX-SUNMESH: a ShadowCaster's sprite and a sunProjected mesh of the same height end their shadows at the same point,
 * for several hours, on one backend. Draws sunMeshParityScene each way, finds the shadow's far end (the dark pixel
 * farthest from the bar's foot) and prints both, with the distance between them. Exit 1 past --limit px (default 1.5: the
 * 2 px post's half diagonal, since the sprite's end is a turned edge and the post's a square corner).
 *
 *   node tests/bench/sunMeshParity.mjs [--backend webgl|webgpu] [--limit 1.5] [--hours 7,9,11,14,16,17] [--bar mesh|volume]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };
const FOOT = { x: 640, y: 360 };

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const BACKEND = option('backend', 'webgl');
const LIMIT = Number(option('limit', 1.5));
const HOURS = option('hours', '7,9,11,14,16,17').split(',').map(Number);
const BAR = option('bar', 'mesh');

async function shadowEnd(browser, server, bar, hour) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1&bar=${bar}&hour=${hour}&backend=${BACKEND}`,
      { waitUntil: 'networkidle' },
    );
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate((size) => window.__WEED_BENCHMARK__.prepare({
      warmupMs: 2000,
      durationMs: 500,
      sampleIntervalMs: 100,
      sceneModule: '/tests/bench/stressScenes/sunMeshParityScene.js',
      sceneExport: 'SunMeshParityScene',
      canvasWidth: size.width,
      canvasHeight: size.height,
    }), VIEWPORT);
    await page.waitForTimeout(2000);
    const png = await captureCanvasPng(page);
    const end = await page.evaluate(async ({ b64, foot }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
      let lightest = 0;
      let darkest = 255;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > lightest) lightest = data[i];
        if (data[i] < darkest) darkest = data[i];
      }
      const cut = (lightest + darkest) / 2;
      // Far end: the mean of the dark pixels within 1.5 px of the farthest one, which centres it on the bar's width.
      let far = 0;
      let dark = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4] < cut) {
            dark++;
            const d = Math.sqrt((x - foot.x) * (x - foot.x) + (y - foot.y) * (y - foot.y));
            if (d > far) far = d;
          }
        }
      }
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4] < cut) {
            const d = Math.sqrt((x - foot.x) * (x - foot.x) + (y - foot.y) * (y - foot.y));
            if (d >= far - 1.5) {
              sx += x;
              sy += y;
              n++;
            }
          }
        }
      }
      return { x: n ? sx / n : NaN, y: n ? sy / n : NaN, far, dark, darkest, lightest };
    }, { b64: png.toString('base64'), foot: FOOT });
    return { ...end, errors };
  } finally {
    await page.close();
  }
}

const server = await createStaticBenchmarkServer(repoRoot);
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu'],
});
let failed = false;
try {
  for (const hour of HOURS) {
    const sprite = await shadowEnd(browser, server, 'sprite', hour);
    const mesh = await shadowEnd(browser, server, BAR, hour);
    const dx = sprite.x - mesh.x;
    const dy = sprite.y - mesh.y;
    const gap = Math.sqrt(dx * dx + dy * dy);
    const errors = [...sprite.errors, ...mesh.errors];
    const ok = gap <= LIMIT && sprite.dark > 0 && mesh.dark > 0 && errors.length === 0;
    if (!ok) failed = true;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${BACKEND} ${hour} h: sprite end (${sprite.x.toFixed(1)}, ${sprite.y.toFixed(1)}), ` +
        `${BAR} end (${mesh.x.toFixed(1)}, ${mesh.y.toFixed(1)}), ${gap.toFixed(2)} px apart; ` +
        `dark ${sprite.dark}/${mesh.dark} px, darkest ${sprite.darkest}/${mesh.darkest}` +
        (errors.length ? `; ${errors.slice(0, 2).join(' | ')}` : ''),
    );
  }
} finally {
  await browser.close();
  await server.close();
}
process.exitCode = failed ? 1 : 0;
