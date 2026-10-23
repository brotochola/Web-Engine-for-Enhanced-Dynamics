#!/usr/bin/env node
/**
 * Run a kernel module in Chrome (E-76). Node's V8 is not Chrome's (12.4 against 15.5 on
 * 2026-10-22): a spatial kernel that tied in Node differed by 19 % in Chrome, and Math.sin may not
 * even be the same function. A WASM-vs-JS kernel verdict, or a Math.* question, is confirmed in the
 * engine that runs the game.
 *
 * The module is a browser-safe ES module (no node: imports) served from `--root` (default: this
 * repo) that exports `run(args)` and returns something JSON can hold. This script serves the root
 * with COOP/COEP (SharedArrayBuffer and shared WebAssembly.Memory work), opens a blank page in
 * headless Chrome with the bench's flags, imports the module, calls `run`, prints the result and
 * the browser version.
 *
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/chrome/x.mjs [--args '{"n":1}'] [--output path]
 *   node tests/bench/chromeKernel.mjs --root D:/tmp/scratch --module /q2Chrome.mjs
 *   --js-flags=--allow-natives-syntax   lets the module check tiers (%IsTurboFanFunction); like the
 *                                       bench, a run with V8 flags uses Playwright's Chromium
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (typeof args.module !== 'string') throw new Error('usage: chromeKernel.mjs --module /path/served/module.mjs [--args json]');
  const root = path.resolve(typeof args.root === 'string' ? args.root : repoRoot);
  const jsFlags = typeof args['js-flags'] === 'string' ? args['js-flags'] : null;
  const runArgs = typeof args.args === 'string' ? JSON.parse(args.args) : {};
  const timeoutMs = Number(args['timeout-ms'] ?? 600000);

  const server = await createStaticBenchmarkServer(root);
  // The bench's flags, so a background tab is not throttled.
  const launchArgs = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  if (os.platform() === 'win32') launchArgs.push('--disable-features=CalculateNativeWinOcclusion');
  if (jsFlags) launchArgs.push(`--js-flags=${jsFlags}`);
  let browser;
  let channel = jsFlags ? 'chromium' : 'chrome';
  try {
    browser = await chromium.launch({ headless: true, args: launchArgs, ...(jsFlags ? {} : { channel: 'chrome' }) });
  } catch {
    channel = 'chromium';
    browser = await chromium.launch({ headless: true, args: launchArgs });
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on('console', (msg) => console.log(`[page ${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.error('[page error]', err));
    // The module's own URL is the page (any served file carries COOP/COEP; a 404 does not), then
    // the module is imported into it.
    const moduleUrl = `http://127.0.0.1:${server.port}${args.module.startsWith('/') ? '' : '/'}${args.module}`;
    await page.goto(moduleUrl, { waitUntil: 'domcontentloaded' });
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
    if (!isolated) throw new Error('the page is not cross-origin isolated (COOP/COEP missing)');
    const result = await page.evaluate(
      async ({ url, a }) => {
        const m = await import(url);
        return m.run(a);
      },
      { url: moduleUrl, a: runArgs },
    );
    const report = { module: args.module, browser: `${channel} ${browser.version()}`, jsFlags, args: runArgs, result };
    console.log(JSON.stringify(report, null, 2));
    if (typeof args.output === 'string') {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(path.resolve(args.output), JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2) + '\n');
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
