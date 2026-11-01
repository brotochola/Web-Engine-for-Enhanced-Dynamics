#!/usr/bin/env node
/**
 * DX-SW, SW-4. End to end in Chromium: a game served without COOP/COEP becomes cross-origin
 * isolated through weed-sw.js, and every way that can fail is named on the page.
 *
 *   node tests/bench/isolationWorkerSmoke.mjs [--headed] [--only first-visit,embedded] [--output report.json]
 *   node tests/bench/isolationWorkerSmoke.mjs --browser firefox [--headed]
 *
 * --browser firefox runs the first visit, the return visit and real headers in the Firefox installed here
 * (stockFirefox.mjs: the page takes the calls over HTTP; loads are counted from the line each document logs, and
 * "drawn" is the renderer's first published frame, since there are no screenshots).
 *
 * Servers: `plain` sends no isolation headers (GitHub Pages, `npx serve`) and serves the worker's
 * source at /weed-sw.js; `isolated` sends them (a host set up as DEPLOY.md says); `second` is
 * another origin without them, for the embedding case. The page is tests/bench/isolation/
 * isolationSmoke.html (the engine from source, orientedBoxScene). 'audio' also checks the engine's mixer and posts
 * a SharedArrayBuffer to a worklet. Each case gets a fresh browser
 * context, so no service worker carries over unless the case says so. Exit code 1 on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { analyzePng } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const headed = flag('--headed');
const only = value('--only') ? new Set(value('--only').split(',')) : null;
const output = value('--output');

const SMOKE = '/tests/bench/isolation/isolationSmoke.html';
const SW_FILES = { '/weed-sw.js': 'src/workers/isolationServiceWorker.js' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls a frame's window.__smoke until it leaves 'loading', across the gate's reload. */
async function settle(getFrame, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const frame = getFrame();
      const s = frame && (await frame.evaluate(() => window.__smoke && {
        state: window.__smoke.state, isolated: window.__smoke.isolated, error: window.__smoke.error,
      }));
      if (s && s.state !== 'loading') return s;
    } catch {
      // The gate's reload destroyed the context mid-evaluate.
    }
    await sleep(200);
  }
  return { state: 'timeout', isolated: null, error: null };
}

/** What the page shows and has registered, after it settled. */
async function inspect(frame) {
  return frame.evaluate(async () => ({
    isolated: self.crossOriginIsolated === true,
    overlay: document.getElementById('fatal-error-overlay')?.textContent || null,
    overlaySeen: window.__overlaySeen === true,
    registrations: navigator.serviceWorker
      ? (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active || r.waiting || r.installing)?.scriptURL || null)
      : null,
  }));
}

/**
 * Before the page is isolated (the first visit, until its reload), every frame: is the smoke page's
 * white UI on top at its centre (exposed), or under something (the engine's veil)? Hit testing
 * sees the top layer, and runs every frame, where a screenshot is too slow to catch a flash.
 */
const UI_WATCH = () => {
  if (self.crossOriginIsolated) return;
  const tick = () => {
    const ui = document.getElementById('smoke-ui');
    if (ui) {
      const r = ui.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === ui) window.__smokeUiExposed?.();
      else window.__smokeUiCovered?.();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** Notes an error overlay even if it shows and goes before the test looks. */
const OVERLAY_WATCH = () => {
  new MutationObserver(() => {
    if (document.getElementById('fatal-error-overlay')) window.__overlaySeen = true;
  }).observe(document, { childList: true, subtree: true });
};

async function newPage(browser, { initScript } = {}) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await context.addInitScript(OVERLAY_WATCH);
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Loads are navigation commits: a reload the gate makes before 'load' fires counts too. A log in
  // sessionStorage would not do: the isolated page's COOP gives it a copy of that storage.
  const loads = { n: 0, frame: 0 };
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) loads.n++;
    else if (f.parentFrame() === page.mainFrame() && f.url() !== 'about:blank') loads.frame++;
  });
  return { context, page, errors, loads };
}

/** Opens url in page and waits until the smoke page settles: loads, state, what it shows. */
async function visit(p, url, { reload } = {}) {
  p.loads.n = 0;
  if (reload) await reload();
  else await p.page.goto(url, { waitUntil: 'load' });
  const s = await settle(() => p.page.mainFrame());
  // The first frame can take a moment after the scene starts: look again for up to ~5 s.
  let nonBlack = 0;
  for (let tries = 0; tries < (s.state === 'running' ? 6 : 1); tries++) {
    if (s.state === 'running') await sleep(800);
    ({ nonBlack } = await analyzePng(p.page, await p.page.screenshot()));
    if (nonBlack > 0) break;
  }
  const seen = await inspect(p.page.mainFrame());
  return { ...s, ...seen, loads: p.loads.n, nonBlack, errors: [...p.errors] };
}

function expectRunning(r, loads, checks) {
  checks.push(['loads', r.loads === loads, `${r.loads} (want ${loads})`]);
  checks.push(['isolated', r.isolated === true, String(r.isolated)]);
  checks.push(['scene running', r.state === 'running', r.state + (r.error ? `: ${r.error}` : '')]);
  checks.push(['drawn', r.nonBlack > 0, `${r.nonBlack} non-black pixels`]);
  checks.push(['no overlay', !r.overlaySeen && !r.overlay, r.overlay || '']);
  checks.push(['no page errors', r.errors.length === 0, r.errors.slice(0, 2).join(' | ')]);
}

function expectReason(r, pattern, checks, maxLoads = 1) {
  checks.push(['loads', r.loads <= maxLoads, `${r.loads} (at most ${maxLoads})`]);
  checks.push(['not running', r.state === 'failed', r.state]);
  checks.push(['reason shown', !!r.overlay && pattern.test(r.overlay), (r.overlay || '(no overlay)').slice(0, 160)]);
}

const at = (server, query = '') => `http://127.0.0.1:${server.port}${SMOKE}${query}`;
const results = [];
async function runCase(name, fn) {
  if (only && !only.has(name)) return;
  const checks = [];
  const t0 = Date.now();
  try {
    await fn(checks);
  } catch (err) {
    checks.push(['ran', false, String(err && err.stack || err).split('\n').slice(0, 3).join(' ')]);
  }
  const ok = checks.length > 0 && checks.every(([, pass]) => pass);
  results.push({ name, ok, ms: Date.now() - t0, checks: checks.map(([what, pass, detail]) => ({ what, pass, detail })) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const [what, pass, detail] of checks) {
    if (!pass || !ok) console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${what}: ${detail}`);
  }
}

if (value('--browser') === 'firefox') {
  const { createStockFirefox, stockFirefoxExe } = await import('./stockFirefox.mjs');
  const { FRAME_CLOCK_SLOTS } = await import('../../src/util/frameClock.js');
  const { SLOT_BYTES } = await import('../../src/util/frameTotals.js');
  const stock = createStockFirefox();
  // Every server answers the driver's calls, so the one Firefox moves between origins in the page.
  const plainF = await createStaticBenchmarkServer(repoRoot, 0, { routes: stock.routes, isolationHeaders: false, files: SW_FILES });
  const isolatedF = await createStaticBenchmarkServer(repoRoot, 0, { routes: stock.routes, files: SW_FILES });
  const firefox = stock.launch(stockFirefoxExe(), { headed });
  const page = await firefox.newPage();
  const loads = [];
  const errors = [];
  page.on('console', (m) => {
    if (m.text().startsWith('[smoke] load')) loads.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  const framesIndex = (FRAME_CLOCK_SLOTS.renderer * SLOT_BYTES) / 8 + 1;
  // Short asks, again and again: a call the page took just before a reload (the first visit's) is never answered,
  // and the next one goes to the new document.
  // A navigation the test asks for waits 300 ms, so the answer leaves before the page does (a reload cancels it).
  const until = async (fn, arg, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      let v;
      try {
        v = await Promise.race([page.evaluate(fn, arg), sleep(3000).then(() => undefined)]);
      } catch {
        v = undefined;
      }
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`no answer from Firefox in ${timeoutMs} ms`);
  };
  const visitFirefox = async (navigate) => {
    loads.length = 0;
    errors.length = 0;
    await navigate();
    // The old document answers until the new one has loaded: wait for its line.
    for (const end = Date.now() + 60000; loads.length === 0 && Date.now() < end; ) await sleep(100);
    const s = await until(
      () => window.__smoke && window.__smoke.state !== 'loading' && { state: window.__smoke.state, error: window.__smoke.error },
      null,
      90000,
    );
    // The first frame can take a moment after the scene starts.
    const seen = await until(
      async (idx) => {
        const sab = window.__smoke.game?.currentScene?.buffers?.frameTotals;
        const frames = sab ? new Float64Array(sab)[idx] : 0;
        if (window.__smoke.state === 'running' && frames < 1) return false;
        return {
          frames,
          isolated: self.crossOriginIsolated === true,
          overlay: document.getElementById('fatal-error-overlay')?.textContent || null,
          registrations: navigator.serviceWorker
            ? (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active || r.waiting || r.installing)?.scriptURL || null)
            : null,
          ua: navigator.userAgent,
        };
      },
      framesIndex,
      30000,
    );
    return { ...s, ...seen, loads: loads.length, errors: [...errors] };
  };
  const expectFirefox = (r, want, registered, checks) => {
    checks.push(['loads', r.loads === want, `${r.loads} (want ${want})`]);
    checks.push(['isolated', r.isolated === true, String(r.isolated)]);
    checks.push(['scene running', r.state === 'running', r.state + (r.error ? `: ${r.error}` : '')]);
    checks.push(['drawn', r.frames >= 1, `${r.frames} renderer frames`]);
    checks.push(['no overlay', !r.overlay, r.overlay || '']);
    checks.push(['no page errors', r.errors.length === 0, r.errors.slice(0, 2).join(' | ')]);
    checks.push(['registrations', JSON.stringify(r.registrations) === JSON.stringify(registered), JSON.stringify(r.registrations)]);
  };
  try {
    const sw = [`http://127.0.0.1:${plainF.port}/weed-sw.js`];
    await runCase('firefox first-visit', async (checks) => {
      const r = await visitFirefox(() => page.goto(at(plainF)));
      console.log(`   ${r.ua}`);
      expectFirefox(r, 2, sw, checks);
    });
    await runCase('firefox return-visit', async (checks) => {
      expectFirefox(await visitFirefox(() => until(() => (setTimeout(() => location.reload(), 300), true), null, 10000)), 1, sw, checks);
    });
    await runCase('firefox real-headers', async (checks) => {
      const url = `${at(isolatedF)}?stockDriver=1`;
      expectFirefox(await visitFirefox(() => until((u) => (setTimeout(() => (location.href = u), 300), true), url, 10000)), 1, [], checks);
    });
  } finally {
    await firefox.close();
    await plainF.close();
    await isolatedF.close();
  }
  const failedF = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedF.length}/${results.length} passed`);
  if (output) fs.writeFileSync(output, JSON.stringify({ when: new Date().toISOString(), browser: 'firefox', results }, null, 2));
  process.exit(failedF.length ? 1 : 0);
}

const plain = await createStaticBenchmarkServer(repoRoot, 0, { isolationHeaders: false, files: SW_FILES });
const isolated = await createStaticBenchmarkServer(repoRoot, 0, { files: SW_FILES });
const second = await createStaticBenchmarkServer(repoRoot, 0, { isolationHeaders: false });
// No user gesture in a test: the autoplay policy would keep the audio context suspended.
const launchArgs = ['--autoplay-policy=no-user-gesture-required', ...(headed ? [] : ['--enable-unsafe-swiftshader'])];
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: launchArgs });

try {
  // One context through the first four: the visits a player makes.
  let player = null;
  await runCase('first-visit', async (checks) => {
    player = await newPage(browser);
    // Until the reload, the UI the page draws must stay under the engine's black veil.
    const frames = { exposed: 0, covered: 0 };
    await player.page.exposeFunction('__smokeUiExposed', () => frames.exposed++);
    await player.page.exposeFunction('__smokeUiCovered', () => frames.covered++);
    await player.context.addInitScript(UI_WATCH);
    const r = await visit(player, at(plain));
    expectRunning(r, 2, checks);
    checks.push(['UI hidden before the reload', frames.covered > 0 && frames.exposed === 0,
      `${frames.covered} frames covered, ${frames.exposed} exposed`]);
    checks.push(['registered', JSON.stringify(r.registrations) === JSON.stringify([`http://127.0.0.1:${plain.port}/weed-sw.js`]), JSON.stringify(r.registrations)]);
  });
  await runCase('return-visit', async (checks) => {
    player ??= await newPage(browser);
    if (!player.page.url().includes(SMOKE)) await visit(player, at(plain));
    expectRunning(await visit(player, at(plain)), 1, checks);
  });
  await runCase('hard-reload', async (checks) => {
    player ??= await newPage(browser);
    if (!player.page.url().includes(SMOKE)) await visit(player, at(plain));
    const cdp = await player.context.newCDPSession(player.page);
    const r = await visit(player, null, { reload: () => cdp.send('Page.reload', { ignoreCache: true }) });
    expectRunning(r, 2, checks);
  });
  await runCase('worker-stopped', async (checks) => {
    player ??= await newPage(browser);
    if (!player.page.url().includes(SMOKE)) await visit(player, at(plain));
    const cdp = await player.context.newCDPSession(player.page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    expectRunning(await visit(player, at(plain)), 1, checks);
  });
  if (player) await player.context.close();

  await runCase('real-headers', async (checks) => {
    const p = await newPage(browser);
    const r = await visit(p, at(isolated));
    expectRunning(r, 1, checks);
    checks.push(['nothing registered', JSON.stringify(r.registrations) === '[]', JSON.stringify(r.registrations)]);
    await p.context.close();
  });

  await runCase('worker-404', async (checks) => {
    const p = await newPage(browser);
    expectReason(await visit(p, at(plain, '?sw=/missing-weed-sw.js')), /could not be installed/, checks);
    await p.context.close();
  });

  await runCase('no-service-workers', async (checks) => {
    const p = await newPage(browser, {
      initScript: () => Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined, configurable: true }),
    });
    expectReason(await visit(p, at(plain)), /normal browser window/, checks);
    await p.context.close();
  });

  await runCase('other-worker', async (checks) => {
    const p = await newPage(browser);
    // The game's own offline worker, registered first over the page's folder.
    await p.page.goto(`http://127.0.0.1:${plain.port}/tests/bench/isolation/frame.html`);
    await p.page.evaluate(async () => {
      const reg = await navigator.serviceWorker.register('/tests/bench/isolation/noopServiceWorker.js', { scope: '/tests/bench/isolation/' });
      const w = reg.installing || reg.waiting || reg.active;
      if (w.state !== 'activated') await new Promise((r) => w.addEventListener('statechange', () => w.state === 'activated' && r()));
    });
    const r = await visit(p, at(plain));
    expectReason(r, /Another service worker \(.*noopServiceWorker\.js\)/, checks);
    checks.push(['not replaced', JSON.stringify(r.registrations) === JSON.stringify([`http://127.0.0.1:${plain.port}/tests/bench/isolation/noopServiceWorker.js`]), JSON.stringify(r.registrations)]);
    await p.context.close();
  });

  await runCase('embedded', async (checks) => {
    const p = await newPage(browser);
    await p.page.goto(`http://127.0.0.1:${second.port}/tests/bench/isolation/frame.html?src=${encodeURIComponent(at(plain))}`);
    const frame = () => p.page.mainFrame().childFrames()[0]; // the parent's own URL names the game too
    const s = await settle(frame);
    const seen = await inspect(frame());
    expectReason({ ...s, ...seen, loads: p.loads.frame }, /embedded in a page/, checks, 2);
    await p.context.close();
  });

  await runCase('audio', async (checks) => {
    // Isolated through the worker (a first visit), the engine's mixer is up, and a worklet loaded by URL as the
    // mixer is gets a SharedArrayBuffer posted to it (tests/bench/isolation/sabProbeProcessor.js).
    const p = await newPage(browser);
    const r = await visit(p, at(plain));
    expectRunning(r, 2, checks);
    const audio = await p.page.evaluate(async () => {
      const SM = window.__smoke.game && (await import('/src/index.js')).default.SoundManager;
      const engine = { node: !!SM?._workletNode, sab: !!SM?._sab, state: SM?._audioCtx?.state ?? null };
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule('/tests/bench/isolation/sabProbeProcessor.js');
      const node = new AudioWorkletNode(ctx, 'weed-sab-probe');
      const sab = new SharedArrayBuffer(4);
      new Int32Array(sab)[0] = 42;
      const reply = await new Promise((resolve) => {
        node.port.onmessage = (e) => resolve(e.data);
        node.port.postMessage(sab);
        setTimeout(() => resolve({ timeout: true }), 5000);
      });
      await ctx.close();
      return { engine, reply };
    });
    checks.push(['engine mixer node', audio.engine.node && audio.engine.sab, JSON.stringify(audio.engine)]);
    checks.push(['worklet got the SharedArrayBuffer', audio.reply.shared === true && audio.reply.value === 42, JSON.stringify(audio.reply)]);
    await p.context.close();
  });

  await runCase('allowed-frame', async (checks) => {
    // An isolated portal (real headers) embedding the game from a host without them, isolation allowed: a known limit.
    // The portal's COEP refuses a cross-origin document whose response lacks CORP and COEP, and that first response
    // comes before weed-sw.js can be installed there (nor would a worker from a direct visit reach a third-party frame).
    const p = await newPage(browser);
    const blocked = [];
    p.page.on('requestfailed', (r) => {
      if (r.url().includes(SMOKE)) blocked.push(r.failure()?.errorText || '');
    });
    const src = encodeURIComponent(at(plain));
    await p.page.goto(`http://127.0.0.1:${isolated.port}/tests/bench/isolation/frame.html?allow=cross-origin-isolated&src=${src}`);
    await sleep(3000);
    checks.push(['the frame is refused (a known limit)', blocked.some((e) => /BLOCKED_BY_RESPONSE/.test(e)), JSON.stringify(blocked)]);
    await p.context.close();
  });

  await runCase('folder-rule', async (checks) => {
    // Next to the page, src mode: the page is covered, the workers in /src/workers/ are not.
    const p = await newPage(browser);
    const r = await visit(p, at(plain, `?sw=${encodeURIComponent('/tests/bench/isolation/weed-sw.js')}`));
    checks.push(['scene does not run', r.state !== 'running', `${r.state}${r.error ? `: ${r.error.slice(0, 120)}` : ''}`]);
    await p.context.close();
  });
} finally {
  await browser.close();
}

await runCase('plain-http', async (checks) => {
  const httpBrowser = await chromium.launch({
    channel: 'chrome', headless: !headed, args: [...launchArgs, '--host-resolver-rules=MAP game.test 127.0.0.1'],
  });
  try {
    const p = await newPage(httpBrowser);
    expectReason(await visit(p, `http://game.test:${plain.port}${SMOKE}`), /plain HTTP/, checks);
  } finally {
    await httpBrowser.close();
  }
});

await plain.close();
await isolated.close();
await second.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (output) fs.writeFileSync(output, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
process.exitCode = failed.length ? 1 : 0;
