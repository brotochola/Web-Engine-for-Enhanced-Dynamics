#!/usr/bin/env node
/**
 * Worker fields that start as null and hold a typed array while a scene runs.
 * V8 types a field declared null as Any, so optimized code checks the array's
 * class at each use; declared as an empty array of the right class, the field
 * keeps that class when the real array replaces it (E-71: 15 % of the
 * pre-render emit kernel).
 *
 *   node tests/bench/fieldTypeAudit.mjs --scene /demos/predatorScene/predatorScene.js \
 *     --scene-export PredatorScene [--query k=v] [--warmup-ms 8000] [--output audit.json]
 *
 * From Git Bash set MSYS_NO_PATHCONV=1, as for the benchmark runner. Chrome
 * reports, for each worker instance on a worker's `self`, the own fields that
 * hold a typed array after the warm-up. Node then builds each worker with
 * tests/bench/workerHarness.mjs and keeps the fields that held null right
 * after the constructor. Only own fields of the worker object are seen, not
 * fields of objects it points to, and only workers the page starts (the
 * page's auto-attach). A field that a path sets back to null, or to arrays of
 * different classes, stays Any whatever its first value: check each one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { loadWorker } from './workerHarness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

// Runs inside each worker: own typed-array fields of the worker objects on self.
const PROBE = `(() => {
  const out = {};
  for (const key of Object.keys(self)) {
    const v = self[key];
    if (!v || typeof v !== 'object' || !v.constructor || !/(Worker|Renderer)$/.test(v.constructor.name)) continue;
    out[key] = Object.keys(v).filter((f) => ArrayBuffer.isView(v[f])).map((f) => [f, v[f].constructor.name]);
  }
  return out;
})()`;

const args = parseArgs(process.argv.slice(2));
if (!args.scene || !args['scene-export']) {
  console.error('usage: fieldTypeAudit.mjs --scene <module> --scene-export <Class> [--query k=v] [--warmup-ms N] [--output file]');
  process.exit(2);
}
const sceneModule = args.scene;
const sceneExport = args['scene-export'];
const warmupMs = Number(args['warmup-ms'] ?? 8000);

const server = await createStaticBenchmarkServer(repoRoot);
const launchArgs = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (os.platform() === 'win32') launchArgs.push('--disable-features=CalculateNativeWinOcclusion');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });
const seen = new Map(); // worker file -> { selfKey, fields: Map(field -> class) }
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  const cdp = await page.context().newCDPSession(page);

  let nextId = 1;
  const pending = new Map();
  const sessions = new Map();
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const m = JSON.parse(message);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  const sendTo = (sessionId, method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
  };
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type === 'worker') sessions.set(sessionId, targetInfo.url.split('/').pop().split('?')[0]);
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });

  const qs = ['src=1'];
  if (typeof args.query === 'string') qs.push(args.query.replace(/^\?/, ''));
  await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${qs.join('&')}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  const dims = await page.evaluate(async ({ sceneModule, sceneExport }) => {
    const C = (await import(sceneModule))[sceneExport];
    return { width: C.config.worldWidth, height: C.config.worldHeight };
  }, { sceneModule, sceneExport });
  await page.setViewportSize({ width: 1280, height: 720 });
  const run = page.evaluate((o) => window.__WEED_BENCHMARK__.run(o), {
    warmupMs: warmupMs + 2000, durationMs: 1000, sampleIntervalMs: 250, sceneModule, sceneExport,
    collectDetailedStats: false, collectGpuStats: false, canvasWidth: 1280, canvasHeight: 720,
    worldWidth: dims.width, worldHeight: dims.height,
  });

  await new Promise((r) => setTimeout(r, warmupMs));
  for (const [sid, file] of sessions) {
    const res = await sendTo(sid, 'Runtime.evaluate', { expression: PROBE, returnByValue: true }).catch(() => null);
    const value = res && res.result && res.result.value;
    if (!value) continue;
    for (const [selfKey, fields] of Object.entries(value)) {
      const entry = seen.get(file) || { selfKey, fields: new Map() };
      for (const [f, cls] of fields) entry.fields.set(f, cls);
      seen.set(file, entry);
    }
  }
  await run.catch(() => {});
} finally {
  await browser.close();
  await server.close();
}

const report = {};
for (const [file, { selfKey, fields }] of seen) {
  let fresh;
  try {
    fresh = await loadWorker(file, selfKey);
  } catch (e) {
    report[file] = { error: String(e.message || e) };
    continue;
  }
  const rows = [...fields]
    .filter(([f]) => fresh[f] === null || fresh[f] === undefined)
    .map(([f, cls]) => ({ field: f, startsAs: f in fresh ? String(fresh[f]) : 'absent', holds: cls }));
  report[file] = { selfKey, typedFields: fields.size, startNull: rows };
}
if (typeof args.output === 'string') fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
for (const [file, r] of Object.entries(report)) {
  if (r.error) {
    console.log(`\n== ${file}: could not build in Node (${r.error})`);
    continue;
  }
  const declared = r.startNull.filter((row) => row.startsAs !== 'absent');
  const later = r.startNull.filter((row) => row.startsAs === 'absent');
  console.log(`\n== ${file} (self.${r.selfKey}): ${declared.length} of ${r.typedFields} typed-array fields start null`);
  for (const row of declared) console.log(`  ${row.field.padEnd(36)} ${row.startsAs.padEnd(9)} -> ${row.holds}`);
  // Added by initialize() or later: their first value is the real array, so the
  // field type is right; a late add is a shape question (N-32), not this one.
  if (later.length) console.log(`  added after the constructor: ${later.map((row) => row.field).join(' ')}`);
}
