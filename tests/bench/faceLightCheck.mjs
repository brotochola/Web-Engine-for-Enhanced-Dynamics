#!/usr/bin/env node
/**
 * DX-FACES against its formula: faceLightScene.js draws white faces, so each pixel reads the light itself, and this
 * samples each face on a grid and compares with what the lamps, the sun and the ambient give at that 3D point. The
 * formula here is written from the design, not from the shader. Checks a knob by its numbers:
 *
 *   node tests/bench/faceLightCheck.mjs [--query k=v ...] [--tolerance 3] [--headless] [--save file.png]
 *
 * --query: the scene's knobs (hour, wrap, gain, sunDirect, groundScaleY, heightScaleY, backend and the sprite paths).
 * Exit 0 when every sample is within --tolerance of 255. Prints the worst sample of each face.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng } from '../helpers/visualPngCompare.mjs';
import { faceLightLayout, project } from './stressScenes/faces/faceLightLayout.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };
const GRID = 7;

function parseCli(argv) {
  const opts = { query: [], tolerance: 3, headless: false, waitMs: 2500 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--query') opts.query.push(argv[++i]);
    else if (arg === '--tolerance') opts.tolerance = Number(argv[++i]);
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--save') opts.save = argv[++i];
    else if (arg === '--wait-ms') opts.waitMs = Number(argv[++i]);
    else throw new Error(`faceLightCheck: unknown argument ${arg}`);
  }
  return opts;
}

/** The light at point p on a face looking along n, 0..1 for each channel, as the design says it should be. */
function lightAt(p, n, env, lamps) {
  const sunRatio = Math.min(Math.max(0, n[0] * env.sun[0] + n[1] * env.sun[1] + n[2] * env.sun[2]) / Math.max(env.sun[2], 0.25), 1.6);
  const sunTerm = env.intensity * (1 - env.sunDirect + env.sunDirect * sunRatio);
  const out = [0, 1, 2].map((i) => env.ambient + env.sunColor[i] * sunTerm);
  for (const lamp of lamps) {
    const lx = lamp.x - p[0];
    const ly = lamp.y - p[1];
    const lz = lamp.elevation - p[2];
    const d2 = lx * lx + ly * ly + lz * lz;
    const d = Math.sqrt(d2);
    const cosine = ((n[0] * lx + n[1] * ly + n[2] * lz) / d + env.wrap) / (1 + env.wrap);
    if (cosine <= 0) continue;
    const I = (lamp.radius * lamp.radius) / 100;
    const a = (env.gain * cosine * I) / (I + d2);
    for (let i = 0; i < 3; i++) out[i] += a;
  }
  return out.map((v) => Math.min(v, 1));
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const server = await createStaticBenchmarkServer(repoRoot);
  const browser = await chromium.launch({
    headless: opts.headless,
    channel: 'chrome',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const params = new URLSearchParams('src=1');
    for (const pair of opts.query) {
      const [key, value = ''] = pair.split('=');
      params.set(key, value);
    }
    const knob = (key, fallback) => (params.has(key) ? Number(params.get(key)) : fallback);
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(
      ({ waitMs, size }) =>
        window.__WEED_BENCHMARK__.prepare({
          warmupMs: waitMs,
          durationMs: 1000,
          sampleIntervalMs: 100,
          sceneModule: '/tests/bench/stressScenes/faceLightScene.js',
          sceneExport: 'FaceLightScene',
          canvasWidth: size.width,
          canvasHeight: size.height,
        }),
      { waitMs: opts.waitMs, size: VIEWPORT },
    );
    await page.waitForTimeout(opts.waitMs);
    const sun = await page.evaluate(async () => {
      const { default: WEED } = await import('/src/index.js');
      const S = WEED.Sun;
      return { intensity: S.intensity, elevation: S.elevation, dirX: S.shadowDirX, dirY: S.shadowDirY, color: S.color };
    });
    const png = await captureCanvasPng(page);
    if (opts.save) fs.writeFileSync(opts.save, png);
    const pixels = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return { width: bmp.width, height: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) };
    }, png.toString('base64'));

    const g = knob('groundScaleY', 0.5);
    const c = knob('heightScaleY', 0.866);
    const layout = faceLightLayout(g, c);
    const a = (sun.elevation * Math.PI) / 180;
    const dirY = sun.dirY / g;
    const dirLen = Math.sqrt(sun.dirX * sun.dirX + dirY * dirY) || 1;
    const env = {
      ambient: 0.1,
      intensity: sun.intensity,
      sunColor: [((sun.color >> 16) & 255) / 255, ((sun.color >> 8) & 255) / 255, (sun.color & 255) / 255],
      sun: [(-sun.dirX / dirLen) * Math.cos(a), (-dirY / dirLen) * Math.cos(a), Math.sin(a)],
      sunDirect: knob('sunDirect', 0.6),
      wrap: knob('wrap', 0),
      gain: knob('gain', 1),
    };
    let worstAll = 0;
    for (const f of layout.faces) {
      let worst = 0;
      let at = '';
      let read = 0;
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const u = (i + 1) / (GRID + 1);
          const v = (j + 1) / (GRID + 1);
          const p = [0, 1, 2].map((k) => f.origin[k] + f.edgeU[k] * u + f.edgeV[k] * v);
          const [sx, sy] = project(p, g, c);
          const px = Math.round(sx - 0.5);
          const py = Math.round(sy - 0.5);
          const o = (py * pixels.width + px) * 4;
          const want = lightAt(p, f.normal, env, layout.lamps);
          for (let ch = 0; ch < 3; ch++) {
            const delta = Math.abs(pixels.data[o + ch] - want[ch] * 255);
            if (delta > worst) {
              worst = delta;
              read = pixels.data[o + ch];
              at = `(${px}, ${py}) channel ${ch} read ${read} want ${(want[ch] * 255).toFixed(1)}`;
            }
          }
        }
      }
      console.log(`${f.name}: worst ${worst.toFixed(1)} ${at}`);
      if (worst > worstAll) worstAll = worst;
    }
    if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
    const ok = errors.length === 0 && worstAll <= opts.tolerance;
    console.log(`${ok ? 'PASS' : 'FAIL'} worst ${worstAll.toFixed(1)} of 255, sun ${sun.intensity.toFixed(3)} at ${sun.elevation.toFixed(1)} deg`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
