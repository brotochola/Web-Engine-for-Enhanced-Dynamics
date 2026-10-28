#!/usr/bin/env node
/**
 * DX-SW, phase 2's bundle rows. Every bundle in dist/ through weed-sw.js, as a deploy without COOP/COEP serves it:
 * dist/index.html?bundle=<file> (BallsScene, Box2D on four threads) with dist/weed-sw.js next to it.
 *
 *   node tests/bench/isolationBundleSmoke.mjs [--headed] [--only weed.bundle.min.js,...] [--output report.json]
 *
 * Per bundle: a first visit on a server without the headers (two loads: register, activate, reload), a return visit
 * in the same context (one load), a hard reload (it bypasses the worker, so two loads again), and a first visit on a
 * server that sends the headers (one load, no worker registered). Each must end cross-origin isolated with the scene
 * running: physics and the renderer publishing frames (__weedVisual, the page's own counters), entities active,
 * something drawn, no page error and no error overlay. It tests what dist/ holds: build it first (npm run make_bundle,
 * npm run check:dist says whether it matches the sources). Exit code 1 on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { analyzePng } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const headed = argv.includes('--headed');
const output = value('--output');
const BUNDLES = [
  'weed.bundle.min.js',
  'weed.bundle.esm.min.js',
  'weed.prod.bundle.min.js',
  'weed.prod.bundle.esm.min.js',
  'weed.bundle.compressed.min.js',
  'weed.bundle.esm.compressed.min.js',
  'weed.prod.bundle.compressed.min.js',
  'weed.prod.bundle.esm.compressed.min.js',
];
const only = value('--only') ? value('--only').split(',') : BUNDLES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls the page until physics and the renderer have each published a few frames, or an error shows. */
async function settle(page, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const s = await page.evaluate(() => ({
        physicsFrame: window.__weedVisual?.physicsFrame ?? 0,
        pixiFrame: window.__weedVisual?.pixiFrame ?? 0,
        activeEntities: window.__weedVisual?.activeEntities ?? 0,
        overlay: document.getElementById('fatal-error-overlay')?.textContent?.slice(0, 200) || null,
      }));
      if (s.overlay || (s.physicsFrame >= 10 && s.pixiFrame >= 10)) return s;
    } catch {
      // The first visit's reload replaced the document mid-evaluate.
    }
    await sleep(200);
  }
  return { physicsFrame: 0, pixiFrame: 0, activeEntities: 0, overlay: 'timeout' };
}

async function newPlayer(browser) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const loads = { n: 0 };
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) loads.n++;
  });
  return { context, page, errors, loads };
}

async function visit(p, navigate) {
  p.loads.n = 0;
  p.errors.length = 0;
  await navigate();
  const s = await settle(p.page);
  const seen = await p.page.evaluate(async () => ({
    isolated: self.crossOriginIsolated === true,
    registrations: navigator.serviceWorker
      ? (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active || r.waiting || r.installing)?.scriptURL || null)
      : null,
  }));
  const { nonBlack } = await analyzePng(p.page, await p.page.screenshot());
  return { ...s, ...seen, nonBlack, loads: p.loads.n, errors: [...p.errors] };
}

function expectRunning(r, loads, checks, registered) {
  checks.push(['loads', r.loads === loads, `${r.loads} (want ${loads})`]);
  checks.push(['isolated', r.isolated, String(r.isolated)]);
  checks.push(['physics stepping', r.physicsFrame >= 10, `${r.physicsFrame} frames`]);
  checks.push(['renderer drawing', r.pixiFrame >= 10, `${r.pixiFrame} frames`]);
  checks.push(['entities active', r.activeEntities > 0, String(r.activeEntities)]);
  checks.push(['drawn', r.nonBlack > 0, `${r.nonBlack} non-black pixels`]);
  checks.push(['no overlay', !r.overlay, r.overlay || '']);
  checks.push(['no page errors', r.errors.length === 0, r.errors.slice(0, 2).join(' | ')]);
  checks.push(['registrations', JSON.stringify(r.registrations) === JSON.stringify(registered), JSON.stringify(r.registrations)]);
}

const plain = await createStaticBenchmarkServer(repoRoot, 0, { isolationHeaders: false });
const isolated = await createStaticBenchmarkServer(repoRoot, 0);
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: headed ? [] : ['--enable-unsafe-swiftshader'] });
const results = [];
async function runCase(name, fn) {
  const checks = [];
  const t0 = Date.now();
  try {
    await fn(checks);
  } catch (err) {
    checks.push(['ran', false, String((err && err.stack) || err).split('\n').slice(0, 3).join(' ')]);
  }
  const ok = checks.length > 0 && checks.every(([, pass]) => pass);
  results.push({ name, ok, ms: Date.now() - t0, checks: checks.map(([what, pass, detail]) => ({ what, pass, detail })) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const [what, pass, detail] of checks) if (!pass) console.log(`   FAIL ${what}: ${detail}`);
}

try {
  for (const bundle of only) {
    const page = `/dist/index.html?bundle=${bundle}&balls=200`;
    const sw = [`http://127.0.0.1:${plain.port}/dist/weed-sw.js`];
    const player = await newPlayer(browser);
    await runCase(`${bundle} first-visit`, async (checks) => {
      expectRunning(await visit(player, () => player.page.goto(`http://127.0.0.1:${plain.port}${page}`)), 2, checks, sw);
    });
    await runCase(`${bundle} return-visit`, async (checks) => {
      expectRunning(await visit(player, () => player.page.goto(`http://127.0.0.1:${plain.port}${page}`)), 1, checks, sw);
    });
    await runCase(`${bundle} hard-reload`, async (checks) => {
      const cdp = await player.context.newCDPSession(player.page);
      expectRunning(await visit(player, () => cdp.send('Page.reload', { ignoreCache: true })), 2, checks, sw);
    });
    await player.context.close();
    await runCase(`${bundle} real-headers`, async (checks) => {
      const p = await newPlayer(browser);
      expectRunning(await visit(p, () => p.page.goto(`http://127.0.0.1:${isolated.port}${page}`)), 1, checks, []);
      await p.context.close();
    });
  }
} finally {
  await browser.close();
  await plain.close();
  await isolated.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (output) fs.writeFileSync(output, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
process.exitCode = failed.length ? 1 : 0;
