/**
 * DX-POST's identity check: a LAYER_KIND.SCREEN pass that copies must leave the frame exactly as the stage draws it.
 * screenPassStressScene (Bunny Mark C) in lockstep (the same steps, so the same poses: the transform hash is compared
 * too), on WebGL and WebGPU: no pass, one copy (`?post=1&amount=0`), two copies chained (`?post=2&amount=0`). Every
 * capture with a pass must differ from the one without in 0 pixels. A vignette (`amount=0.6`) must differ, so the
 * passes are known to run; a vignette then a pass that returns uScene (`last=scene`) must not: uScene is the frame
 * before the first pass.
 *
 *   node tests/bench/screenIdentityCheck.mjs [--headless] [--backend webgl|webgpu] [--bunnies 3000] [--steps 30]
 *
 * Headed by default: WebGPU needs the GPU. Exit 1 when a copy is not exact.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const headless = process.argv.includes('--headless');
const backends = arg('backend', '') ? [arg('backend', '')] : ['webgl', 'webgpu'];
const bunnies = arg('bunnies', '3000');
const steps = arg('steps', '30');

function url(port, backend, post, amount, last = '') {
  const q = new URLSearchParams({
    scene: 'screenPass',
    module: '/tests/bench/stressScenes/screenPassStressScene.js',
    export: 'ScreenPassStressScene',
    steps,
    dt: '16.67',
    minActive: '1',
    minLiquidFun: '0',
    minParticles: '0',
    zoom: '1',
    auto: '0',
    post: String(post),
    amount: String(amount),
    backend,
    bunnies,
    ...(last ? { last } : {}),
  });
  return `http://127.0.0.1:${port}/tests/bench/lockstepVisual.html?${q}`;
}

async function capture(browser, href) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => Boolean(window.__weedLockstep?.ready), undefined, { timeout: 120000 });
    const snap = await page.evaluate(() => window.__weedLockstep.run());
    const png = await captureCanvasPng(page);
    return { snap, png, errors, page };
  } catch (err) {
    await page.close();
    throw new Error(`${href}: ${err.message}${errors.length ? `\n  ${errors.slice(0, 6).join('\n  ')}` : ''}`);
  }
}

const server = await createStaticBenchmarkServer(repoRoot, 0, {});
const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
let browser;
try {
  browser = await chromium.launch({ headless, channel: 'chrome', args });
} catch {
  browser = await chromium.launch({ headless, args });
}
let failed = false;
const outDir = path.join(repoRoot, 'tests', 'results', 'screen-identity');
try {
  for (const backend of backends) {
    const base = await capture(browser, url(server.port, backend, 0, 0));
    for (const [post, amount, expect, last] of [[1, 0, 'exact'], [2, 0, 'exact'], [1, 0.6, 'differs'], [2, 0.6, 'exact', 'scene']]) {
      const run = await capture(browser, url(server.port, backend, post, amount, last));
      const diff = await diffPngs(run.page, base.png, run.png);
      await run.page.close();
      const sameState = run.snap?.transforms?.hash === base.snap?.transforms?.hash;
      const ok = expect === 'exact' ? sameState && diff.sameSize !== false && diff.differing === 0 : diff.differing > 0;
      console.log(
        `${backend} post=${post} amount=${amount}${last ? ` last=${last}` : ''}: ${diff.differing} of ${diff.pixels} pixels differ (max delta ${diff.maxDelta}), ` +
          `poses ${sameState ? 'equal' : 'DIFFER'} → ${ok ? 'OK' : 'FAIL'} (${expect})`,
      );
      if (!ok) {
        failed = true;
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(path.join(outDir, `${backend}-base.png`), base.png);
        await fs.writeFile(path.join(outDir, `${backend}-post${post}-amount${amount}${last ? `-${last}` : ''}.png`), run.png);
      }
    }
    await base.page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) {
  console.log(`captures kept in ${outDir}`);
  process.exit(1);
}
console.log('screen identity OK');
