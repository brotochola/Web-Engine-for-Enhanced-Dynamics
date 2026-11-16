#!/usr/bin/env node
/**
 * What the renderer asks of WebGL in a frame (E-230): Spector.js's capture, for a context that lives in a worker. Spector
 * needs the page's DOM and our WebGL context is Pixi's, on an OffscreenCanvas in the Pixi worker, so this wraps that
 * context's methods from inside the worker for a window of frames and counts, per frame:
 *   - draw calls (drawElements/drawArrays and their instanced forms) and the instances they draw
 *   - state binds (program, textures per unit, buffers per target, vertex arrays, framebuffers, render buffers) and how
 *     many of them bind what was bound already (redundant)
 *   - uniform calls, and the ones that set the same value again where it can tell (uniform1i/1f)
 *   - other state (enable/disable, blend, depth, color mask, viewport, scissor) and its redundant calls
 *   - bytes sent: bufferData/bufferSubData, texImage2D/texSubImage2D/texImage3D/texSubImage3D (from the view or w*h*bpp)
 *   - clears, framebuffer blits, and the calls that make the CPU wait for the GPU (readPixels, getError, finish,
 *     clientWaitSync, getQueryParameter, getBufferSubData)
 * GPU time per frame when EXT_disjoint_timer_query_webgl2 is there (most Windows Chrome builds do not expose it).
 *
 * With --gpu-passes, the GPU time of each pass in the real frame (a TIME_ELAPSED query from one framebuffer bind to
 * the next, labelled by framebuffer, viewport and first program), where the extension is exposed. A TIME_ELAPSED range
 * counts the GPU's idle gaps inside it too (commands the CPU had not submitted yet): a pass's time is an upper bound of
 * its work, read with the GPU's busy share (Nsight Systems' GR Active) when they disagree. With --gpu-draws, a query
 * around each draw call instead (labelled by its pass and its index there): each pass's draws summed leave out the
 * gaps between them, so a pass whose draws sum far below its --gpu-passes time was waiting, not drawing. With
 * --probe-scissor <regex> as well, the draws whose label matches run under a 1 px scissor: their time against a run
 * without the probe is what their pixels cost (the frame drawn is then not the scene's).
 *
 *   node tests/bench/glFrameRecorder.mjs --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
 *     [--query k=v&k2=v2] [--warmup-ms 12000] [--record-ms 3000] [--gpu-passes | --gpu-draws [--probe-scissor re]]
 *     [--output gl.json]
 * From Git Bash set MSYS_NO_PATHCONV=1. Headed Chrome (a headless one draws on a software path). The wrappers add a
 * little time to each call, so the scene's speed during the window is not a measurement; the counts are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Runs in the Pixi worker: wrap the context, record `ms`, unwrap, return the totals. */
async function recordInWorker({ ms, gpuPasses, gpuDraws, probeScissor }) {
  const px = self.pixiRenderer;
  const gl = px?.pixiApp?.renderer?.gl;
  if (!gl) return { error: 'no WebGL context in the Pixi worker (a WebGPU backend?)' };
  const proto = Object.getPrototypeOf(gl);
  // GPU time by pass (gpuPasses): a TIME_ELAPSED query from each framebuffer bind to the next, labelled by the
  // framebuffer, the viewport set in it and its first program; results read without waiting, summed by label. The
  // context's own methods (not the wrappers) run the queries, so they count in no total. gpuDraws: a query around each
  // draw call instead (no pass query: they cannot nest), labelled by its pass and its place in it, so a pass's time
  // splits into its draws and the idle gaps between them show as the difference from the pass mode's total.
  const perDraw = !!gpuDraws;
  const timerExt = gpuPasses || gpuDraws ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const raw = (n) => Object.getOwnPropertyDescriptor(proto, n).value;
  const qCreate = raw('createQuery');
  const qBegin = raw('beginQuery');
  const qEnd = raw('endQuery');
  const qParam = raw('getQueryParameter');
  const qParamGl = raw('getParameter');
  const passes = new Map();
  const drawPasses = new Map();
  const pending = [];
  const free = [];
  let seg = null;
  let disjoint = 0;
  // A program's first uniform names (its samplers name the pass: uLightData, uSunMap, uLampMap...), read once.
  const progSig = new Map();
  const uParam = raw('getProgramParameter');
  const uActive = raw('getActiveUniform');
  const signature = (p) => {
    if (!p) return '';
    let s = progSig.get(p);
    if (s !== undefined) return s;
    const names = [];
    const n = uParam.call(gl, p, gl.ACTIVE_UNIFORMS) | 0;
    for (let i = 0; i < n && names.length < 8; i++) {
      const u = uActive.call(gl, p, i);
      if (u && u.type >= 0x8b5e && u.type <= 0x8dd8 && /^u/.test(u.name)) names.push(u.name.replace(/\[0\]$/, ''));
    }
    s = names.join(',');
    progSig.set(p, s);
    return s;
  };
  const segLabel = (s) => `fbo#${s.fbo} ${s.viewport || '?'} prog#${s.program || 0} [${s.sig || ''}]`;
  const endSeg = () => {
    if (!seg) return;
    if (!perDraw) {
      qEnd.call(gl, timerExt.TIME_ELAPSED_EXT);
      pending.push(seg);
    }
    seg = null;
  };
  const beginSeg = (fbo) => {
    if (!timerExt) return;
    endSeg();
    const q = perDraw ? null : free.pop() || qCreate.call(gl);
    seg = { q, fbo, viewport: '', program: 0, draws: 0, instances: 0 };
    if (!perDraw) qBegin.call(gl, timerExt.TIME_ELAPSED_EXT, q);
  };
  // gpuDraws: the open draw's query, ended right after the draw call.
  let drawQ = null;
  // The textures Pixi has bound on the first units (its texture system's own record: a texture bound before the window
  // drew no bindTexture during it), by label and size, so that a costly draw of a common program can be named.
  const texNames = () => {
    try {
      const b = px.pixiApp.renderer.texture._boundTextures;
      const names = [];
      for (let i = 0; i < Math.min(4, b.length); i++) {
        const s = b[i];
        if (s) names.push(`${String(s.label || `#${s.uid}`).split('/').pop().slice(0, 24)} ${s.pixelWidth ?? s.width}x${s.pixelHeight ?? s.height}`);
      }
      return names.length ? ` {${names.join('; ')}}` : '';
    } catch {
      return '';
    }
  };
  // probeScissor: the draws whose label matches it run under a 1 px scissor (the state put back after), so their time
  // without the fill is read against a run without the probe: how much of a costly draw is pixels.
  const probeRe = perDraw && probeScissor ? new RegExp(probeScissor) : null;
  const rawEnable = raw('enable');
  const rawDisable = raw('disable');
  const rawIsEnabled = raw('isEnabled');
  const rawScissor = raw('scissor');
  let probeSaved = null;
  const beginDraw = (n) => {
    if (!perDraw || !seg) return;
    const q = free.pop() || qCreate.call(gl);
    // The draw's own program (the pass's label names its first one): what a costly draw in a pass of many programs is.
    const pass = segLabel(seg);
    const p = bound.program;
    let label = `${pass} draw ${seg.draws}: prog#${idOf(p)} [${signature(p)}]`;
    if (probeRe && probeRe.test(label)) {
      probeSaved = { on: rawIsEnabled.call(gl, gl.SCISSOR_TEST), box: qParamGl.call(gl, gl.SCISSOR_BOX) };
      rawEnable.call(gl, gl.SCISSOR_TEST);
      rawScissor.call(gl, 0, 0, 1, 1);
      label += ' (scissor 1 px)';
    }
    drawQ = { q, label: `${label}${texNames()}`, pass, draws: 1, instances: n };
    qBegin.call(gl, timerExt.TIME_ELAPSED_EXT, q);
  };
  // gpuDraws: a clear or a blit timed like a draw (E-402: what the passes with no draw spend).
  const beginOp = (name) => {
    if (!perDraw || !timerExt) return;
    if (!seg) {
      const fb = bound.fbo.get(0x8ca9) ?? bound.fbo.get(0x8d40) ?? null;
      beginSeg(idOf(fb));
      seg.fboObj = fb;
    }
    const q = free.pop() || qCreate.call(gl);
    const pass = segLabel(seg);
    drawQ = { q, label: `${pass} ${name}`, pass, draws: 0, instances: 0 };
    qBegin.call(gl, timerExt.TIME_ELAPSED_EXT, q);
  };
  const endDraw = () => {
    if (!drawQ) return;
    qEnd.call(gl, timerExt.TIME_ELAPSED_EXT);
    pending.push(drawQ);
    drawQ = null;
    if (probeSaved !== null) {
      if (!probeSaved.on) rawDisable.call(gl, gl.SCISSOR_TEST);
      const b = probeSaved.box;
      rawScissor.call(gl, b[0], b[1], b[2], b[3]);
      probeSaved = null;
    }
  };
  const collect = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const s = pending[i];
      if (!qParam.call(gl, s.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = qParam.call(gl, s.q, gl.QUERY_RESULT);
      if (qParamGl.call(gl, timerExt.GPU_DISJOINT_EXT)) disjoint++;
      else {
        const k = s.label || segLabel(s);
        const p = passes.get(k) || { label: k, ns: 0, segments: 0, draws: 0, instances: 0 };
        p.ns += ns;
        p.segments++;
        p.draws += s.draws;
        p.instances += s.instances;
        passes.set(k, p);
        if (s.pass) {
          const t = drawPasses.get(s.pass) || { label: s.pass, ns: 0, draws: 0, instances: 0 };
          t.ns += ns;
          t.draws += s.draws;
          t.instances += s.instances;
          drawPasses.set(s.pass, t);
        }
      }
      pending.splice(i, 1);
      free.push(s.q);
    }
  };
  let poll = 0;
  if (timerExt) poll = setInterval(collect, 4);
  const counts = Object.create(null);
  const redundant = Object.create(null);
  let draws = 0;
  let instances = 0;
  let bytesBuffer = 0;
  let bytesTexture = 0;
  const bound = { program: null, vao: null, fbo: new Map(), rbo: null, unit: 0, tex: new Map(), buf: new Map() };
  // What the uploads and queries were: calls and bytes per texture size and format, per buffer object, per pname.
  const detail = new Map();
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { if (!o) return 0; let i = ids.get(o); if (!i) ids.set(o, (i = nextId++)); return i; };
  const note = (key, bytes) => { const d = detail.get(key) || { calls: 0, bytes: 0 }; d.calls++; d.bytes += bytes; detail.set(key, d); };
  const state = new Map(); // a state call's last arguments, by name and first argument
  const uniformLast = new Map();
  const bpp = (format, type) => {
    const c = { 6408: 4, 6407: 3, 6410: 2, 6409: 1, 6406: 1, 6403: 1, 33319: 2, 36249: 4, 36248: 3, 33320: 1, 36244: 1 }[format] || 4;
    const b = { 5121: 1, 5126: 4, 5131: 2, 36193: 2, 5125: 4, 5124: 4, 5123: 2, 5122: 2 }[type] || 1;
    return c * b;
  };
  const viewBytes = (v) => (v && typeof v.byteLength === 'number' ? v.byteLength : 0);
  const wrapped = [];
  const wrap = (name, before, after) => {
    // The descriptor's value: reading proto[name] runs a getter (canvas, drawingBufferWidth) on the prototype and throws.
    const orig = Object.getOwnPropertyDescriptor(proto, name)?.value;
    if (typeof orig !== 'function') return;
    const fn = function (...args) {
      counts[name] = (counts[name] || 0) + 1;
      if (before) before(args);
      const r = orig.apply(this, args);
      if (after) after(args);
      return r;
    };
    gl[name] = fn;
    wrapped.push(name);
  };
  const redo = (name) => {
    redundant[name] = (redundant[name] || 0) + 1;
  };
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value !== 'function' || name === 'constructor') continue;
    let hook = null;
    // A pass's draws, and its program when the segment drew with the one already bound. A draw with no pass open (the
    // frame drew into the framebuffer bound before the recording, with no bind since) opens one for that framebuffer.
    const segDraw = (n) => {
      if (!seg && timerExt) {
        const fb = bound.fbo.get(0x8ca9) ?? bound.fbo.get(0x8d40) ?? null;
        beginSeg(idOf(fb));
        seg.fboObj = fb;
      }
      if (!seg) return;
      seg.draws++;
      seg.instances += n;
      if (!seg.program && bound.program) {
        seg.program = idOf(bound.program);
        seg.sig = signature(bound.program);
      }
    };
    let after = null;
    if (name === 'drawElements' || name === 'drawArrays') hook = () => { draws++; instances++; segDraw(1); beginDraw(1); };
    else if (name === 'drawElementsInstanced') hook = (a) => { draws++; instances += a[4] | 0; segDraw(a[4] | 0); beginDraw(a[4] | 0); };
    else if (name === 'drawArraysInstanced') hook = (a) => { draws++; instances += a[3] | 0; segDraw(a[3] | 0); beginDraw(a[3] | 0); };
    else if (perDraw && (name === 'clear' || name.startsWith('clearBuffer') || name === 'blitFramebuffer')) hook = () => beginOp(name);
    else if (name === 'getParameter' || name === 'isEnabled') hook = (a) => note(`${name} 0x${(a[0] >>> 0).toString(16)}`, 0);
    else if (name === 'useProgram') {
      hook = (a) => {
        if (bound.program === a[0]) redo(name);
        bound.program = a[0];
        if (seg && !seg.program && a[0]) {
          seg.program = idOf(a[0]);
          seg.sig = signature(a[0]);
        }
      };
    }
    else if (name === 'bindVertexArray') hook = (a) => { if (bound.vao === a[0]) redo(name); bound.vao = a[0]; };
    else if (name === 'activeTexture') hook = (a) => { if (bound.unit === a[0]) redo(name); bound.unit = a[0]; };
    else if (name === 'bindTexture') {
      hook = (a) => {
        const k = `${bound.unit}:${a[0]}`;
        if (bound.tex.get(k) === a[1]) {
          redo(name);
          note(`bindTexture again, prog#${idOf(bound.program)} [${signature(bound.program)}]`, 0);
        }
        bound.tex.set(k, a[1]);
      };
    }
    else if (name === 'bindBuffer') hook = (a) => { if (bound.buf.get(a[0]) === a[1]) redo(name); bound.buf.set(a[0], a[1]); };
    else if (name === 'bindFramebuffer') {
      hook = (a) => {
        if (bound.fbo.get(a[0]) === a[1]) redo(name);
        bound.fbo.set(a[0], a[1]);
        // A new pass where the draw framebuffer changes (FRAMEBUFFER 0x8d40 or DRAW_FRAMEBUFFER 0x8ca9).
        if (timerExt && (a[0] === 0x8d40 || a[0] === 0x8ca9) && (!seg || seg.fboObj !== a[1])) {
          beginSeg(idOf(a[1]));
          seg.fboObj = a[1];
        }
      };
    }
    else if (name === 'bindRenderbuffer') hook = (a) => { if (bound.rbo === a[1]) redo(name); bound.rbo = a[1]; };
    else if (name === 'bufferData') hook = (a) => { const b = typeof a[1] === 'number' ? a[1] : viewBytes(a[1]); bytesBuffer += b; note(`bufferData buffer#${idOf(bound.buf.get(a[0]))} target ${a[0]}`, b); };
    else if (name === 'bufferSubData') hook = (a) => { const b = a[4] ? (a[4] | 0) * (a[2].BYTES_PER_ELEMENT || 1) : viewBytes(a[2]); bytesBuffer += b; note(`bufferSubData buffer#${idOf(bound.buf.get(a[0]))} target ${a[0]}`, b); };
    else if (name === 'texImage2D' || name === 'texSubImage2D' || name === 'texImage3D' || name === 'texSubImage3D') {
      hook = (a) => {
        // N-216: the region the call names (width x height [x depth] x bytes a texel), not the source view: a call that
        // passes a sub-range of a large view (srcOffset) uploads only its region.
        const view = a.find((x) => x && typeof x.byteLength === 'number');
        const before = bytesTexture;
        const num = (...ix) => ix.every((i) => typeof a[i] === 'number');
        if (name === 'texSubImage2D' && num(4, 5, 6, 7)) bytesTexture += a[4] * a[5] * bpp(a[6], a[7]);
        else if (name === 'texImage2D' && num(3, 4, 6, 7) && a.length >= 9) bytesTexture += view ? a[3] * a[4] * bpp(a[6], a[7]) : 0;
        else if (name === 'texSubImage3D' && num(5, 6, 7, 8, 9)) bytesTexture += a[5] * a[6] * a[7] * bpp(a[8], a[9]);
        else if (name === 'texImage3D' && num(3, 4, 5, 7, 8)) bytesTexture += view ? a[3] * a[4] * a[5] * bpp(a[7], a[8]) : 0;
        else if (view) bytesTexture += view.byteLength;
        else if (a[a.length - 1] && a[a.length - 1].width) bytesTexture += a[a.length - 1].width * a[a.length - 1].height * 4;
        const dims = name === 'texSubImage2D' ? `${a[4]}x${a[5]}` : name === 'texImage2D' ? `${a[3]}x${a[4]}` : '';
        note(`${name} texture#${idOf(bound.tex.get(`${bound.unit}:${a[0]}`))} ${dims} format ${a[name === 'texSubImage2D' ? 6 : 6]} type ${a[7]}`, bytesTexture - before);
      };
    } else if (name === 'uniform1i' || name === 'uniform1f') {
      hook = (a) => {
        const k = a[0];
        if (k && uniformLast.get(k) === a[1]) {
          redo(name);
          note(`${name} again, prog#${idOf(bound.program)} [${signature(bound.program)}]`, 0);
        }
        uniformLast.set(k, a[1]);
      };
    } else if (['enable', 'disable', 'blendFunc', 'blendFuncSeparate', 'blendEquation', 'blendEquationSeparate', 'depthMask', 'depthFunc', 'colorMask', 'viewport', 'scissor', 'cullFace', 'frontFace', 'clearColor', 'pixelStorei', 'stencilMask', 'stencilFunc', 'stencilOp'].includes(name)) {
      hook = (a) => {
        if (name === 'viewport' && seg && !seg.viewport) seg.viewport = `${a[2]}x${a[3]}`;
        const key = name === 'enable' || name === 'disable' ? `cap:${a[0]}` : name === 'pixelStorei' ? `${name}:${a[0]}` : name;
        const val = name === 'enable' ? 1 : name === 'disable' ? 0 : a.join(',');
        if (state.get(key) === val) redo(name);
        state.set(key, val);
      };
    }
    const timed = name === 'drawElements' || name === 'drawArrays' || name === 'drawElementsInstanced' || name === 'drawArraysInstanced'
      || name === 'clear' || name.startsWith('clearBuffer') || name === 'blitFramebuffer';
    if (perDraw && timed) after = endDraw;
    wrap(name, hook, after);
  }
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const f0 = px.frameNumber | 0;
  const t0 = performance.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const frames = (px.frameNumber | 0) - f0;
  const elapsed = performance.now() - t0;
  for (const name of wrapped) delete gl[name];
  let gpu = null;
  if (timerExt) {
    endSeg();
    for (let t = 0; t < 50 && pending.length; t++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      collect();
    }
    clearInterval(poll);
    const perMs = (ns) => Math.round((ns / 1e6 / Math.max(1, frames)) * 1000) / 1000;
    const rows = [...passes.values()].sort((x, y) => y.ns - x.ns).map((p) => ({
      label: p.label, msPerFrame: perMs(p.ns), segmentsPerFrame: Math.round((p.segments / Math.max(1, frames)) * 10) / 10,
      drawsPerFrame: Math.round((p.draws / Math.max(1, frames)) * 10) / 10, instancesPerFrame: Math.round(p.instances / Math.max(1, frames)),
    }));
    gpu = { msPerFrame: perMs([...passes.values()].reduce((s, p) => s + p.ns, 0)), disjoint, lost: pending.length, passes: rows, perDraw };
    // gpuDraws: each pass's draws summed (the pass's busy time, without the gaps between its draws).
    if (perDraw) {
      gpu.drawPasses = [...drawPasses.values()].sort((x, y) => y.ns - x.ns).map((p) => ({
        label: p.label, msPerFrame: perMs(p.ns), drawsPerFrame: Math.round((p.draws / Math.max(1, frames)) * 10) / 10,
        instancesPerFrame: Math.round(p.instances / Math.max(1, frames)),
      }));
    }
  }
  const per = (v) => Math.round((v / Math.max(1, frames)) * 10) / 10;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, perFrame: per(n), redundantPerFrame: per(redundant[name] || 0) }));
  return {
    frames,
    ms: Math.round(elapsed),
    timerQuery: Boolean(timer),
    gpu,
    perFrame: {
      calls: per(Object.values(counts).reduce((s, n) => s + n, 0)),
      draws: per(draws),
      instances: per(instances),
      bytesBuffer: per(bytesBuffer),
      bytesTexture: per(bytesTexture),
      redundant: per(Object.values(redundant).reduce((s, n) => s + n, 0)),
      syncCalls: per(['readPixels', 'getError', 'finish', 'clientWaitSync', 'getQueryParameter', 'getBufferSubData', 'getParameter'].reduce((s, n) => s + (counts[n] || 0), 0)),
    },
    top,
    detail: [...detail]
      .map(([key, d]) => ({ key, perFrame: per(d.calls), kbPerFrame: Math.round((d.bytes / 1024 / Math.max(1, frames)) * 10) / 10 }))
      .sort((x, y) => y.kbPerFrame - x.kbPerFrame || y.perFrame - x.perFrame),
  };
}

export async function recordGlFrames(opts) {
  const server = await createStaticBenchmarkServer(repoRoot);
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${opts.query ? `&${opts.query}` : ''}`);
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__));
    await page.evaluate(({ m, e }) => window.__WEED_BENCHMARK__.prepare({ warmupMs: 600000, durationMs: 600000, sampleIntervalMs: 1000,
      sceneModule: m, sceneExport: e, collectDetailedStats: false, collectGpuStats: false }), { m: opts.scene, e: opts.sceneExport });
    await page.waitForTimeout(opts.warmupMs);
    const worker = page.workers().find((w) => w.url().includes('pixiWorker'));
    if (!worker) throw new Error('no Pixi worker');
    return await worker.evaluate(recordInWorker, { ms: opts.recordMs, gpuPasses: !!opts.gpuPasses, gpuDraws: !!opts.gpuDraws, probeScissor: opts.probeScissor || null });
  } finally {
    await browser.close();
    await server.close?.();
  }
}

async function main() {
  const args = parseArgs();
  if (!args.scene || !args['scene-export']) {
    console.error('usage: glFrameRecorder.mjs --scene <module> --scene-export <Class> [--query k=v] [--warmup-ms N] [--record-ms N] [--output file]');
    process.exit(2);
  }
  const r = await recordGlFrames({
    scene: String(args.scene),
    sceneExport: String(args['scene-export']),
    query: typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '',
    warmupMs: Number(args['warmup-ms'] ?? 12000),
    recordMs: Number(args['record-ms'] ?? 3000),
    gpuPasses: !!args['gpu-passes'],
    gpuDraws: !!args['gpu-draws'],
    probeScissor: typeof args['probe-scissor'] === 'string' ? args['probe-scissor'] : null,
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  const p = r.perFrame;
  console.log(`${r.frames} frames in ${r.ms} ms; per frame: ${p.calls} GL calls, ${p.draws} draws (${p.instances} instances), ` +
    `${p.redundant} redundant, ${(p.bytesBuffer / 1024).toFixed(1)} KB buffers, ${(p.bytesTexture / 1024).toFixed(1)} KB textures, ` +
    `${p.syncCalls} calls that wait for the GPU; timer queries: ${r.timerQuery ? 'yes' : 'no'}`);
  for (const row of r.top.slice(0, 30)) console.log(`  ${String(row.perFrame).padStart(7)}  ${row.name}${row.redundantPerFrame ? `  (${row.redundantPerFrame} redundant)` : ''}`);
  console.log('uploads and queries, per frame:');
  for (const row of r.detail.slice(0, 20)) console.log(`  ${String(row.perFrame).padStart(6)} calls ${String(row.kbPerFrame).padStart(7)} KB  ${row.key}`);
  if (r.gpu?.perDraw) {
    console.log(`GPU time in draws (a timer query per draw, ${r.gpu.disjoint} disjoint, ${r.gpu.lost} unread): ${r.gpu.msPerFrame} ms a frame; by pass:`);
    for (const row of r.gpu.drawPasses.slice(0, 20)) {
      console.log(`  ${row.msPerFrame.toFixed(3).padStart(7)} ms  ${String(row.drawsPerFrame).padStart(5)} draws ${String(row.instancesPerFrame).padStart(7)} inst  ${row.label}`);
    }
    console.log('the costliest draws:');
    for (const row of r.gpu.passes.slice(0, 30)) {
      console.log(`  ${row.msPerFrame.toFixed(3).padStart(7)} ms  x${String(row.segmentsPerFrame).padStart(4)} ${String(row.instancesPerFrame).padStart(7)} inst  ${row.label}`);
    }
  } else if (r.gpu) {
    console.log(`GPU time by pass (timer queries, ${r.gpu.disjoint} disjoint, ${r.gpu.lost} unread): ${r.gpu.msPerFrame} ms a frame`);
    for (const row of r.gpu.passes.slice(0, 30)) {
      console.log(`  ${row.msPerFrame.toFixed(3).padStart(7)} ms  x${String(row.segmentsPerFrame).padStart(4)}  ${String(row.drawsPerFrame).padStart(5)} draws ` +
        `${String(row.instancesPerFrame).padStart(7)} inst  ${row.label}`);
    }
  } else if (args['gpu-passes'] || args['gpu-draws']) console.log('GPU time: no EXT_disjoint_timer_query_webgl2 in this context');
  if (args.output) fs.writeFileSync(String(args.output), JSON.stringify(r, null, 1));
}

if (isCli(import.meta.url)) await main();
