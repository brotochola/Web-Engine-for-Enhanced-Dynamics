import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { BUNDLE_ARTIFACTS } from './buildBundle.js';
import { createStaticBenchmarkServer } from '../tests/helpers/createStaticBenchmarkServer.mjs';
import { analyzePng, captureCanvasPng } from '../tests/helpers/visualPngCompare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const missing = BUNDLE_ARTIFACTS.filter((name) => !fs.existsSync(path.join(dist, name)));
if (missing.length) {
  console.error(
    `Missing dist artifacts: ${missing.join(', ')}. Run pnpm make_bundle (or test:bundle:build).`,
  );
  process.exit(1);
}

const server = await createStaticBenchmarkServer(root);
const browser = await chromium.launch({ headless: true });
let failed = false;

try {
  for (const bundle of BUNDLE_ARTIFACTS) {
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    // npm installs ship dist/ only: a bundle must not reach into /src/ (this server has it, a game's would not).
    const srcRequests = [];
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/src/')) srcRequests.push(p);
    });

    const url = `http://127.0.0.1:${server.port}/dist/index.html?bundle=${encodeURIComponent(bundle)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const result = await page.waitForFunction(() => {
      const info = document.getElementById('info');
      const text = info ? info.textContent || '' : '';
      if (/error|fail/i.test(text) && !/Loading/i.test(text)) return { ok: false, text };
      if (/ready|running|balls|spawn|fps/i.test(text)) return { ok: true, text };
      return null;
    }, { timeout: 90000 }).then((h) => h.jsonValue()).catch(async () => {
      const text = await page.locator('#info').textContent().catch(() => '');
      return { ok: false, text: text || 'timeout' };
    });

    let canvasBlack = false;
    if (result?.ok) {
      const visualReady = await page.waitForFunction(
        () => Boolean(window.__weedVisual?.ready),
        undefined,
        { timeout: 90000 },
      ).then(() => true).catch(() => false);
      if (!visualReady) {
        result.ok = false;
        result.text = `${result.text || ''} (workers never ready)`;
      } else {
        await page.locator('#info').evaluate((el) => {
          el.style.display = 'none';
        }).catch(() => {});
        const png = await captureCanvasPng(page);
        const analysis = await analyzePng(page, png);
        console.log(`  canvas: nonBlack=${analysis.nonBlack}/${analysis.pixels} max=${analysis.maxChannel}`);
        if (analysis.nonBlack < 100) {
          canvasBlack = true;
        }
      }
    }

    // ESM bundles: named imports work and are the same objects as WEED.X.
    if (result?.ok && bundle.includes('.esm.')) {
      const bad = await page.evaluate(async (file) => {
        const mod = await import(`/dist/${file}`);
        const names = ['Scene', 'GameEngine', 'GameObject', 'RigidBody', 'Collider', 'Tween', 'Camera', 'Keyboard'];
        return names.filter((n) => typeof mod[n] !== 'function' || mod[n] !== mod.default[n]);
      }, bundle).catch((e) => [`import failed: ${e.message}`]);
      if (bad.length) {
        result.ok = false;
        result.text = `${result.text || ''} (named exports missing or not WEED.X: ${bad.join(', ')})`;
      } else {
        console.log('  named exports OK');
      }
    }

    await page.close();

    if (srcRequests.length && result) {
      result.ok = false;
      result.text = `${result.text || ''} (fetched ${srcRequests.length} file(s) from /src/, e.g. ${srcRequests[0]})`;
    }

    const fatal = errors.filter((e) =>
      /importScripts|worker_common|Failed to fetch|DecompressionStream|WebAssembly|wasm unavailable|invalid URL/i.test(e),
    );

    console.log(`${bundle}:`, result);
    if (fatal.length) {
      console.log('  fatal errors:');
      for (const e of fatal.slice(0, 8)) console.log('   ', e);
    }

    if (!result?.ok || fatal.length || canvasBlack) {
      failed = true;
      if (canvasBlack) console.log('  FAIL: canvas all-black');
      if (errors.length && !fatal.length) {
        console.log('  page errors:');
        for (const e of errors.slice(0, 8)) console.log('   ', e);
      }
    } else {
      console.log('  OK');
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (failed) {
  console.error('bundle browser smoke failed');
  process.exitCode = 1;
} else {
  console.log('smoke-bundle-browser OK (all 8)');
}
