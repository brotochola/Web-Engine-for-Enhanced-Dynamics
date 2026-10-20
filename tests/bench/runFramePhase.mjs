#!/usr/bin/env node
/**
 * E-24 — when do the workers run, relative to each other?
 *
 * Headed Predator, source tree (`?src=1`), detailed stats off. The decision
 * rules are summarizePhase in src/util/frameClock.js and were named before
 * this run. This script does not interpret a broken clock as a phase.
 *
 *   node tests/bench/runFramePhase.mjs
 *   node tests/bench/runFramePhase.mjs --warmup-ms 10000 --capture-ms 5000
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { parseArgs } from './microbenchHelpers.mjs';
import { summarizePhase } from '../../src/util/frameClock.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const warmupMs = Number(args['warmup-ms'] ?? 10000);
const captureMs = Number(args['capture-ms'] ?? 5000);
const outDir = path.resolve(repoRoot, String(args.output ?? 'tests/results/e24-frame-phase'));

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function phaseTable(samples) {
  const phase = Object.create(null);
  const duration = Object.create(null);
  const genDelta = Object.create(null);
  for (const sample of samples) {
    for (const slot of sample.slots || []) {
      const dur = slot.end - slot.start;
      if (!(dur > 0) || dur >= 40) continue;
      if (slot.gen !== sample.mainGen && slot.gen !== sample.mainGen - 1) continue;
      const delta = slot.start - sample.mainT0;
      if (Math.abs(delta) > 100) continue;
      (phase[slot.name] ||= []).push(delta);
      (duration[slot.name] ||= []).push(dur);
      (genDelta[slot.name] ||= []).push(slot.gen - sample.mainGen);
    }
  }
  const rows = {};
  for (const name of Object.keys(phase)) {
    rows[name] = {
      n: phase[name].length,
      phaseMs: median(phase[name]),
      durationMs: median(duration[name]),
      genDelta: median(genDelta[name]),
    };
  }
  return rows;
}

const server = await createStaticBenchmarkServer(repoRoot);
const url =
  `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1` +
  '&scene=/demos/predatorScene/predatorScene.js&sceneExport=PredatorScene';
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-webgpu-developer-features',
    '--enable-dawn-features=allow_unsafe_apis',
    // Same as runIntegratedWorkerBenchmark: without it Windows reports a covered
    // window as hidden and Chrome throttles its frames (review M9).
    ...(process.platform === 'win32' ? ['--disable-features=CalculateNativeWinOcclusion'] : []),
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (err) => console.error('[page error]', err));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(() =>
    window.__WEED_BENCHMARK__.prepare({
      warmupMs: 1000,
      durationMs: 1000,
      sampleIntervalMs: 250,
      sceneModule: '/demos/predatorScene/predatorScene.js',
      sceneExport: 'PredatorScene',
      collectDetailedStats: false,
      collectGpuStats: false,
    })
  );
  await page.waitForTimeout(warmupMs);
  await page.evaluate(() => {
    const scene = window.__WEED_BENCHMARK__.getScene();
    scene._phaseLog = [];
  });
  await page.waitForTimeout(captureMs);
  const samples = await page.evaluate(() => {
    const scene = window.__WEED_BENCHMARK__.getScene();
    const log = scene._phaseLog || [];
    scene._phaseLog = null;
    return log;
  });

  const summary = summarizePhase(samples);
  const table = phaseTable(samples);
  const payload = {
    scene: 'PredatorScene',
    headed: true,
    src: true,
    collectDetailedStats: false,
    warmupMs,
    captureMs,
    summary,
    workers: table,
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(payload, null, 2) + '\n');
  console.log(JSON.stringify({ verdict: summary.verdict, spreadMs: summary.spreadMs, samples: summary.samples, reason: summary.reason, broken: summary.broken }, null, 2));
  console.log(JSON.stringify(table, null, 2));
  console.log(`wrote ${path.join(outDir, 'summary.json')}`);
} finally {
  await browser.close();
  await server.close();
}
