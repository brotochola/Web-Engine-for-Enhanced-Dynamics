#!/usr/bin/env node
/**
 * The Pixi worker's WebGL program links and its first frames (E-475): which programs link, when, and how long each
 * blocked the worker (the LINK_STATUS read: right after linkProgram when Pixi links on first bind, or at the first bind
 * of a program linked ahead), the links started ahead and never bound, the COMPLETION_STATUS_KHR polls, and the frames
 * (requestAnimationFrame callbacks): the first one that drew, the longest and the long ones in the 10 s after it.
 * The probe (programLinkProbeGl.js) runs before the worker's own modules: this tree's server serves
 * programLinkProbeWorker.js in place of /src/workers/pixiWorker.js and the worker beside it. Serves the tree it is in,
 * so run it from a revision's worktree (revWorktree.mjs) to probe that revision. Headed Chrome, a fresh profile (a cold
 * shader cache) each run.
 *
 *   node tests/bench/programLinkProbe.mjs --query "crowd=2.5&light3d=1&hour=22" [--ms 15000] [--output f.json]
 *     [--scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene] [--headless]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { benchWindowArgs } from './benchWindow.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
}
const query = typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '';
const ms = Number(args.ms || 15000);
const scene = String(args.scene || '/demos/predatorScene/predatorScene.js');
const sceneExport = String(args['scene-export'] || 'PredatorScene');
const headless = args.headless === true;

const server = await createStaticBenchmarkServer(repoRoot, 0, {
  files: {
    '/src/workers/pixiWorker.js': 'tests/bench/programLinkProbeWorker.js',
    '/src/workers/pixiWorkerReal.js': 'src/workers/pixiWorker.js',
  },
});
const launchArgs = ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', ...(os.platform() === 'win32' ? ['--disable-features=CalculateNativeWinOcclusion'] : []),
  ...(headless ? [] : benchWindowArgs())];
const browser = await chromium.launch({ headless, channel: 'chrome', args: launchArgs });
let result = null;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  let worker = null;
  page.on('worker', (w) => {
    if (worker === null && w.url().includes('/pixiWorker.js')) worker = w;
  });
  await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${query ? `&${query}` : ''}`);
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__));
  const pageOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(({ m, e }) => window.__WEED_BENCHMARK__.prepare({ warmupMs: 600000, durationMs: 600000, sampleIntervalMs: 1000,
    sceneModule: m, sceneExport: e, collectDetailedStats: false, collectGpuStats: false }), { m: scene, e: sceneExport });
  await page.waitForTimeout(ms);
  if (worker === null) throw new Error('no Pixi worker');
  const probe = await worker.evaluate(() => self.__programLinkProbe || null);
  if (probe === null) throw new Error('the probe did not run in the Pixi worker');
  result = { query, ms, scene, sceneExport, pageOrigin, ...probe };
} finally {
  await browser.close();
  await server.close();
}

// Times on the page's clock (since navigation start), from the worker's.
const shift = result.timeOrigin - result.pageOrigin;
const at = (t) => ((t + shift) / 1000).toFixed(2);
const links = result.links;
const blocked = links.reduce((s, l) => s + Math.max(0, l.blockedMs), 0);
const ahead = links.filter((l) => l.readAt < 0 || l.readAt - l.linkAt > l.blockedMs + 5);
const unread = links.filter((l) => l.readAt < 0);
console.log(`${links.length} links, ${blocked.toFixed(0)} ms blocked on LINK_STATUS; ${ahead.length} linked ahead ` +
  `(${unread.length} never bound); ${result.polls} COMPLETION_STATUS polls, ${result.pollMs.toFixed(1)} ms`);
for (const l of links) {
  if (l.blockedMs >= 5 || l.readAt < 0 || links.length <= 40) {
    const read = l.readAt < 0 ? 'never bound' : `read ${at(l.readAt)} s, blocked ${l.blockedMs.toFixed(1)} ms`;
    console.log(`  link ${at(l.linkAt)} s  ${read}  ${l.name}`);
  }
}
const f = result.frames;
let first = -1;
for (let i = 0; i < f.length; i += 3) if (f[i + 2] > 0) { first = i; break; }
const summary = { links: links.length, blockedMs: Math.round(blocked), ahead: ahead.length, unread: unread.length };
if (first < 0) {
  console.log('no frame drew');
} else {
  const firstEnd = f[first] + f[first + 1];
  let longest = 0;
  let longestAt = 0;
  let over16 = 0;
  let over50 = 0;
  let over100 = 0;
  let n = 0;
  for (let i = first; i < f.length && f[i] < firstEnd + 10000; i += 3) {
    const d = f[i + 1];
    n++;
    if (d > longest) { longest = d; longestAt = f[i]; }
    if (d >= 16.7) over16++;
    if (d >= 50) over50++;
    if (d >= 100) over100++;
  }
  Object.assign(summary, { firstFrameEndS: +at(firstEnd), firstFrameMs: +f[first + 1].toFixed(1), firstDrawS: +at(result.firstDrawAt),
    frames10s: n, longestMs: +longest.toFixed(1), longestAtS: +at(longestAt), over16, over50, over100 });
  console.log(`first drawn frame: ${f[first + 1].toFixed(1)} ms, ended ${at(firstEnd)} s after navigation start ` +
    `(worker started ${(shift / 1000).toFixed(2)} s); 10 s from it: ${n} frames, longest ${longest.toFixed(1)} ms at ` +
    `${at(longestAt)} s, ${over16} of 16.7 ms or more, ${over50} of 50, ${over100} of 100`);
}
console.log(`summary ${JSON.stringify(summary)}`);
if (args.output) fs.writeFileSync(String(args.output), JSON.stringify({ summary, ...result }, null, 1));
