#!/usr/bin/env node
/**
 * Deterministic replay of a worker's frames: record a few seconds of a real scene's worker inputs once (a headed run),
 * then replay them into the worker's real code in Node (or d8), so a change to that worker is judged in seconds, on
 * the same inputs both sides, without the browser, the other workers or the bench queue's scene sittings.
 *
 * Record (once, through the bench lock; headed Chrome, `--src`, detailed stats off, like runFramePhase):
 *   node tests/bench/replayWorker.mjs --worker spatial --record <dir> --scene /demos/predatorScene/predatorScene.js
 *     --scene-export PredatorScene --query "crowd=2.5&zoom=0.216&light3d=1&hour=22" [--frames 600] [--warmup-ms 12000]
 *     [--rev <sha>]   (the tree served: a rev worktree of HEAD by default, never the main folder)
 * writes <dir>/meta.json (the worker's setup, the columns, the live update() time of each frame recorded) and
 * <dir>/frames.bin.gz (one record a frame: replayCodec.mjs). The recorder runs inside the live worker (sent there with
 * Playwright's worker.evaluate, so src/ is unchanged) and costs it a few ms a frame outside update().
 *
 * Replay (through the bench lock too: it is a kernel run):
 *   node tests/bench/replayWorker.mjs --replay <dir> [--rev <sha>] [--vs <sha> --pairs 4] [--rounds 2] [--warmup 60]
 *     [--d8] [--output <file.json>]
 * `--rev` replays a revision's src/ (a rev worktree: src from the rev, the replay scripts from this tree), else this
 * tree's; `--vs` adds a baseline and alternates the two, one process a side per pair (ABAB). Each process: a check pass
 * (every frame's published rows hashed) and `--rounds` timed passes on fresh workers. Per side and worker: every frame's
 * median over its timed passes, then over frames from `--warmup` on: mean, p50, p95, p99, max, frames of 16 ms or more,
 * frames over twice the first side's p50, the strongest autocorrelation lag (a periodic tail), and the correlation with
 * the frame times recorded live. With --vs: each pair's mean delta, and whether the rows match frame by frame.
 * `--d8` runs the replay in d8 (V8 16, as Chrome; D:/perf-tools/v8/release/v8.exe or $WEED_D8) instead of Node 22.
 *
 * Limits: one thread runs every worker of the recording in turn, so the replay has no cross-core traffic with logic
 * and physics (they read the rows and write the poses while spatial runs in the scene) and no contention for the
 * cores: it times the worker's own work on recorded inputs. Results go to --output; recordings are large (keep them
 * out of the repo; tests/results/ is not committed).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { isCli, parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const UPLOAD_PATH = '/__weed_replay/chunk';
const D8_DEFAULT = 'D:/perf-tools/v8/release/v8.exe';

const stamp = () => new Date().toTimeString().slice(0, 8);

// ---------------------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------------------

function sorted(a) {
  return Float64Array.from(a).sort();
}
function quantile(s, q) {
  if (s.length === 0) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
function medianOf(values) {
  const s = sorted(values);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : NaN;
}
/** Pearson correlation of two equal-length series. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}
/** The lag in [2, maxLag] with the strongest autocorrelation, and its value. */
export function strongestLag(series, maxLag = 64) {
  let best = { lag: 0, r: -Infinity };
  for (let lag = 2; lag <= Math.min(maxLag, series.length >> 1); lag++) {
    const r = correlation(series.slice(0, series.length - lag), series.slice(lag));
    if (r > best.r) best = { lag, r };
  }
  return { lag: best.lag, r: Number.isFinite(best.r) ? Math.round(best.r * 100) / 100 : null };
}
/** Summary of a frame series (already past the warm-up). */
export function seriesStats(series, longMs) {
  const s = sorted(series);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    frames: series.length,
    mean: r3(mean(series)),
    p50: r3(quantile(s, 0.5)),
    p95: r3(quantile(s, 0.95)),
    p99: r3(quantile(s, 0.99)),
    max: r3(s[s.length - 1]),
    over16: series.filter((v) => v >= 16).length,
    ...(longMs ? { overLong: series.filter((v) => v >= longMs).length, longMs: r3(longMs) } : {}),
    periodic: strongestLag(series),
  };
}
/** Every frame's median over passes: passes is [pass][frame]. */
export function perFrameMedian(passes) {
  const F = passes[0].length;
  const out = new Array(F);
  const col = new Array(passes.length);
  for (let f = 0; f < F; f++) {
    for (let p = 0; p < passes.length; p++) col[p] = passes[p][f];
    out[f] = medianOf(col);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------------------------------------------

async function record(args) {
  const worker = String(args.worker || 'spatial');
  if (worker !== 'spatial') throw new Error(`--worker ${worker}: only spatial records so far`);
  const dir = path.resolve(String(args.record));
  const frames = Number(args.frames ?? 600);
  const warmupMs = Number(args['warmup-ms'] ?? 12000);
  const chunkFrames = Number(args['chunk-frames'] ?? 20);
  const sceneModule = String(args.scene ?? '/demos/predatorScene/predatorScene.js');
  const sceneExport = String(args['scene-export'] ?? 'PredatorScene');
  const query = typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '';

  const { chromium } = await import('playwright');
  const { createStaticBenchmarkServer } = await import('../helpers/createStaticBenchmarkServer.mjs');
  const { benchWindowArgs, rememberBenchWindow } = await import('./benchWindow.mjs');
  const { ensureRevWorktree } = await import('./revWorktree.mjs');
  const { createReplayEncoder } = await import('./replayCodec.mjs');
  const { spatialRecorderInWorker } = await import('./spatialReplay.mjs');

  const wt = ensureRevWorktree(String(args.rev ?? 'HEAD'), { tag: 'replay-rec', srcOnly: false, workloadCounts: false });
  console.log(`[${stamp()}] serving ${wt.root} at ${wt.sha.slice(0, 8)}`);
  const chunks = new Map();
  const server = await createStaticBenchmarkServer(wt.root, 0, {
    routes: {
      [UPLOAD_PATH]: (body) => {
        const colon = body.indexOf(':');
        const id = Number(body.slice(0, colon));
        chunks.set(id, Buffer.from(body.slice(colon + 1), 'base64'));
        return { ok: true, id };
      },
    },
  });
  const url =
    `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1` +
    `&scene=${sceneModule}&sceneExport=${sceneExport}` + (query ? `&${query}` : '');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--enable-webgpu-developer-features',
      '--enable-dawn-features=allow_unsafe_apis',
      // As runIntegratedWorkerBenchmark: a covered window is not throttled (review M9).
      ...(process.platform === 'win32' ? ['--disable-features=CalculateNativeWinOcclusion'] : []),
      '--mute-audio',
      ...benchWindowArgs(),
    ],
  });
  let meta;
  let rec;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(120000);
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(
      (s) =>
        window.__WEED_BENCHMARK__.prepare({
          warmupMs: 1000,
          durationMs: 1000,
          sampleIntervalMs: 250,
          sceneModule: s.sceneModule,
          sceneExport: s.sceneExport,
          collectDetailedStats: false,
          collectGpuStats: false,
        }),
      { sceneModule, sceneExport },
    );
    console.log(`[${stamp()}] warm-up ${warmupMs} ms`);
    await page.waitForTimeout(warmupMs);
    const target = page.workers().find((w) => /\/spatialWorker\.js/.test(w.url()));
    if (!target) throw new Error(`no spatial worker among ${page.workers().map((w) => w.url()).join(', ')}`);
    meta = await target.evaluate(spatialRecorderInWorker, {
      frames,
      chunkFrames,
      encoderSource: createReplayEncoder.toString(),
      uploadPath: UPLOAD_PATH,
      srcBase: new URL('/src/', target.url()).href,
    });
    console.log(`[${stamp()}] recording ${frames} frames of ${meta.n} entities, ${meta.columns.length} columns`);
    const deadline = Date.now() + 60000 + frames * 200;
    for (;;) {
      await page.waitForTimeout(500);
      rec = await target.evaluate(() => {
        const r = self.__weedReplayRecorder;
        return r.done
          ? { ...r }
          : { frames: r.frames, done: false, error: r.error, bytes: r.bytes, chunks: r.chunks, acked: r.acked };
      });
      if (rec.error) throw new Error(`recorder: ${rec.error}`);
      if (rec.done) break;
      if (Date.now() > deadline) throw new Error(`recording stalled at frame ${rec.frames}`);
      process.stdout.write(`\r  frame ${rec.frames}/${frames}, ${(rec.bytes / 1048576).toFixed(0)} MB, chunks ${rec.acked}/${rec.chunks}   `);
    }
    process.stdout.write('\n');
    await rememberBenchWindow(page);
  } finally {
    await browser.close();
    await server.close();
  }
  const ids = [...chunks.keys()].sort((a, b) => a - b);
  if (ids.length !== rec.chunks || ids.some((id, i) => id !== i)) throw new Error(`chunks received ${ids.join(',')} of ${rec.chunks}`);
  const raw = Buffer.concat(ids.map((id) => chunks.get(id)));
  fs.mkdirSync(dir, { recursive: true });
  const gz = zlib.gzipSync(raw, { level: 6 });
  fs.writeFileSync(path.join(dir, 'frames.bin.gz'), gz);
  const live = rec.live.map((v) => Math.round(v * 1000) / 1000);
  const fullMeta = {
    ...meta,
    movedBound: rec.movedBound === true,
    recordedAt: new Date().toISOString(),
    scene: sceneModule,
    sceneExport,
    query,
    warmupMs,
    frames,
    rev: wt.sha,
    rawBytes: raw.length,
    live,
    clock: rec.clock.map((v) => Math.round((v - rec.clock[0]) * 1000) / 1000),
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(fullMeta) + '\n');
  const st = seriesStats(live);
  console.log(
    `[${stamp()}] wrote ${dir}: ${frames} frames, ${(raw.length / 1048576).toFixed(1)} MB raw, ` +
      `${(gz.length / 1048576).toFixed(1)} MB gzip; live update() ms mean ${st.mean} p50 ${st.p50} p95 ${st.p95} ` +
      `p99 ${st.p99} max ${st.max}, ${st.over16} frames >= 16 ms, strongest lag ${st.periodic.lag} (r ${st.periodic.r})`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------------------------

/** The frame stream as one 8-aligned buffer (records hold f64 and int32 views). */
function readAligned(file) {
  const b = fs.readFileSync(file);
  if (b.byteOffset % 8 === 0) return new Uint8Array(b.buffer, b.byteOffset, b.length);
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

/** One side's process: `--side` (internal), in this tree or a rev worktree's copy of this script. */
async function side(args) {
  const meta = JSON.parse(fs.readFileSync(String(args.meta), 'utf8'));
  const bytes = readAligned(String(args.raw));
  const { runSpatialReplay } = await import('./spatialReplay.mjs');
  const out = await runSpatialReplay(meta, bytes, {
    rounds: Number(args.rounds ?? 2),
    check: !args['no-check'],
    workers: args.workers ? Number(args.workers) : undefined,
    log: (s) => console.log(`  [${stamp()}] ${s}`),
  });
  out.engine = `node ${process.version}`;
  fs.writeFileSync(String(args.result), JSON.stringify(out) + '\n');
}

function runSideProcess({ root, label, metaFile, rawFile, rounds, workers, check, d8, resultFile }) {
  const t0 = Date.now();
  if (d8) {
    const exe = process.env.WEED_D8 || D8_DEFAULT;
    // Forward slashes: d8 resolves the entry's relative imports against this path.
    const entry = path.join(root, 'tests', 'bench', 'replayD8Entry.mjs').split(path.sep).join('/');
    const opts = JSON.stringify({ meta: metaFile, raw: rawFile, rounds, workers, check });
    const r = spawnSync(exe, ['--expose-gc', entry, '--', opts], { encoding: 'utf8', maxBuffer: 1 << 30, cwd: root });
    const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('REPLAY_RESULT '));
    for (const l of (r.stdout || '').split(/\r?\n/)) if (l && !l.startsWith('REPLAY_RESULT ')) console.log(`  ${l}`);
    if (r.status !== 0 || !line) throw new Error(`d8 side ${label} failed (${r.status}): ${(r.stderr || '').slice(-2000)}`);
    const out = JSON.parse(line.slice('REPLAY_RESULT '.length));
    out.engine = `d8 ${exe}`;
    console.log(`  [${stamp()}] ${label}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return out;
  }
  const script = path.join(root, 'tests/bench/replayWorker.mjs');
  const argv = ['--expose-gc', script, '--side', '--meta', metaFile, '--raw', rawFile, '--rounds', String(rounds), '--result', resultFile];
  if (workers) argv.push('--workers', String(workers));
  if (!check) argv.push('--no-check');
  const r = spawnSync(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'], cwd: root });
  if (r.status !== 0) throw new Error(`side ${label} failed (${r.status})`);
  const out = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  fs.rmSync(resultFile, { force: true });
  console.log(`  [${stamp()}] ${label}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return out;
}

async function replay(args) {
  const dir = path.resolve(String(args.replay));
  const metaFile = path.join(dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const rounds = Number(args.rounds ?? 2);
  const warmup = Number(args.warmup ?? 60);
  const pairs = args.vs ? Number(args.pairs ?? 4) : Number(args.pairs ?? 1);
  const workers = args.workers ? Number(args.workers) : 0;
  const d8 = Boolean(args.d8);
  const check = !args['no-check'];
  const { ensureRevWorktree } = await import('./revWorktree.mjs');

  // The frames once, decompressed beside the recording for the side processes (removed at the end).
  const rawFile = path.join(dir, `.frames-${process.pid}.raw`);
  fs.writeFileSync(rawFile, zlib.gunzipSync(fs.readFileSync(path.join(dir, 'frames.bin.gz'))));
  const cleanup = () => fs.rmSync(rawFile, { force: true });
  process.on('exit', cleanup);

  const sideOf = (rev, tag) => {
    if (!rev) return { label: 'tree', rev: null, sha: null, root: repoRoot };
    const wt = ensureRevWorktree(String(rev), { tag, srcOnly: true, workloadCounts: false });
    return { label: String(rev), rev: String(rev), sha: wt.sha, root: wt.root };
  };
  const B = sideOf(args.rev, 'replay-b');
  const A = args.vs ? sideOf(args.vs, 'replay-a') : null;
  const sides = A ? [A, B] : [B];
  for (const s of sides) {
    s.processes = [];
    console.log(`[${stamp()}] side ${s.label}${s.sha ? ` (${s.sha.slice(0, 8)})` : ''}: ${s.root}`);
  }
  try {
    for (let p = 0; p < pairs; p++) {
      for (const s of sides) {
        console.log(`[${stamp()}] pair ${p + 1}/${pairs}: ${s.label}`);
        s.processes.push(
          runSideProcess({
            root: s.root,
            label: s.label,
            metaFile,
            rawFile,
            rounds,
            workers,
            check: check && p === 0,
            d8,
            resultFile: path.join(dir, `.result-${process.pid}.json`),
          }),
        );
      }
    }
  } finally {
    cleanup();
  }

  const W = sides[0].processes[0].workers;
  const F = sides[0].processes[0].frames;
  const from = Math.min(warmup, F - 1);
  const live = (meta.live || []).slice(from);
  const report = {
    feature: `${meta.worker}-replay`,
    recording: { dir, scene: meta.sceneExport, query: meta.query, frames: F, rev: meta.rev, recordedAt: meta.recordedAt, n: meta.n },
    engine: sides[0].processes[0].engine,
    warmup: from,
    rounds,
    pairs,
    liveStats: live.length ? seriesStats(live) : null,
    sides: [],
  };
  let baseP50 = null;
  for (const s of sides) {
    const sideOut = { label: s.label, sha: s.sha, workers: [] };
    for (let w = 0; w < W; w++) {
      const passes = s.processes.flatMap((pr) => pr.timed.map((t) => t.times[w]));
      const frameMedian = perFrameMedian(passes).slice(from);
      if (baseP50 === null) baseP50 = quantile(sorted(frameMedian), 0.5);
      const perProcess = s.processes.map((pr) => mean(perFrameMedian(pr.timed.map((t) => t.times[w])).slice(from)));
      sideOut.workers.push({
        worker: w,
        stats: seriesStats(frameMedian, 2 * baseP50),
        processMeans: perProcess.map((v) => Math.round(v * 1000) / 1000),
        liveCorrelation: live.length ? Math.round(correlation(frameMedian, live) * 100) / 100 : null,
        series: frameMedian.map((v) => Math.round(v * 1000) / 1000),
      });
    }
    const chk = s.processes[0].check;
    if (chk) {
      sideOut.check = {
        finalHash: chk.finalHash,
        rebuiltPerFrame: Math.round(mean(chk.counters.rebuilt.slice(from)) * 10) / 10,
        publishedPerFrame: Math.round(mean(chk.counters.published.slice(from)) * 10) / 10,
        moversFrames: chk.counters.movers.slice(from).filter(Boolean).length,
        hashes: chk.hashes,
      };
    }
    sideOut.deterministic = s.processes.every((pr) => pr.timed.every((t) => t.finalHash === s.processes[0].timed[0].finalHash));
    report.sides.push(sideOut);
  }
  if (A) {
    const [a, b] = report.sides;
    report.compare = a.workers.map((wa, w) => {
      const wb = b.workers[w];
      const deltas = wa.processMeans.map((m, i) => Math.round((100 * (wb.processMeans[i] / m - 1)) * 10) / 10);
      return {
        worker: w,
        meanDeltaPct: Math.round(100 * (wb.stats.mean / wa.stats.mean - 1) * 10) / 10,
        pairDeltasPct: deltas,
        pairsWorse: deltas.filter((d) => d > 0).length,
        p95DeltaPct: Math.round(100 * (wb.stats.p95 / wa.stats.p95 - 1) * 10) / 10,
        p99DeltaPct: Math.round(100 * (wb.stats.p99 / wa.stats.p99 - 1) * 10) / 10,
        overLong: [wa.stats.overLong, wb.stats.overLong],
      };
    });
    if (a.check && b.check) {
      let differ = 0;
      let first = -1;
      for (let f = 0; f < a.check.hashes.length; f++) {
        if (a.check.hashes[f] !== b.check.hashes[f]) {
          differ++;
          if (first < 0) first = f;
        }
      }
      report.rows = { framesDiffering: differ, firstDifferingFrame: first, of: a.check.hashes.length };
    }
  }

  // Console summary.
  const fmt = (st) =>
    `mean ${st.mean.toFixed(3)} p50 ${st.p50.toFixed(3)} p95 ${st.p95.toFixed(3)} p99 ${st.p99.toFixed(3)} max ${st.max.toFixed(3)}` +
    ` >=16ms ${st.over16} >=${st.longMs?.toFixed(1)}ms ${st.overLong} lag ${st.periodic.lag} (r ${st.periodic.r})`;
  if (report.liveStats) console.log(`live (scene, recorded): ${fmt({ ...report.liveStats, longMs: NaN, overLong: '-' })}`);
  for (const s of report.sides) {
    for (const w of s.workers) {
      console.log(`${s.label} worker ${w.worker}: ${fmt(w.stats)}; process means ${w.processMeans.join(', ')}; vs live r ${w.liveCorrelation}`);
    }
    if (s.check) console.log(`  rows ${s.check.finalHash.toString(16)}, rebuilt/frame ${s.check.rebuiltPerFrame}, published/frame ${s.check.publishedPerFrame}, deterministic ${s.deterministic}`);
  }
  if (report.compare) {
    for (const c of report.compare) {
      console.log(
        `compare worker ${c.worker}: mean ${c.meanDeltaPct > 0 ? '+' : ''}${c.meanDeltaPct} %, pairs ${c.pairDeltasPct.join(', ')} % (${c.pairsWorse}/${c.pairDeltasPct.length} worse), ` +
          `p95 ${c.p95DeltaPct} %, p99 ${c.p99DeltaPct} %, long frames ${c.overLong.join(' -> ')}`,
      );
    }
    if (report.rows) console.log(`rows: ${report.rows.framesDiffering}/${report.rows.of} frames differ (first ${report.rows.firstDifferingFrame})`);
  }
  if (args.output) {
    const out = path.resolve(String(args.output));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }) + '\n');
    console.log(`wrote ${out}`);
  }
  return report;
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  if (args.side) await side(args);
  else if (args.record) await record(args);
  else if (args.replay) await replay(args);
  else {
    console.error('usage: replayWorker.mjs --record <dir> [...] | --replay <dir> [--rev <sha>] [--vs <sha>] (see the header)');
    process.exitCode = 2;
  }
}

