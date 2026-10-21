/**
 * Where workers allocate, in Chrome: a sampling heap profile of chosen workers
 * while a scene runs, counting the objects minor and major GCs have already
 * collected (allocation sites, not the live heap). Node's V8 can disagree: it
 * boxed nothing on paths where Chrome made a heap number per entity (E-66).
 *
 *   node tests/bench/heapSampleWorkers.mjs --scene /demos/predatorScene/predatorScene.js \
 *     --scene-export PredatorScene --workers preRenderWorker,logicWorker [--query k=v] \
 *     [--warmup-ms 10000] [--sample-ms 8000] [--output heap.json]
 *
 * From Git Bash set MSYS_NO_PATHCONV=1, as for the benchmark runner. Prints, per
 * worker, the top allocating functions in KB/s and their callers. Sampling, so a
 * site is accurate to about samplingInterval (1 KB) per sample; compare totals
 * of the same scene, not single small rows. The scene's numbers mean nothing
 * here: the profiler slows every allocation. Only workers the page itself starts
 * are reached (the page's auto-attach), so a worker started by another worker
 * does not show up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

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

const args = parseArgs(process.argv.slice(2));
if (!args.scene || !args['scene-export'] || !args.workers) {
  console.error('usage: heapSampleWorkers.mjs --scene <module> --scene-export <Class> --workers <a,b> [--query k=v] [--warmup-ms N] [--sample-ms N] [--output file]');
  process.exit(2);
}
const sceneModule = args.scene;
const sceneExport = args['scene-export'];
const wanted = String(args.workers).split(',');
const warmupMs = Number(args['warmup-ms'] ?? 10000);
const sampleMs = Number(args['sample-ms'] ?? 8000);

const server = await createStaticBenchmarkServer(repoRoot);
const launchArgs = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (os.platform() === 'win32') launchArgs.push('--disable-features=CalculateNativeWinOcclusion');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  const cdp = await page.context().newCDPSession(page);

  // Dedicated workers have no Playwright CDP session; reach them through the
  // page's auto-attach and Target.sendMessageToTarget.
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
    if (targetInfo.type === 'worker' && wanted.some((w) => targetInfo.url.includes(w))) {
      sessions.set(sessionId, targetInfo.url.split('/').pop().split('?')[0]);
    }
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
    warmupMs: warmupMs + sampleMs, durationMs: 2000, sampleIntervalMs: 250, sceneModule, sceneExport,
    collectDetailedStats: false, collectGpuStats: false, canvasWidth: 1280, canvasHeight: 720,
    worldWidth: dims.width, worldHeight: dims.height,
  });

  await new Promise((r) => setTimeout(r, warmupMs));
  for (const sid of sessions.keys()) {
    await sendTo(sid, 'HeapProfiler.enable');
    await sendTo(sid, 'HeapProfiler.startSampling', {
      samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
    });
  }
  await new Promise((r) => setTimeout(r, sampleMs));

  const report = {};
  const perS = (bytes) => +(bytes / 1024 / (sampleMs / 1000)).toFixed(1);
  for (const [sid, name] of sessions) {
    const { profile } = await sendTo(sid, 'HeapProfiler.stopSampling');
    const rows = new Map();
    let total = 0;
    const walk = (node, parent) => {
      const f = node.callFrame;
      const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*?\/(src|tests|demos)\//, '$1/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
      if (node.selfSize > 0) {
        const r = rows.get(key) || { bytes: 0, from: new Map() };
        r.bytes += node.selfSize;
        r.from.set(parent, (r.from.get(parent) || 0) + node.selfSize);
        rows.set(key, r);
        total += node.selfSize;
      }
      for (const c of node.children || []) walk(c, key);
    };
    walk(profile.head, '');
    report[`${name} ${sid.slice(0, 6)}`] = {
      totalKbPerS: perS(total),
      top: [...rows].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25).map(([site, r]) => ({
        site,
        kbPerS: perS(r.bytes),
        from: [...r.from].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([p, b]) => ({ caller: p, kbPerS: perS(b) })),
      })),
    };
  }
  if (typeof args.output === 'string') fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
  for (const [worker, r] of Object.entries(report)) {
    console.log(`\n== ${worker}: ${r.totalKbPerS} KB/s sampled`);
    for (const t of r.top.slice(0, 15)) {
      console.log(`${String(t.kbPerS).padStart(9)} KB/s  ${t.site}   <- ${t.from.map((f) => `${f.caller} (${f.kbPerS})`).join(' | ')}`);
    }
  }
  await run.catch(() => {});
} finally {
  await browser.close();
  await server.close();
}
