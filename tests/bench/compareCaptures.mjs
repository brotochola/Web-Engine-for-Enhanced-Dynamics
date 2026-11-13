#!/usr/bin/env node
/**
 * Byte-for-byte canvas captures of one still scene, on two sides: a feature's default against a base revision, or
 * the feature on against off. Any page error (a shader that does not compile, say) fails the run.
 *
 *   node tests/bench/compareCaptures.mjs --vs main --scene /tests/bench/stressScenes/dxCaptureScene.js \
 *     --scene-export DxCaptureScene --query hour=22 --query backend=webgpu
 *   node tests/bench/compareCaptures.mjs --scene ... --scene-export ... --query-b night=1 --expect-diff
 *
 * --vs <rev>: side A is src/ from that revision, in a worktree (revWorktree.mjs). Without it both sides are this tree,
 * which with --query-b compares a knob. --hyp-rev <rev>: side B is that revision, in a worktree, instead of this tree.
 * --full-rev: those worktrees hold the whole revision, its scenes and tests too, not only its src/ (an API change,
 * where each side's scene is written in its own API).
 * --query k=v (repeatable): page parameters, both sides. --query-a / --query-b: one side only.
 * --expect-diff: pass when the sides differ, for a knob that must change the picture.
 * --tolerance <n>: pass when no channel of any pixel differs by more than n of 255 (default 0).
 * --wait-ms (default 3000), --headless (a real GPU needs headed Chrome), --save <dir>: keep both PNGs.
 * Exit 0 on the verdict asked for, 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';
import { ensureRevWorktree } from './revWorktree.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };

function parseCli(argv) {
  const opts = { query: [], queryA: [], queryB: [], waitMs: 3000, tolerance: 0, expectDiff: false, headless: false };
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
    else if (arg === '--wait-ms') opts.waitMs = Number(next());
    else if (arg === '--tolerance') opts.tolerance = Number(next());
    else if (arg === '--expect-diff') opts.expectDiff = true;
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--full-rev') opts.fullRev = true;
    else if (arg === '--save') opts.save = next();
    else throw new Error(`compareCaptures: unknown argument ${arg}`);
  }
  if (!opts.scene || !opts.sceneExport) throw new Error('compareCaptures: --scene and --scene-export are required');
  return opts;
}

async function capture(browser, root, opts, sideQuery) {
  const server = await createStaticBenchmarkServer(root);
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    // A side's key replaces the shared one.
    const params = new URLSearchParams('src=1');
    for (const pair of [...opts.query, ...sideQuery]) {
      const [key, value = ''] = pair.split('=');
      params.set(key, value);
    }
    const query = params.toString();
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${query}`, {
      waitUntil: 'networkidle',
    });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(
      ({ scene, sceneExport, waitMs, size }) =>
        window.__WEED_BENCHMARK__.prepare({
          warmupMs: waitMs,
          durationMs: 1000,
          sampleIntervalMs: 100,
          sceneModule: scene,
          sceneExport,
          canvasWidth: size.width,
          canvasHeight: size.height,
        }),
      { scene: opts.scene, sceneExport: opts.sceneExport, waitMs: opts.waitMs, size: VIEWPORT },
    );
    await page.waitForTimeout(opts.waitMs);
    const png = await captureCanvasPng(page);
    return { png, errors };
  } finally {
    await page.close();
    await server.close();
  }
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const wt = { srcOnly: !opts.fullRev };
  const rootA = opts.vs ? ensureRevWorktree(opts.vs, wt).root : repoRoot;
  const rootB = opts.hypRev ? ensureRevWorktree(opts.hypRev, { ...wt, tag: 'hyp' }).root : repoRoot;
  const browser = await chromium.launch({
    headless: opts.headless,
    channel: 'chrome',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu'],
  });
  try {
    const a = await capture(browser, rootA, opts, opts.queryA);
    const b = await capture(browser, rootB, opts, opts.queryB);
    const page = await browser.newPage();
    const diff = await diffPngs(page, a.png, b.png);
    await page.close();
    if (opts.save) {
      fs.mkdirSync(opts.save, { recursive: true });
      fs.writeFileSync(path.join(opts.save, 'a.png'), a.png);
      fs.writeFileSync(path.join(opts.save, 'b.png'), b.png);
    }
    const errors = [...a.errors, ...b.errors];
    const same = diff.maxDelta <= opts.tolerance;
    const ok = errors.length === 0 && same !== opts.expectDiff;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${opts.sceneExport} [${opts.query.join(' ')}] a[${opts.queryA.join(' ')}] b[${opts.queryB.join(' ')}]: ` +
        `${diff.differing} of ${diff.pixels} pixels differ, max delta ${diff.maxDelta}` +
        (errors.length ? `; page errors: ${errors.slice(0, 3).join(' | ')}` : ''),
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

await main();
