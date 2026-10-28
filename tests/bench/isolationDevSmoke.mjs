#!/usr/bin/env node
/**
 * DX-SW phase 2, the `npm run dev` rows: hot reload with the dev server (server/node_server.js), and with a weed-sw.js
 * left registered on its port by an earlier `npm run dev:sw` there.
 *
 *   node tests/bench/isolationDevSmoke.mjs [--headed]
 *
 * The page is demos/index.html?scene=orientedBoxScene (debug on: hot reload needs it). For each server:
 *   script  a script of the running scene is written again (the same bytes, a new modification time): the page says
 *           "hot swapped", nothing navigates, and (plain dev server) no service worker is registered;
 *   asset   a texture the scene loads is written again the same way: one reload, the scene running after it, no
 *           warning that its state was lost.
 * "leftover" first serves the port with --sw (the engine registers weed-sw.js there), then with the plain dev server,
 * and runs both checks again: the worker still controls the page, and the reload stream still reaches it.
 * Files are rewritten with their own bytes, so the working tree does not change. Exit code 1 on any failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const headed = process.argv.includes('--headed');
// Hot reload runs with the debug build's UI (GameEngine), so debug stays on.
const PAGE = '/demos/index.html?scene=orientedBoxScene';
const SCRIPT = 'demos/orientedBoxScene/gameObjects/orientedBox.js';
const ASSET = 'demos/img/box_100_100.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The dev server on `port` (--sw when `sw`), up when it answers. */
async function startDevServer(port, sw) {
  const child = spawn(process.execPath, ['server/node_server.js', ...(sw ? ['--sw'] : [])], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  for (let k = 0; k < 100; k++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/demos/index.html`);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`the dev server did not answer on ${port}`);
}

async function stopDevServer(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}

/** Writes a file again with its own bytes: the watcher sees a new modification time, git sees nothing. */
function touch(rel) {
  const file = path.join(repoRoot, rel);
  fs.writeFileSync(file, fs.readFileSync(file));
}

async function running(page, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const ok = await page.evaluate(() => {
        const scene = window.game && window.game.currentScene;
        return !!(scene && scene.buffers && scene.buffers.frameTotals);
      });
      if (ok) return true;
    } catch {
      // a reload replaced the document
    }
    await sleep(200);
  }
  return false;
}

const results = [];
function report(name, checks) {
  const ok = checks.every(([, pass]) => pass);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  for (const [what, pass, detail] of checks) if (!pass || !ok) console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${what}: ${detail}`);
}

/** The two checks on an open page; `registered` is what getRegistrations() must list. */
async function hotChecks(label, page, nav, logs, registered) {
  // A script of the running scene: swapped in place.
  logs.length = 0;
  nav.count = 0;
  touch(SCRIPT);
  let swapped = false;
  for (let k = 0; k < 50 && !swapped; k++) {
    await sleep(200);
    swapped = logs.some((l) => l.includes('hot swapped'));
  }
  const regs = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active || r.waiting || r.installing)?.scriptURL || null),
  );
  report(`${label} script`, [
    ['hot swapped', swapped, logs.filter((l) => l.includes('WeedJS')).slice(-2).join(' | ') || '(nothing)'],
    ['no navigation', nav.count === 0, `${nav.count} navigations`],
    ['registrations', JSON.stringify(regs.map((u) => u && new URL(u).pathname)) === JSON.stringify(registered), JSON.stringify(regs)],
  ]);

  // An asset: a reload that keeps the scene.
  logs.length = 0;
  nav.count = 0;
  touch(ASSET);
  for (let k = 0; k < 50 && nav.count === 0; k++) await sleep(200);
  const back = await running(page);
  report(`${label} asset`, [
    ['one reload', nav.count === 1, `${nav.count} navigations`],
    // A restore that fails says so (hotReload.js: 'starting the scene fresh', 'could not save the scene').
    ['state kept', !logs.some((l) => /scene fresh|could not save the scene|without its state/.test(l)), logs.filter((l) => l.includes('WeedJS')).slice(-2).join(' | ') || '(no warning)'],
    ['scene running after it', back, String(back)],
  ]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: headed ? [] : ['--enable-unsafe-swiftshader'] });
let server = null;
try {
  for (const leftover of [false, true]) {
    const port = await freePort();
    const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await context.newPage();
    const logs = [];
    const nav = { count: 0 };
    page.on('console', (m) => logs.push(m.text()));
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) nav.count++;
    });
    const url = `http://127.0.0.1:${port}${PAGE}`;
    if (leftover) {
      // An earlier `npm run dev:sw` on this port: the engine registers weed-sw.js (the first visit reloads once).
      server = await startDevServer(port, true);
      await page.goto(url);
      if (!(await running(page, 45000))) throw new Error('the scene did not start under npm run dev:sw');
      await stopDevServer(server);
    }
    server = await startDevServer(port, false);
    await page.goto(url);
    if (!(await running(page))) throw new Error('the scene did not start under npm run dev');
    await sleep(1500); // the reload stream opens after the scene starts
    await hotChecks(leftover ? 'leftover weed-sw.js' : 'npm run dev', page, nav, logs, leftover ? ['/weed-sw.js'] : []);
    await stopDevServer(server);
    server = null;
    await context.close();
  }
} finally {
  await stopDevServer(server);
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
