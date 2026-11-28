#!/usr/bin/env node
/**
 * E-562: which GPU buffers the Pixi worker writes each frame, how many bytes, and how many of them changed. Opens a scene
 * (source tree, headed Chrome on the real GPU), installs a hook in Pixi's worker once its renderer runs, and from then on
 * sees every buffer upload:
 *   - WebGPU: device.queue.writeBuffer (Pixi's GpuBufferSystem.updateBuffer, its uniform batch's direct writes, and the
 *     engine's own: staticsScatterGpu, computeLayer), and queue.writeTexture as context (texels and bytes by label);
 *   - WebGL: gl.bufferSubData and gl.bufferData, the buffer read from the target's binding.
 * Each GPU buffer is named by where it hangs in the engine's objects (a breadth-first walk from self.pixiRenderer, then
 * from Pixi's renderer for what the engine does not hold: `px.entitiesBatch._buffers[0]`, `...uniformBatch._buffers[1]`);
 * a uniform group's buffer reads `<group path>.buffer`. A buffer the walk never reached is named by its label and the
 * first frames of the stack that wrote it. The first write of each buffer while recording keeps a short stack too.
 *
 * `--mode count` (the default) keeps a copy of every buffer as last written from the CPU and compares each write with
 * it, word by word: per frame and buffer, the bytes written, the bytes that changed, and the span from the first changed
 * word to the last (the least one write of the changed range would send); words never written before count as
 * "unknown", not changed (a buffer made with its data is filled at creation, not by a write). `--mode time` only times
 * each write's call (performance.now around it; 5 us steps in an isolated worker, so a sum over many calls). A probe,
 * not a sitting: the compare takes Pixi's time in the count mode, so read its bytes there and its times in the time mode.
 *
 *   node tests/bench/bufferUploadProbe.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene \
 *     --query light3d=1 --query crowd=2.5 [--query backend=webgpu] [--mode count|time] [--skip-ms 10000]
 *     [--record-ms 8000] [--top 40] [--output path.json]
 * From Git Bash set MSYS_NO_PATHCONV=1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Runs in Pixi's worker: the hook, once Pixi's renderer has drawn. 'wait' until then. */
function installInWorker({ mode }) {
  const px = self.pixiRenderer;
  const renderer = px && px.pixiApp && px.pixiApp.renderer;
  if (!renderer || !(px.frameNumber > 10)) return 'wait';
  if (self.__e562Probe) return 'installed';
  const webgpu = !!px._useWebGpu;
  const uid = renderer.uid;
  const counting = mode !== 'time';
  const P = {
    mode, backend: webgpu ? 'webgpu' : 'webgl', recording: false,
    frameStart: 0, frameEnd: 0, writeFrames: 0, lastWriteFrame: -1,
    scans: 0, scanMs: 0, scanNodes: 0, lastScanFrame: -1000,
    entries: new Map(), textures: new Map(),
    names: new Map(), pendingBuffers: [], pendingGroups: [],
  };
  self.__e562Probe = P;

  // Keys never followed: back-references into Pixi or the worker, GPU handles, listeners.
  const SKIP = new Set(['_renderer', 'renderer', '_events', '_eventsCount', '_gpuData', 'worker', '_worker', 'selfRef',
    'canvas', 'gl', '_gl', 'gpu', '_gpu', 'device', '_device', 'context', '_context', 'parent', '_parent', 'pixiApp',
    'stage', 'PIXI']);
  const handleOf = (buf) => {
    const g = buf && buf._gpuData ? buf._gpuData[uid] : null;
    if (!g) return null;
    return webgpu ? g.gpuBuffer || null : g.buffer || null;
  };
  const noteBuffer = (buf, where) => {
    const h = handleOf(buf);
    if (h) {
      if (!P.names.has(h)) P.names.set(h, { path: where, label: (buf.descriptor && buf.descriptor.label) || '', buf });
    } else P.pendingBuffers.push(buf, where);
  };
  const isBulk = (o) => ArrayBuffer.isView(o) || o instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== 'undefined' && o instanceof SharedArrayBuffer);
  const scan = () => {
    const t0 = performance.now();
    const seen = new Set();
    const queue = [];
    const push = (o, where) => {
      if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return;
      if (seen.has(o) || isBulk(o)) return;
      seen.add(o);
      queue.push(o, where);
    };
    P.pendingBuffers.length = 0;
    P.pendingGroups.length = 0;
    push(px, 'px');
    let nodes = 0;
    let head = 0;
    const drain = () => {
      for (; head < queue.length && nodes < 600000; head += 2) {
        const o = queue[head];
        const where = queue[head + 1];
        nodes++;
        if (o._resourceType === 'buffer' && o._gpuData) noteBuffer(o, where);
        else if (o._resourceType === 'uniformGroup') {
          if (o.buffer) noteBuffer(o.buffer, where + '.buffer');
          else P.pendingGroups.push(o, where + '.buffer');
        }
        if (o instanceof Map || o instanceof Set) {
          let k = 0;
          for (const v of o.values()) {
            push(v, `${where}<${k}>`);
            if (++k >= 20000) break;
          }
          continue;
        }
        if (Array.isArray(o)) {
          for (let k = 0; k < o.length && k < 20000; k++) push(o[k], `${where}[${k}]`);
          continue;
        }
        let keys;
        try {
          keys = Object.keys(o);
        } catch {
          continue;
        }
        for (let k = 0; k < keys.length; k++) {
          const key = keys[k];
          if (SKIP.has(key)) continue;
          let v;
          try {
            v = o[key];
          } catch {
            continue;
          }
          push(v, `${where}.${key}`);
        }
      }
    };
    drain();
    // What the engine does not hold: Pixi's own (its uniform batch, the global uniforms, its pipes' buffers).
    push(renderer, 'pixi');
    drain();
    P.scans++;
    P.scanNodes = nodes;
    P.scanMs += performance.now() - t0;
    P.lastScanFrame = px.frameNumber;
  };
  const resolvePending = (h) => {
    const pb = P.pendingBuffers;
    for (let i = 0; i < pb.length; i += 2) {
      if (handleOf(pb[i]) === h) {
        P.names.set(h, { path: pb[i + 1], label: (pb[i].descriptor && pb[i].descriptor.label) || '', buf: pb[i] });
        return true;
      }
    }
    const pg = P.pendingGroups;
    for (let i = 0; i < pg.length; i += 2) {
      if (pg[i].buffer && handleOf(pg[i].buffer) === h) {
        P.names.set(h, { path: pg[i + 1], label: '', buf: pg[i].buffer });
        return true;
      }
    }
    return false;
  };
  const stackHere = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 14;
    const s = String(new Error().stack || '');
    Error.stackTraceLimit = limit;
    return s.split('\n').slice(1).map((l) => l.trim().replace(/^at /, '').replace(/\(?https?:\/\/[^/]+/, '('))
      .filter((l) => !/probe|installInWorker|recordWrite|nameOf|stackHere/.test(l)).slice(0, 6);
  };
  const nameOf = (h) => {
    let n = P.names.get(h);
    if (n) return n;
    if (resolvePending(h)) return P.names.get(h);
    // A buffer made after the last walk: walk again, at most every 60 frames.
    if (px.frameNumber - P.lastScanFrame >= 60) {
      scan();
      n = P.names.get(h);
      if (n) return n;
    }
    const st = stackHere();
    const label = (h && h.label) || '';
    n = { path: `?${label ? ' ' + label : ''} @ ${st.slice(0, 3).join(' < ')}`, label, buf: null };
    P.names.set(h, n);
    return n;
  };

  const newEntry = (h, n) => ({
    path: n.path, label: n.label, size: 0, stack: null,
    calls: 0, bytes: 0, changed: 0, unknown: 0, span: 0, ms: 0, frames: 0,
    curFrame: -1, fMin: -1, fMax: -1,
    mirror: new Uint32Array(0), known: new Uint8Array(0),
    handle: h,
  });
  const closeFrame = (e) => {
    if (e.fMin >= 0) e.span += (e.fMax - e.fMin + 1) * 4;
    e.fMin = -1;
    e.fMax = -1;
  };
  const grow = (e, words) => {
    if (e.mirror.length >= words) return;
    const m = new Uint32Array(Math.max(words, e.mirror.length * 2));
    m.set(e.mirror);
    e.mirror = m;
    const k = new Uint8Array(m.length);
    k.set(e.known);
    e.known = k;
  };

  // One write of `nBytes` from `src` (an ArrayBuffer or SharedArrayBuffer at byte `srcByte`) to the buffer at `dstByte`.
  const recordWrite = (h, dstByte, src, srcByte, nBytes, ms, size) => {
    const frame = px.frameNumber;
    let e = P.entries.get(h);
    if (!e) {
      e = newEntry(h, nameOf(h));
      P.entries.set(h, e);
    }
    if (size > e.size) e.size = size;
    const rec = P.recording;
    if (rec) {
      if (e.stack === null) e.stack = stackHere();
      if (e.curFrame !== frame) {
        closeFrame(e);
        e.curFrame = frame;
        e.frames++;
      }
      e.calls++;
      e.bytes += nBytes;
      e.ms += ms;
      if (P.lastWriteFrame !== frame) {
        P.lastWriteFrame = frame;
        P.writeFrames++;
      }
    }
    if (!counting || nBytes <= 0) return;
    if (((dstByte | srcByte | nBytes) & 3) !== 0) {
      // Not word aligned (none seen so far): counted as changed, the copy left as it was.
      if (rec) e.changed += nBytes;
      return;
    }
    const w0 = dstByte >>> 2;
    const nw = nBytes >>> 2;
    grow(e, w0 + nw);
    const s = new Uint32Array(src, srcByte, nw);
    const m = e.mirror;
    const k = e.known;
    let changed = 0;
    let unknown = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < nw; i++) {
      const v = s[i];
      const at = w0 + i;
      if (k[at] === 0) {
        k[at] = 1;
        m[at] = v;
        unknown++;
      } else if (m[at] !== v) {
        m[at] = v;
        changed++;
        if (first < 0) first = at;
        last = at;
      }
    }
    if (rec) {
      e.changed += changed * 4;
      e.unknown += unknown * 4;
      if (first >= 0) {
        if (e.fMin < 0 || first < e.fMin) e.fMin = first;
        if (last > e.fMax) e.fMax = last;
      }
    }
  };

  if (webgpu) {
    const queue = renderer.gpu.device.queue;
    const origWrite = queue.writeBuffer;
    queue.writeBuffer = function probeWriteBuffer(buffer, bufferOffset, data, dataOffset, size) {
      const view = ArrayBuffer.isView(data);
      const per = view ? data.BYTES_PER_ELEMENT || 1 : 1;
      const src = view ? data.buffer : data;
      const base = view ? data.byteOffset : 0;
      const off = (dataOffset === undefined ? 0 : dataOffset) * per;
      const nBytes = size === undefined ? data.byteLength - off : size * per;
      const t0 = performance.now();
      const r = origWrite.call(this, buffer, bufferOffset, data, dataOffset, size);
      const ms = performance.now() - t0;
      recordWrite(buffer, bufferOffset, src, base + off, nBytes, ms, buffer.size);
      return r;
    };
    const origTex = queue.writeTexture;
    queue.writeTexture = function probeWriteTexture(destination, data, layout, size) {
      const t0 = performance.now();
      const r = origTex.call(this, destination, data, layout, size);
      const ms = performance.now() - t0;
      if (P.recording) {
        const tex = destination.texture;
        const w = size.width !== undefined ? size.width : size[0];
        const hgt = (size.height !== undefined ? size.height : size[1]) || 1;
        const label = (tex && tex.label) || `${tex ? tex.width + 'x' + tex.height + ' ' + tex.format : '?'}`;
        let t = P.textures.get(label);
        if (!t) {
          t = { label, calls: 0, texels: 0, bytes: 0, ms: 0, stack: stackHere() };
          P.textures.set(label, t);
        }
        t.calls++;
        t.texels += w * hgt;
        t.bytes += layout.bytesPerRow ? layout.bytesPerRow * hgt : 0;
        t.ms += ms;
      }
      return r;
    };
  } else {
    const gl = renderer.gl;
    const BINDING = new Map([
      [0x8892, 0x8894], // ARRAY_BUFFER
      [0x8893, 0x8895], // ELEMENT_ARRAY_BUFFER
      [0x8f36, 0x8f36], // COPY_READ_BUFFER
      [0x8f37, 0x8f37], // COPY_WRITE_BUFFER
      [0x8a11, 0x8a28], // UNIFORM_BUFFER
      [0x88ec, 0x88ef], // PIXEL_UNPACK_BUFFER
      [0x8c8e, 0x8c8f], // TRANSFORM_FEEDBACK_BUFFER
    ]);
    const bound = (target) => gl.getParameter(BINDING.get(target));
    const origSub = gl.bufferSubData;
    gl.bufferSubData = function probeBufferSubData(target, dstByteOffset, srcData, srcOffset, length) {
      const h = bound(target);
      const view = ArrayBuffer.isView(srcData);
      const per = view ? srcData.BYTES_PER_ELEMENT || 1 : 1;
      const src = view ? srcData.buffer : srcData;
      const base = view ? srcData.byteOffset : 0;
      const off = (srcOffset === undefined ? 0 : srcOffset) * per;
      const nBytes = length === undefined || length === 0 ? srcData.byteLength - off : length * per;
      const t0 = performance.now();
      const r = arguments.length > 3 ? origSub.call(this, target, dstByteOffset, srcData, srcOffset, length)
        : origSub.call(this, target, dstByteOffset, srcData);
      const ms = performance.now() - t0;
      if (h) recordWrite(h, dstByteOffset, src, base + off, nBytes, ms, 0);
      return r;
    };
    const origData = gl.bufferData;
    gl.bufferData = function probeBufferData(target, sizeOrData, usage, srcOffset, length) {
      const h = bound(target);
      const t0 = performance.now();
      const r = arguments.length > 3 ? origData.call(this, target, sizeOrData, usage, srcOffset, length)
        : origData.call(this, target, sizeOrData, usage);
      const ms = performance.now() - t0;
      if (h && typeof sizeOrData !== 'number' && sizeOrData) {
        const view = ArrayBuffer.isView(sizeOrData);
        const per = view ? sizeOrData.BYTES_PER_ELEMENT || 1 : 1;
        const off = (srcOffset === undefined ? 0 : srcOffset) * per;
        const nBytes = length === undefined || length === 0 ? sizeOrData.byteLength - off : length * per;
        recordWrite(h, 0, view ? sizeOrData.buffer : sizeOrData, (view ? sizeOrData.byteOffset : 0) + off, nBytes, ms, nBytes);
      }
      return r;
    };
  }
  scan();
  return 'installed';
}

function setRecording({ on }) {
  const P = self.__e562Probe;
  if (!P) return false;
  const px = self.pixiRenderer;
  if (on) {
    P.frameStart = px.frameNumber;
    P.recording = true;
  } else {
    P.recording = false;
    P.frameEnd = px.frameNumber;
  }
  return true;
}

function readInWorker({ top }) {
  const P = self.__e562Probe;
  if (!P) return null;
  const frames = Math.max(1, P.frameEnd - P.frameStart);
  const per = (v) => +(v / frames).toFixed(1);
  const rows = [];
  const tot = { calls: 0, bytes: 0, changed: 0, unknown: 0, span: 0, ms: 0 };
  for (const e of P.entries.values()) {
    if (e.fMin >= 0) e.span += (e.fMax - e.fMin + 1) * 4;
    e.fMin = -1;
    if (e.calls === 0) continue;
    tot.calls += e.calls;
    tot.bytes += e.bytes;
    tot.changed += e.changed;
    tot.unknown += e.unknown;
    tot.span += e.span;
    tot.ms += e.ms;
    rows.push({
      path: e.path, label: e.label, size: e.size || (e.mirror.length * 4),
      framesWritten: e.frames,
      callsPerFrame: per(e.calls), bytesPerFrame: per(e.bytes), changedPerFrame: per(e.changed),
      spanPerFrame: per(e.span), unknownPerFrame: per(e.unknown), msPerFrame: +(e.ms / frames).toFixed(4),
      stack: e.stack,
    });
  }
  rows.sort((a, b) => b.bytesPerFrame - a.bytesPerFrame);
  const textures = [];
  for (const t of P.textures.values()) {
    textures.push({ label: t.label, callsPerFrame: per(t.calls), texelsPerFrame: per(t.texels), bytesPerFrame: per(t.bytes),
      msPerFrame: +(t.ms / frames).toFixed(4), stack: t.stack });
  }
  textures.sort((a, b) => b.bytesPerFrame - a.bytesPerFrame);
  return {
    mode: P.mode, backend: P.backend, frames, framesWithWrites: P.writeFrames, scans: P.scans, scanNodes: P.scanNodes,
    scanMs: +P.scanMs.toFixed(1), buffers: rows.length,
    total: { callsPerFrame: per(tot.calls), bytesPerFrame: per(tot.bytes), changedPerFrame: per(tot.changed),
      spanPerFrame: per(tot.span), unknownPerFrame: per(tot.unknown), msPerFrame: +(tot.ms / frames).toFixed(4) },
    rows: rows.slice(0, top), textures: textures.slice(0, top),
  };
}

function table(result) {
  const lines = [];
  const kb = (v) => (v / 1024).toFixed(1).padStart(9);
  lines.push(`${result.backend} ${result.mode}: ${result.frames} frames (${result.framesWithWrites} with writes), ${result.buffers} buffers written; walk ${result.scans}x, ${result.scanNodes} objects`);
  lines.push(`  calls/f   KB/f  changedKB/f  spanKB/f  unknownKB/f  ms/f     size KB  buffer`);
  const t = result.total;
  lines.push(`${String(t.callsPerFrame).padStart(8)} ${kb(t.bytesPerFrame)} ${kb(t.changedPerFrame)} ${kb(t.spanPerFrame)} ${kb(t.unknownPerFrame)} ${t.msPerFrame.toFixed(3).padStart(7)}             (all)`);
  for (const r of result.rows) {
    lines.push(`${String(r.callsPerFrame).padStart(8)} ${kb(r.bytesPerFrame)} ${kb(r.changedPerFrame)} ${kb(r.spanPerFrame)} ${kb(r.unknownPerFrame)} ${r.msPerFrame.toFixed(3).padStart(7)} ${kb(r.size)}  ${r.path}${r.label ? ` [${r.label}]` : ''}`);
  }
  if (result.textures.length) {
    lines.push('  textures (writeTexture): calls/f  texels/f  KB/f  ms/f  label');
    for (const x of result.textures) lines.push(`${String(x.callsPerFrame).padStart(8)} ${String(x.texelsPerFrame).padStart(10)} ${kb(x.bytesPerFrame)} ${x.msPerFrame.toFixed(3).padStart(7)}  ${x.label}`);
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { query: [], mode: 'count', skipMs: 10000, recordMs: 8000, top: 40, output: null, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scene') opts.scene = argv[++i];
    else if (a === '--scene-export') opts.sceneExport = argv[++i];
    else if (a === '--query') opts.query.push(argv[++i]);
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--skip-ms') opts.skipMs = Number(argv[++i]);
    else if (a === '--record-ms') opts.recordMs = Number(argv[++i]);
    else if (a === '--top') opts.top = Number(argv[++i]);
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
    const ask = async (w, fn, arg, ms = 500) => Promise.race([
      w.evaluate(fn, arg).catch((err) => ({ error: String(err) })),
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
    let pixi = null;
    const t0 = Date.now();
    while (pixi === null && Date.now() - t0 < 90000) {
      for (const w of page.workers()) {
        // The first walk can outlast the timeout: the next pass reads 'installed'.
        const r = await ask(w, installInWorker, { mode: opts.mode });
        if (r === 'installed') {
          pixi = w;
          break;
        }
      }
      if (pixi === null) await page.waitForTimeout(200);
    }
    if (pixi === null) throw new Error('no Pixi renderer in any worker after 90 s');
    const installedAt = Date.now() - t0;
    await page.waitForTimeout(opts.skipMs);
    await ask(pixi, setRecording, { on: true });
    await page.waitForTimeout(opts.recordMs);
    await ask(pixi, setRecording, { on: false });
    const result = await ask(pixi, readInWorker, { top: opts.top }, 10000);
    const report = { scene: opts.sceneExport, query: opts.query, mode: opts.mode, installedAtMs: installedAt, skipMs: opts.skipMs, recordMs: opts.recordMs, result, errors: errors.slice(0, 10) };
    if (opts.output) fs.writeFileSync(opts.output, JSON.stringify(report, null, 1));
    if (result && result.rows) console.log(table(result));
    else console.log(JSON.stringify(report, null, 1));
    if (errors.length) console.log(`errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
