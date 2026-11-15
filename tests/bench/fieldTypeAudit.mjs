#!/usr/bin/env node
/**
 * Worker fields that start as null and hold a typed array while a scene runs.
 * V8 types a field declared null as Any, so optimized code checks the array's
 * class at each use; declared as an empty array of the right class, the field
 * keeps that class when the real array replaces it (E-71: 15 % of the
 * pre-render emit kernel).
 *
 * Also the fields that start as a Smi (an integer such as 0) and hold a fraction while the scene runs (E-350): the
 * first fractional write changes the field's representation from Smi to double, which moves the object to a new map
 * and deoptimizes the code that saw the old one. Declared as a double (-0, or NaN where the field must read as
 * "none"), the field keeps its map. These are the worker objects' own number fields and those of plain objects they
 * hold (as `_timing.deltaTime`), seen holding a non-integer in any of a few probes after the warm-up; a field that
 * only ever held an integer when probed is not seen.
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

// Runs inside each worker: own typed-array fields of the worker objects on self, and their number fields (and those
// of the plain objects they hold) that hold a non-integer: NaN and Infinity count, as they are doubles too.
const PROBE = `(() => {
  const out = {};
  const plain = (o) => o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
  const fraction = (x) => typeof x === 'number' && !Number.isInteger(x);
  for (const key of Object.keys(self)) {
    const v = self[key];
    if (!v || typeof v !== 'object' || !v.constructor || !/(Worker|Renderer)$/.test(v.constructor.name)) continue;
    const typed = Object.keys(v).filter((f) => ArrayBuffer.isView(v[f])).map((f) => [f, v[f].constructor.name]);
    const fractions = [];
    for (const f of Object.keys(v)) {
      const x = v[f];
      if (fraction(x)) fractions.push(f);
      else if (plain(x)) for (const g of Object.keys(x)) if (fraction(x[g])) fractions.push(f + '.' + g);
    }
    out[key] = { typed, fractions };
  }
  return out;
})()`;

/** The value at a dotted path of fields ('a' or 'a.b'), and whether the path exists. */
function atPath(obj, dotted) {
  let cur = obj;
  for (const f of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(f in cur)) return { present: false, value: undefined };
    cur = cur[f];
  }
  return { present: true, value: cur };
}

/** A number V8 stores as a Smi: an integer in the 31-bit range, not -0 (a double). */
function isSmi(x) {
  return Number.isInteger(x) && !Object.is(x, -0) && x >= -(2 ** 30) && x < 2 ** 30;
}

const args = parseArgs(process.argv.slice(2));
if (!args.scene || !args['scene-export']) {
  console.error('usage: fieldTypeAudit.mjs --scene <module> --scene-export <Class> [--query k=v] [--warmup-ms N] [--probes N] [--probe-gap-ms N] [--output file]');
  process.exit(2);
}
const sceneModule = args.scene;
const sceneExport = args['scene-export'];
const warmupMs = Number(args['warmup-ms'] ?? 8000);
// The fraction fields are probed a few times: a timing field can hold a whole number at one probe.
const probes = Math.max(1, Number(args.probes ?? 5) | 0);
const probeGapMs = Number(args['probe-gap-ms'] ?? 300);

const server = await createStaticBenchmarkServer(repoRoot);
const launchArgs = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (os.platform() === 'win32') launchArgs.push('--disable-features=CalculateNativeWinOcclusion');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });
const seen = new Map(); // worker file -> { selfKey, fields: Map(field -> class), fractions: Set(path) }
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
    warmupMs: warmupMs + 2000 + probes * probeGapMs, durationMs: 1000, sampleIntervalMs: 250, sceneModule, sceneExport,
    collectDetailedStats: false, collectGpuStats: false, canvasWidth: 1280, canvasHeight: 720,
    worldWidth: dims.width, worldHeight: dims.height,
  });

  await new Promise((r) => setTimeout(r, warmupMs));
  for (let p = 0; p < probes; p++) {
    if (p > 0) await new Promise((r) => setTimeout(r, probeGapMs));
    for (const [sid, file] of sessions) {
      const res = await sendTo(sid, 'Runtime.evaluate', { expression: PROBE, returnByValue: true }).catch(() => null);
      const value = res && res.result && res.result.value;
      if (!value) continue;
      for (const [selfKey, { typed, fractions }] of Object.entries(value)) {
        const entry = seen.get(file) || { selfKey, fields: new Map(), fractions: new Set() };
        for (const [f, cls] of typed) entry.fields.set(f, cls);
        for (const f of fractions) entry.fractions.add(f);
        seen.set(file, entry);
      }
    }
  }
  // The probes are in: the browser closes now (the finally) and the run ends with it. Awaiting the run's own end
  // left the audit waiting past 400 s on a loaded Linux machine (heapSampleWorkers does the same).
  run.catch(() => {});
} finally {
  await browser.close();
  await server.close();
}

const report = {};
for (const [file, { selfKey, fields, fractions }] of seen) {
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
  // E-350: fields seen holding a fraction that the constructor left as a Smi (or did not declare).
  const smiRows = [...fractions].sort()
    .map((f) => ({ field: f, ...atPath(fresh, f) }))
    .filter((row) => !row.present || isSmi(row.value))
    .map((row) => ({ field: row.field, startsAs: row.present ? String(row.value) : 'absent' }));
  report[file] = { selfKey, typedFields: fields.size, startNull: rows, fractionFields: fractions.size, startSmi: smiRows };
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
  const smi = r.startSmi.filter((row) => row.startsAs !== 'absent');
  const smiLater = r.startSmi.filter((row) => row.startsAs === 'absent');
  console.log(`  ${smi.length} of ${r.fractionFields} fields seen holding a fraction start as a Smi`);
  for (const row of smi) console.log(`  ${row.field.padEnd(36)} ${row.startsAs.padEnd(9)} -> double`);
  if (smiLater.length) console.log(`  fraction fields added after the constructor: ${smiLater.map((row) => row.field).join(' ')}`);
}
