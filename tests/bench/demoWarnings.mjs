/**
 * N-167: every demo starts without a warning. Each scene of the demos' start page (demos/menu.js) runs in headed
 * Chrome on the bench page from src/ for a few seconds; every console warning and error of the page and its workers,
 * and every page error, is listed under its demo. Exit 1 when any demo logged one, so the demos stay configured for
 * what they do.
 *
 *   node tests/bench/demoWarnings.mjs [--only boidsScene,predatorScene] [--seconds 8] [--root <dir>]
 *
 * --only: scene file names (without .js).
 * --seconds: how long each demo runs once started (default 8: the first spawns, the first pools filled).
 * --root: serve that tree instead of this one (a worktree under test).
 * --allow <text>[,<text>]: messages holding one of these are listed apart and do not fail the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { repoRoot } from './measureLib.mjs';
import { sceneExport } from './profileSceneSweep.mjs';

/** The start page's scenes: each entry's url and, where it names one, its export. */
export function menuScenes(root = repoRoot) {
  const src = fs.readFileSync(path.join(root, 'demos/menu.js'), 'utf8');
  const out = [];
  for (const m of src.matchAll(/\{\s*name:\s*'[^']*',\s*url:\s*'([^']+)'(?:,\s*export:\s*'([^']+)')?\s*\}/g)) {
    out.push({ file: m[1], exportName: m[2] || sceneExport(m[1]) });
  }
  if (out.length === 0) throw new Error('no scene found in demos/menu.js');
  return out;
}

/** Chrome's own notes, not the engine's or the demo's. */
const BROWSER_NOISE = [/GPU stall due to ReadPixels/, /Automatic fallback to software WebGL/, /\[\.WebGL-/];

async function runDemo(browser, port, { file, exportName }, seconds) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const found = [];
  page.on('pageerror', (e) => found.push(`[page error] ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    const type = m.type();
    if (type !== 'warning' && type !== 'error') return;
    const text = m.text();
    if (BROWSER_NOISE.some((re) => re.test(text))) return;
    found.push(`[${type}] ${text.slice(0, 300)}`);
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate((a) => window.__WEED_BENCHMARK__.prepare({
      warmupMs: 600000, durationMs: 1000, sampleIntervalMs: 100, sceneModule: a.file, sceneExport: a.exportName,
      canvasWidth: 1280, canvasHeight: 720,
    }), { file, exportName });
    await page.waitForTimeout(seconds * 1000);
  } catch (err) {
    found.push(`[harness] ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}`);
  } finally {
    await page.close().catch(() => {});
  }
  // The same message from several workers once, with its count.
  const counts = new Map();
  for (const f of found) counts.set(f, (counts.get(f) || 0) + 1);
  return [...counts].map(([text, n]) => (n > 1 ? `${text} (x${n})` : text));
}

async function main() {
  const args = parseArgs();
  const seconds = Number(args.seconds ?? 8);
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const allow = args.allow ? String(args.allow).split(',') : [];
  const root = args.root ? path.resolve(String(args.root)) : repoRoot;
  const files = menuScenes(root).filter((s) => !only || only.has(path.basename(s.file, '.js')));
  if (files.length === 0) throw new Error('no demo matches --only');
  const server = await createStaticBenchmarkServer(root);
  const browser = await chromium.launch({ headless: false, args: ['--mute-audio'] });
  let failing = 0;
  try {
    for (const scene of files) {
      const name = path.basename(scene.file, '.js');
      const all = await runDemo(browser, server.port, scene, seconds);
      const allowed = all.filter((t) => allow.some((a) => t.includes(a)));
      const bad = all.filter((t) => !allowed.includes(t));
      if (bad.length) failing++;
      console.log(`${bad.length ? 'WARN' : 'ok  '} ${name}${allowed.length ? ` (${allowed.length} allowed)` : ''}`);
      for (const t of bad) console.log(`       ${t}`);
    }
  } finally {
    await browser.close();
    await server.close?.();
  }
  console.log(`\n${files.length - failing} of ${files.length} demos started without a warning`);
  process.exitCode = failing ? 1 : 0;
}

if (isCli(import.meta.url)) await main();
