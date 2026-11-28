#!/usr/bin/env node
/**
 * E-492: what the entity batch's keyed frames scatter into its statics texture, by kind, and how much of it the texture
 * already held. Opens a scene (source tree, headed Chrome on the real GPU), installs a hook in Pixi's worker as soon as
 * the keyed batch exists, and from then on mirrors the statics texture on the CPU from every scatter it sees (the full
 * updates in order, then the texture updates, as staticsScatterGl.js and staticsScatterGpu.js land them). Over the
 * recorded window, each update is counted by kind, from its key and its queue row's type:
 *   - keyed: sprite (type 0), decoration (2), keyedParticle (1: a LiquidFun particle's, by its index); keyless (a key at
 *     or past keyBase, its draw slot's): particle (1), glow (3), bullet (4), trail (5), other;
 *   - texture updates (GPU_KEYED_TEX_WORDS): spriteTex (by the same keys);
 * and, against the mirror, whether it changed the texture's words ("changed"), wrote what was there ("same"; of these,
 * "samePrev" were sent by the keyed frame before too), or hit a key the mirror had not seen yet ("unknown": the hook
 * came after its last update). A full update that changed only the texture word counts in "texWordOnly" too, and a
 * keyless one that changed its slot's words to words some keyless row sent the keyed frame before in "movedOnly" (its
 * slot, its draw slot, moved: a key of its own would have sent nothing; a hash of the words, so a guess). GPU-particle
 * proxies (gpuParticleProxies.js) are groups drawn in the entity batch's gaps: they have no queue row and no statics, so
 * they never reach this scatter.
 *
 * `--mode time` installs only the timers: the scatter call's CPU time (Pixi's worker), the keyed upload's
 * (_uploadKeyed: the pack, the copies, the scatter, the poses) and, on WebGL where EXT_disjoint_timer_query_webgl2 is
 * exposed, the scatter draw's GPU time (a TIME_ELAPSED query around it). A probe, not a sitting: the hook and the
 * mirror take Pixi's time in the count mode, so read its counts there and its times in the time mode.
 *
 *   node tests/bench/keyedScatterProbe.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene \
 *     --query crowd=2.5 --query zoom=1 --query hour=22 [--query backend=webgpu] [--mode count|time] [--skip-ms 10000]
 *     [--record-ms 10000] [--output path.json]
 * From Git Bash set MSYS_NO_PATHCONV=1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Runs in Pixi's worker: the hook, once its keyed batch exists. 'wait' until then. */
function installInWorker({ mode }) {
  const px = self.pixiRenderer;
  const b = px && px.entitiesBatch;
  if (!b || !b.keyed || !b._statics || typeof b._statics.scatter !== 'function') return 'wait';
  if (self.__e492Probe) return 'installed';
  const keyBase = b._keyedPack.keyBase >>> 0;
  const cap = b.capacity | 0;
  const keys = keyBase + cap;
  const counting = mode !== 'time';
  const KINDS = ['sprite', 'decoration', 'keyedParticle', 'keyedOther', 'particle', 'glow', 'bullet', 'trail', 'keylessOther', 'spriteTex', 'unrowed'];
  const kindOf = (key, type) => {
    if (type < 0) return 10;
    if (key < keyBase) return type === 0 ? 0 : type === 2 ? 1 : type === 1 ? 2 : 3;
    return type === 1 ? 4 : type === 3 ? 5 : type === 4 ? 6 : type === 5 ? 7 : 8;
  };
  const z = () => new Float64Array(KINDS.length);
  const P = {
    mode, keyBase, cap, kinds: KINDS, recording: false,
    frames: 0, keyedFrames: 0, scatterFrames: 0, pauses: 0, pausedFrames: 0, splitFrames: 0,
    sent: z(), changed: z(), same: z(), samePrev: z(), unknown: z(), texWordOnly: z(), movedOnly: z(),
    updates: 0, texUpdates: 0, drawn: 0,
    scatterMs: 0, uploadMs: 0, uploadFrames: 0, gpuNs: 0, gpuQueries: 0, gpuDisjoint: 0, gpuTimer: false,
    perFrame: [],
    q: null, ctx: null,
  };
  self.__e492Probe = P;
  const mirror = counting ? new Uint32Array(keys * 12) : new Uint32Array(0);
  const known = counting ? new Uint8Array(keys) : new Uint8Array(0);
  // The keyed frame (P.keyedFrames before it) each key was last sent in, and this frame's key -> queue row.
  const lastSent = counting ? new Int32Array(keys).fill(-2) : new Int32Array(0);
  const rowStamp = counting ? new Int32Array(keys).fill(-1) : new Int32Array(0);
  const rowOf = counting ? new Int32Array(keys) : new Int32Array(0);
  const slotFloats = cap > 0 ? Math.max(1, Math.round(b._sharedSlots.length / cap)) : 1;
  // A keyless row's slot is its draw slot, which moves whenever a row before it comes or goes: the hashes of the words
  // the keyless rows sent last keyed frame, so a changed one whose words some row sent then counts as "movedOnly" (the
  // same statics at another slot: what a key of its own would not have sent).
  let prevHashes = new Set();
  let hashes = new Set();
  const hashWords = (U, at) => {
    let h = 2166136261;
    for (let w = 0; w < 12; w++) h = Math.imul(h ^ U[at + w], 16777619);
    return h >>> 0;
  };
  const gl = px.pixiApp && px.pixiApp.renderer && px.pixiApp.renderer.gl;
  const timer = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  P.gpuTimer = !!timer;
  const pending = [];
  const pollQueries = () => {
    while (pending.length > 0) {
      const qy = pending[0];
      if (!gl.getQueryParameter(qy.query, gl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(qy.query, gl.QUERY_RESULT);
      gl.deleteQuery(qy.query);
      if (!qy.recording) continue;
      if (disjoint) P.gpuDisjoint++;
      else {
        P.gpuNs += ns;
        P.gpuQueries++;
      }
    }
  };

  const origUpload = b._uploadKeyed;
  b._uploadKeyed = function probeUploadKeyed(q, ctx) {
    P.q = q;
    P.ctx = ctx;
    const pausedBefore = this._keyPause;
    const t0 = performance.now();
    const r = origUpload.call(this, q, ctx);
    const dt = performance.now() - t0;
    if (P.recording) {
      P.frames++;
      if (r >= 0) {
        P.keyedFrames++;
        P.uploadMs += dt;
        P.uploadFrames++;
        P.drawn += r;
        if (this._keyPause > 0) P.pausedFrames++;
        if (pausedBefore === 0 && this._keyPause > 0) P.pauses++;
      } else {
        P.splitFrames++;
      }
    }
    if (timer) pollQueries();
    return r;
  };

  const statics = b._statics;
  const origScatter = statics.scatter;
  statics.scatter = function probeScatter(source, U, n, width, height, T, nt) {
    if (counting) {
      const q = P.q;
      const ctx = P.ctx;
      const type = q && q.type ? q.type : null;
      const f = P.keyedFrames;
      const rec = P.recording;
      if (ctx && type) {
        const slots = b._sharedSlots;
        const m = Math.min(ctx.scanCount | 0, cap);
        const idx = ctx.useIndices ? ctx.indices : null;
        for (let k = 0; k < m; k++) {
          const key = slots[k * slotFloats] >>> 0;
          if (key >= keys) continue;
          rowStamp[key] = f;
          rowOf[key] = idx ? idx[k] : k;
        }
      }
      for (let j = 0; j < n; j++) {
        const at = j * 16;
        const key = U[at + 12] >>> 0;
        if (key >= keys) continue;
        const row = type && rowStamp[key] === f ? rowOf[key] : -1;
        const kind = kindOf(key, row >= 0 ? type[row] : -1);
        const mAt = key * 12;
        let diff = 0;
        let texOnly = true;
        for (let w = 0; w < 12; w++) {
          if (mirror[mAt + w] !== U[at + w]) {
            diff++;
            if (w !== 6) texOnly = false;
          }
        }
        const keyless = key >= keyBase;
        const hash = keyless ? hashWords(U, at) : 0;
        if (keyless) hashes.add(hash);
        if (rec) {
          P.sent[kind]++;
          if (!known[key]) P.unknown[kind]++;
          else if (diff === 0) {
            P.same[kind]++;
            if (lastSent[key] === f - 1) P.samePrev[kind]++;
          } else {
            P.changed[kind]++;
            if (texOnly) P.texWordOnly[kind]++;
            if (keyless && prevHashes.has(hash)) P.movedOnly[kind]++;
          }
        }
        for (let w = 0; w < 12; w++) mirror[mAt + w] = U[at + w];
        known[key] = 1;
        lastSent[key] = f;
      }
      const t = prevHashes;
      prevHashes = hashes;
      hashes = t;
      hashes.clear();
      for (let j = 0; j < nt; j++) {
        const key = T[j * 2] >>> 0;
        if (key >= keys) continue;
        const word = T[j * 2 + 1] >>> 0;
        const kind = 9;
        if (rec) {
          P.sent[kind]++;
          if (!known[key]) P.unknown[kind]++;
          else if (mirror[key * 12 + 6] === word) {
            P.same[kind]++;
            if (lastSent[key] === f - 1) P.samePrev[kind]++;
          } else P.changed[kind]++;
        }
        mirror[key * 12 + 6] = word;
        lastSent[key] = f;
      }
    }
    let query = null;
    if (timer && P.recording) {
      query = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    }
    const t0 = performance.now();
    const r = origScatter.call(this, source, U, n, width, height, T, nt);
    const dt = performance.now() - t0;
    if (query) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push({ query, recording: true });
    }
    if (P.recording) {
      P.scatterFrames++;
      P.scatterMs += dt;
      P.updates += n;
      P.texUpdates += nt;
      if (P.perFrame.length < 4000) P.perFrame.push(n, nt);
    }
    return r;
  };
  return 'installed';
}

function setRecording({ on }) {
  const P = self.__e492Probe;
  if (!P) return false;
  P.recording = on;
  return true;
}

function readInWorker() {
  const P = self.__e492Probe;
  if (!P) return null;
  const px = self.pixiRenderer;
  const out = {
    mode: P.mode,
    backend: px && px._useWebGpu ? 'webgpu' : 'webgl',
    keyBase: P.keyBase,
    capacity: P.cap,
    frames: P.frames,
    keyedFrames: P.keyedFrames,
    splitFrames: P.splitFrames,
    pausedFrames: P.pausedFrames,
    pauses: P.pauses,
    scatterFrames: P.scatterFrames,
    drawnPerKeyedFrame: P.keyedFrames > 0 ? P.drawn / P.keyedFrames : 0,
    updatesPerScatter: P.scatterFrames > 0 ? P.updates / P.scatterFrames : 0,
    texUpdatesPerScatter: P.scatterFrames > 0 ? P.texUpdates / P.scatterFrames : 0,
    scatterMsPerFrame: P.scatterFrames > 0 ? P.scatterMs / P.scatterFrames : 0,
    uploadKeyedMsPerFrame: P.uploadFrames > 0 ? P.uploadMs / P.uploadFrames : 0,
    gpuTimer: P.gpuTimer,
    gpuScatterMsPerFrame: P.gpuQueries > 0 ? P.gpuNs / P.gpuQueries / 1e6 : null,
    gpuQueries: P.gpuQueries,
    gpuDisjoint: P.gpuDisjoint,
    byKind: {},
  };
  const f = P.scatterFrames > 0 ? P.scatterFrames : 1;
  for (let k = 0; k < P.kinds.length; k++) {
    if (P.sent[k] === 0) continue;
    out.byKind[P.kinds[k]] = {
      sentPerFrame: +(P.sent[k] / f).toFixed(1),
      changedPerFrame: +(P.changed[k] / f).toFixed(1),
      samePerFrame: +(P.same[k] / f).toFixed(1),
      samePrevPerFrame: +(P.samePrev[k] / f).toFixed(1),
      unknownPerFrame: +(P.unknown[k] / f).toFixed(1),
      texWordOnlyPerFrame: +(P.texWordOnly[k] / f).toFixed(1),
      movedOnlyPerFrame: +(P.movedOnly[k] / f).toFixed(1),
    };
  }
  out.perFrameSample = P.perFrame.slice(0, 120);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { query: [], mode: 'count', skipMs: 10000, recordMs: 10000, output: null, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scene') opts.scene = argv[++i];
    else if (a === '--scene-export') opts.sceneExport = argv[++i];
    else if (a === '--query') opts.query.push(argv[++i]);
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--skip-ms') opts.skipMs = Number(argv[++i]);
    else if (a === '--record-ms') opts.recordMs = Number(argv[++i]);
    else if (a === '--output') opts.output = argv[++i];
    else if (a === '--headless') opts.headless = true;
  }
  if (!opts.scene || !opts.sceneExport) throw new Error('usage: --scene <path> --scene-export <Class> [--query k=v]');
  const server = await createStaticBenchmarkServer(repoRoot);
  const browser = await chromium.launch({ headless: opts.headless, args: ['--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const params = new URLSearchParams('src=1');
    for (const pair of opts.query) {
      for (const part of pair.split('&')) {
        const [k, v = ''] = part.split('=');
        params.set(k, v);
      }
    }
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    const total = opts.skipMs + opts.recordMs + 5000;
    const prepared = page.evaluate(({ scene, sceneExport, total }) => window.__WEED_BENCHMARK__.prepare({
      warmupMs: total, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport, canvasWidth: 1280, canvasHeight: 720,
    }), { scene: opts.scene, sceneExport: opts.sceneExport, total });
    prepared.catch((err) => errors.push(String(err)));
    // A worker blocked in Atomics.wait for good (the physics pthread pool's) never answers: a timeout a worker.
    const ask = async (w, fn, arg) => Promise.race([
      w.evaluate(fn, arg).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    let pixi = null;
    const t0 = Date.now();
    while (pixi === null && Date.now() - t0 < 90000) {
      for (const w of page.workers()) {
        const r = await ask(w, installInWorker, { mode: opts.mode });
        if (r === 'installed') {
          pixi = w;
          break;
        }
      }
      if (pixi === null) await page.waitForTimeout(100);
    }
    if (pixi === null) throw new Error('no keyed entity batch in any worker after 90 s');
    const installedAt = Date.now() - t0;
    await page.waitForTimeout(opts.skipMs);
    await ask(pixi, setRecording, { on: true });
    await page.waitForTimeout(opts.recordMs);
    await ask(pixi, setRecording, { on: false });
    const result = await ask(pixi, readInWorker);
    const report = { scene: opts.sceneExport, query: opts.query, mode: opts.mode, installedAtMs: installedAt, skipMs: opts.skipMs, recordMs: opts.recordMs, result, errors: errors.slice(0, 10) };
    const text = JSON.stringify(report, null, 1);
    if (opts.output) fs.writeFileSync(opts.output, text);
    console.log(text);
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
