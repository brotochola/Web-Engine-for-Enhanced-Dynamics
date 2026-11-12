#!/usr/bin/env node
/**
 * Films a scene in motion (CDP Page.startScreencast, about 55 fps headed) into an mp4, for render changes a still
 * capture cannot prove (a glow that pops in, a tail that vanishes, a flash's fade). With --vs, films the same scene
 * from that revision too and puts the two side by side (left: --vs, right: this tree or --hyp-rev). The two runs are
 * not frame-locked: time-driven motion matches closely, not exactly.
 *
 *   node tests/bench/filmScene.mjs --scene /tests/bench/stressScenes/lightMotionScene.js \
 *     --scene-export LightMotionScene --seconds 8 --out D:/tmp/films/motion.mp4 [--vs <rev>] [--query k=v]
 *
 * --query k=v (repeatable, both sides), --query-a / --query-b (one side), --warmup-ms (default 1500), --seconds
 * (default 6), --ffmpeg <path> (default ffmpeg on PATH, else D:/ffmpeg/ffmpeg.exe), --keep-frames. --full-rev: the
 * worktrees hold the whole revision, its scenes too, not only its src/ (an API change).
 * Audio is muted. Exit 1 on a page error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { ensureRevWorktree } from './revWorktree.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };

function parseCli(argv) {
  const opts = { query: [], queryA: [], queryB: [], warmupMs: 1500, seconds: 6, keepFrames: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--vs') opts.vs = next();
    else if (arg === '--hyp-rev') opts.hypRev = next();
    else if (arg === '--scene') opts.scene = next();
    else if (arg === '--scene-export') opts.sceneExport = next();
    else if (arg === '--query') opts.query.push(next());
    else if (arg === '--query-a') opts.queryA.push(next());
    else if (arg === '--query-b') opts.queryB.push(next());
    else if (arg === '--warmup-ms') opts.warmupMs = Number(next());
    else if (arg === '--seconds') opts.seconds = Number(next());
    else if (arg === '--out') opts.out = next();
    else if (arg === '--ffmpeg') opts.ffmpeg = next();
    else if (arg === '--keep-frames') opts.keepFrames = true;
    else if (arg === '--full-rev') opts.fullRev = true;
    else throw new Error(`filmScene: unknown argument ${arg}`);
  }
  if (!opts.scene || !opts.sceneExport || !opts.out) throw new Error('filmScene: --scene, --scene-export and --out are required');
  return opts;
}

function findFfmpeg(given) {
  if (given) return given;
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (probe.status === 0) return 'ffmpeg';
  return 'D:/ffmpeg/ffmpeg.exe';
}

/** Records one side's frames into `dir` (frame_00000.jpg …) and returns the frame count and the mean fps. */
async function film(browser, root, opts, sideQuery, dir) {
  const server = await createStaticBenchmarkServer(root);
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    const params = new URLSearchParams('src=1');
    for (const pair of [...opts.query, ...sideQuery]) {
      const [key, value = ''] = pair.split('=');
      params.set(key, value);
    }
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, {
      waitUntil: 'networkidle',
    });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(
      ({ scene, sceneExport, size, ms }) =>
        window.__WEED_BENCHMARK__.prepare({
          warmupMs: ms,
          durationMs: 1000,
          sampleIntervalMs: 100,
          sceneModule: scene,
          sceneExport,
          canvasWidth: size.width,
          canvasHeight: size.height,
        }),
      { scene: opts.scene, sceneExport: opts.sceneExport, size: VIEWPORT, ms: opts.warmupMs },
    );
    await page.waitForTimeout(opts.warmupMs);
    fs.mkdirSync(dir, { recursive: true });
    const cdp = await page.context().newCDPSession(page);
    let n = 0;
    let first = NaN;
    let last = NaN;
    cdp.on('Page.screencastFrame', (frame) => {
      fs.writeFileSync(path.join(dir, `frame_${String(n).padStart(5, '0')}.jpg`), Buffer.from(frame.data, 'base64'));
      const t = frame.metadata?.timestamp;
      if (n === 0) first = t;
      last = t;
      n++;
      cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
    await page.waitForTimeout(opts.seconds * 1000);
    await cdp.send('Page.stopScreencast');
    const span = last - first;
    const fps = n > 1 && span > 0 ? (n - 1) / span : 30;
    return { frames: n, fps, errors };
  } finally {
    await page.close();
    await server.close();
  }
}

function encode(ffmpeg, dir, fps, out) {
  const r = spawnSync(
    ffmpeg,
    ['-y', '-loglevel', 'error', '-framerate', fps.toFixed(3), '-i', path.join(dir, 'frame_%05d.jpg'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', out],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`filmScene: ffmpeg failed on ${dir}`);
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const ffmpeg = findFfmpeg(opts.ffmpeg);
  const work = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'weed-film-'));
  const sides = [];
  const wt = { srcOnly: !opts.fullRev };
  if (opts.vs) sides.push({ name: 'a', root: ensureRevWorktree(opts.vs, wt).root, query: opts.queryA });
  sides.push({
    name: 'b',
    root: opts.hypRev ? ensureRevWorktree(opts.hypRev, { ...wt, tag: 'hyp' }).root : repoRoot,
    query: opts.queryB,
  });
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu', '--mute-audio'],
  });
  const errors = [];
  try {
    for (const side of sides) {
      side.dir = path.join(work, side.name);
      const res = await film(browser, side.root, opts, side.query, side.dir);
      side.fps = res.fps;
      errors.push(...res.errors);
      console.log(`side ${side.name}: ${res.frames} frames, ${res.fps.toFixed(1)} fps`);
    }
  } finally {
    await browser.close();
  }
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  if (sides.length === 1) {
    encode(ffmpeg, sides[0].dir, sides[0].fps, opts.out);
  } else {
    for (const side of sides) {
      side.mp4 = path.join(work, `${side.name}.mp4`);
      encode(ffmpeg, side.dir, side.fps, side.mp4);
    }
    const r = spawnSync(
      ffmpeg,
      ['-y', '-loglevel', 'error', '-i', sides[0].mp4, '-i', sides[1].mp4, '-filter_complex', 'hstack=inputs=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', opts.out],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error('filmScene: ffmpeg hstack failed');
  }
  if (!opts.keepFrames) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`frames kept in ${work}`);
  console.log(`${errors.length ? 'FAIL' : 'OK'} ${opts.out}${errors.length ? `; page errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  process.exitCode = errors.length ? 1 : 0;
}

await main();
