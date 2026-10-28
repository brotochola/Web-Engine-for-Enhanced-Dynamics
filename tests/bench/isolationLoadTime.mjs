#!/usr/bin/env node
/**
 * DX-SW phase 3, load time. How long a player waits for the first frame when the page is isolated by real headers,
 * and when weed-sw.js isolates it: on the first visit (register, activate, reload once) and on a return visit (the
 * worker already in place). Each with the worker as it ships (narrow: it adds the headers to page loads and worker
 * scripts only) and with tests/bench/isolation/weedSwWide.js (every response, as coi-serviceworker does), the
 * comparison ISOLATION_SERVICE_WORKER_PLAN's phase 3 asks for.
 *
 *   node tests/bench/isolationLoadTime.mjs [--runs 10] [--mode bundle,src] [--headless] [--output report.json]
 *
 * Modes:
 *   bundle  dist/index.html (the bundle's own page, BallsScene with ?balls=300) with weed-sw.js next to it, as a
 *           deploy serves it. Workers are blob URLs there. It measures the bundle in dist/, which is the last one
 *           built: the isolation gate and the worker are the same in it as in src/ when the two files are.
 *   src     tests/bench/isolation/isolationSmoke.html (orientedBoxScene, the engine from source: hundreds of module
 *           requests, every one a fetch event for a worker that controls the page) with weed-sw.js at the root.
 *
 * Servers: `headers` sends COOP/COEP (DEPLOY.md's setup); `narrow` and `wide` send neither and serve their worker
 * where the page looks for it. Each run takes, for every mode and server in a rotating order, a fresh browser
 * context and makes two visits: the first, then a return visit to the same URL. A visit is timed from just before
 * the navigation to the renderer's first published frame (frameTotals, read by the page on every animation frame),
 * on the same wall clock. Headed by default: the first frame needs the real GPU.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { FRAME_CLOCK_SLOTS } from '../../src/util/frameClock.js';
import { SLOT_BYTES } from '../../src/util/frameTotals.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const runs = Number(value('--runs', 10));
const modes = String(value('--mode', 'bundle,src')).split(',');
const headed = !argv.includes('--headless');
const output = value('--output', null);

const MODES = {
  bundle: { page: '/dist/index.html?balls=300', sw: '/dist/weed-sw.js' },
  src: { page: '/tests/bench/isolation/isolationSmoke.html', sw: '/weed-sw.js' },
};
const WORKER_FILES = {
  narrow: 'src/workers/isolationServiceWorker.js',
  wide: 'tests/bench/isolation/weedSwWide.js',
};
/** frameTotals' `frames` (f64) for the renderer's slot: the first frame drawn is the first it counts. */
const RENDERER_FRAMES_F64 = (FRAME_CLOCK_SLOTS.renderer * SLOT_BYTES) / 8 + 1;
const VISIT_TIMEOUT_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In every document: the wall-clock time of the renderer's first frame, in window.__firstFrameAt. */
const FIRST_FRAME_WATCH = (framesIndex) => {
  const look = () => {
    const game = window.game || (window.__smoke && window.__smoke.game);
    const sab = game && game.currentScene && game.currentScene.buffers && game.currentScene.buffers.frameTotals;
    if (sab && new Float64Array(sab)[framesIndex] >= 1) {
      window.__firstFrameAt = Date.now();
      return;
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
};

const servers = {
  headers: await createStaticBenchmarkServer(repoRoot, 0),
  narrow: await createStaticBenchmarkServer(repoRoot, 0, {
    isolationHeaders: false,
    files: { '/weed-sw.js': WORKER_FILES.narrow, '/dist/weed-sw.js': WORKER_FILES.narrow },
  }),
  wide: await createStaticBenchmarkServer(repoRoot, 0, {
    isolationHeaders: false,
    files: { '/weed-sw.js': WORKER_FILES.wide, '/dist/weed-sw.js': WORKER_FILES.wide },
  }),
};
const launchArgs = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  ...(headed ? [] : ['--enable-unsafe-swiftshader']),
];
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: launchArgs });

/** One navigation to url, timed to the first frame; `loads` counts the main frame's commits (the reload too). */
async function visit(page, url, nav) {
  nav.commits = [];
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  let at = null;
  while (Date.now() - t0 < VISIT_TIMEOUT_MS) {
    try {
      at = await page.evaluate(() => window.__firstFrameAt ?? null);
    } catch {
      // The first visit's reload replaced the document mid-evaluate.
    }
    if (at !== null) break;
    await sleep(50);
  }
  const state = await page.evaluate(() => ({
    isolated: self.crossOriginIsolated === true,
    controller: navigator.serviceWorker?.controller?.scriptURL || null,
    error: document.getElementById('fatal-error-overlay')?.textContent?.slice(0, 160) || null,
  }));
  return {
    ms: at === null ? null : at - t0,
    loads: nav.commits.length,
    reloadMs: nav.commits.length > 1 ? nav.commits[1] - t0 : null,
    ...state,
  };
}

const samples = [];
try {
  // Not recorded: the session's first visit pays for starting the GPU process and compiling the shaders (4.7 s
  // against 0.5 in a trial), which the rotation would hand to whichever server came first.
  for (const mode of modes) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await context.addInitScript(FIRST_FRAME_WATCH, RENDERER_FRAMES_F64);
    const page = await context.newPage();
    const w = await visit(page, `http://127.0.0.1:${servers.headers.port}${MODES[mode].page}`, { commits: [] });
    console.log(`warm-up ${mode}: ${w.ms} ms (not counted)`);
    await context.close();
  }
  const order = ['headers', 'narrow', 'wide'];
  for (let r = 0; r < runs; r++) {
    for (const mode of modes) {
      const rotated = order.slice(r % order.length).concat(order.slice(0, r % order.length));
      for (const server of rotated) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        await context.addInitScript(FIRST_FRAME_WATCH, RENDERER_FRAMES_F64);
        const page = await context.newPage();
        const nav = { commits: [] };
        page.on('framenavigated', (f) => {
          if (f === page.mainFrame()) nav.commits.push(Date.now());
        });
        const url = `http://127.0.0.1:${servers[server].port}${MODES[mode].page}`;
        for (const which of ['first', 'return']) {
          const s = await visit(page, url, nav);
          samples.push({ run: r, mode, server, visit: which, ...s });
          const ok = s.ms !== null && s.isolated;
          console.log(
            `run ${r + 1}/${runs} ${mode.padEnd(6)} ${server.padEnd(7)} ${which.padEnd(6)} ` +
              `${ok ? `${s.ms} ms` : `FAILED (${s.error || 'no frame'})`}  loads ${s.loads}` +
              (s.reloadMs !== null ? `, reload at ${s.reloadMs} ms` : ''),
          );
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  for (const s of Object.values(servers)) await s.close();
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};
const summary = [];
for (const mode of modes) {
  for (const server of ['headers', 'narrow', 'wide']) {
    for (const which of ['first', 'return']) {
      const rows = samples.filter((s) => s.mode === mode && s.server === server && s.visit === which);
      const ms = rows.filter((s) => s.ms !== null && s.isolated).map((s) => s.ms).sort((a, b) => a - b);
      const reloads = rows.filter((s) => s.reloadMs !== null).map((s) => s.reloadMs).sort((a, b) => a - b);
      summary.push({
        mode, server, visit: which, n: ms.length, failed: rows.length - ms.length,
        median: quantile(ms, 0.5), p25: quantile(ms, 0.25), p75: quantile(ms, 0.75),
        loads: [...new Set(rows.map((s) => s.loads))].join('/'),
        reloadMedian: quantile(reloads, 0.5),
      });
    }
  }
}
console.log('\nmode    server  visit   n  median  p25–p75      loads  reload at');
for (const s of summary) {
  const f = (v) => (v === null ? '—' : `${Math.round(v)}`);
  console.log(
    `${s.mode.padEnd(7)} ${s.server.padEnd(7)} ${s.visit.padEnd(6)} ${String(s.n).padStart(2)}  ${f(s.median).padStart(6)}  ` +
      `${`${f(s.p25)}–${f(s.p75)}`.padEnd(11)}  ${s.loads.padEnd(5)}  ${f(s.reloadMedian)}${s.failed ? `  (${s.failed} failed)` : ''}`,
  );
}
if (output) fs.writeFileSync(output, JSON.stringify({ when: new Date().toISOString(), runs, headed, summary, samples }, null, 2));
process.exitCode = samples.some((s) => s.ms === null || !s.isolated) ? 1 : 0;
