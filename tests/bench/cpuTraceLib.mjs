/**
 * Stream-parse a Chrome/Playwright trace (engine_trace.json, one event per
 * line) into per-thread CPU time. No JSON.parse of the whole file.
 *
 * Each sample weighs the time until the next sample on that thread
 * (`timeDeltas`, µs). `lines` gives the source line of each sample, so hot
 * lines inside a big function are visible. Only samples inside the window
 * [trace start + fromMs, + durationMs] count; the default skips the runner's
 * warmup, so init and importScripts do not pollute the flame.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';

export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const PSEUDO = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);

const WORKER_KIND = {
  'logicWorker.js': 'logic',
  'spatialWorker.js': 'spatial',
  'preRenderWorker.js': 'preRender',
  'pixiWorker.js': 'pixi',
  'particleWorker.js': 'particle',
};

export function normalizeUrl(url) {
  return String(url || '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?[^:]*$/, '')
    .replace(/\?v=[^&:]*/g, '');
}

export function urlCategory(url) {
  if (!url) return 'native';
  if (url.includes('/vendor/') || url.includes('pixi.min.js')) return 'vendor';
  if (url.endsWith('.wasm') || url.includes('wasm-function')) return 'wasm';
  if (url.startsWith('/src/')) return 'engine';
  if (url.startsWith('/demos/')) return 'demo';
  if (url.startsWith('/tests/')) return 'bench';
  return 'other';
}

function parseLine(raw) {
  let s = raw.trim();
  if (!s || s[0] !== '{' || s.startsWith('{"traceEvents"')) return null;
  if (s.endsWith(',')) s = s.slice(0, -1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function bump(map, key, n) {
  map.set(key, (map.get(key) || 0) + n);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}

function newProfile(id, pid, tid) {
  return {
    id,
    pid,
    tid,
    startTime: null,
    t: null,
    nodes: new Map(),
    pending: null,
    deltas: [],
    samples: 0,
    windowSamples: 0,
    totalUs: 0,
    idleUs: 0,
    programUs: 0,
    gcUs: 0,
    self: new Map(),
    inclusive: new Map(),
    lines: new Map(),
    callers: new Map(),
    fileSelf: new Map(),
    stamp: new Map(),
    sampleSeq: 0,
  };
}

function frameKey(node) {
  if (node.key) return node.key;
  const line = node.line != null && node.line >= 0 ? `:${node.line + 1}` : '';
  node.key = `${node.name} ${node.url}${line}`.trim();
  return node.key;
}

function account(prof, nodeId, line, us) {
  const node = prof.nodes.get(nodeId);
  if (!node) return;
  prof.totalUs += us;
  if (node.name === '(idle)') {
    prof.idleUs += us;
    return;
  }
  if (node.name === '(program)') prof.programUs += us;
  if (node.name === '(garbage collector)') prof.gcUs += us;
  const key = frameKey(node);
  bump(prof.self, key, us);
  if (node.url) bump(prof.fileSelf, node.url, us);
  if (line > 0 && !PSEUDO.has(node.name)) bump(prof.lines, `${key}\u0000${line}`, us);
  const parent = prof.nodes.get(node.parent);
  if (parent && !PSEUDO.has(node.name)) {
    let m = prof.callers.get(key);
    if (!m) prof.callers.set(key, (m = new Map()));
    bump(m, frameKey(parent), us);
  }
  const seq = ++prof.sampleSeq;
  for (let cur = node; cur; cur = prof.nodes.get(cur.parent)) {
    if (PSEUDO.has(cur.name)) continue;
    const k = frameKey(cur);
    if (prof.stamp.get(k) === seq) continue;
    prof.stamp.set(k, seq);
    bump(prof.inclusive, k, us);
  }
}

/**
 * @param {string} file
 * @param {{ fromMs?: number, durationMs?: number }} [opts]
 */
export async function readCpuTrace(file, opts = {}) {
  const fromMs = opts.fromMs ?? DEFAULT_WARMUP_MS;
  const durationMs = opts.durationMs ?? Infinity;
  const threadName = new Map();
  const profiles = new Map();
  let events = 0;
  // The main thread's Profile event comes first (tracing starts before the
  // workers), so the first startTime seen is the trace start.
  let traceStartUs = null;
  let winFrom = 0;
  let winTo = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    const ev = parseLine(raw);
    if (!ev) continue;
    events++;
    if (ev.name === 'thread_name' && ev.args?.name != null) {
      threadName.set(`${ev.pid}:${ev.tid}`, ev.args.name);
      continue;
    }
    if (ev.name !== 'Profile' && ev.name !== 'ProfileChunk') continue;
    const key = `${ev.pid}:${ev.id ?? ev.tid}`;
    let prof = profiles.get(key);
    if (!prof) profiles.set(key, (prof = newProfile(key, ev.pid, ev.tid)));
    const data = ev.args?.data || {};
    if (ev.name === 'Profile') {
      if (data.startTime != null) {
        prof.startTime = data.startTime;
        if (traceStartUs == null) {
          traceStartUs = data.startTime;
          winFrom = traceStartUs + fromMs * 1000;
          winTo = winFrom + durationMs * 1000;
        }
      }
      continue;
    }
    if (traceStartUs == null) continue;
    const cpu = data.cpuProfile || {};
    for (const n of cpu.nodes || []) {
      const cf = n.callFrame || {};
      prof.nodes.set(n.id, {
        parent: n.parent,
        name: cf.functionName || '(anonymous)',
        url: normalizeUrl(cf.url),
        line: cf.lineNumber,
        key: null,
      });
    }
    const samples = cpu.samples || [];
    const deltas = data.timeDeltas || [];
    const lines = data.lines || [];
    if (prof.t == null) prof.t = prof.startTime ?? traceStartUs;
    for (let i = 0; i < samples.length; i++) {
      const d = deltas[i] ?? 0;
      prof.t += d;
      prof.deltas.push(d);
      prof.samples++;
      const p = prof.pending;
      if (p && p.t >= winFrom && p.t < winTo) {
        prof.windowSamples++;
        account(prof, p.node, p.line, prof.t - p.t);
      }
      prof.pending = { node: samples[i], line: lines[i] || 0, t: prof.t };
    }
  }
  for (const prof of profiles.values()) {
    const p = prof.pending;
    if (p && p.t >= winFrom && p.t < winTo) account(prof, p.node, p.line, median(prof.deltas));
    prof.pending = null;
    prof.stamp = null;
  }

  return { file, events, traceStartUs, fromMs, durationMs, threadName, profiles };
}

function kindOf(prof, tname) {
  let best = null;
  let bestUs = 0;
  let box2dUs = 0;
  for (const [url, us] of prof.fileSelf) {
    const m = url.match(/\/src\/workers\/([^/]+\.js)$/);
    if (m && m[1] !== 'abstractWorker.js' && us > bestUs) {
      best = m[1];
      bestUs = us;
    }
    if (url.startsWith('/src/box2d/')) box2dUs += us;
  }
  if (best && WORKER_KIND[best]) return WORKER_KIND[best];
  if (best) return best.replace(/\.js$/, '');
  if (box2dUs > 0) return 'physics';
  if (/CrRendererMain/.test(tname || '')) return 'main';
  return 'other';
}

function topOf(map, limit, denomUs) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, us]) => ({ key, ms: us / 1000, pct: denomUs > 0 ? (100 * us) / denomUs : 0 }));
}

const _fileLines = new Map();
export function sourceLine(url, line) {
  const cat = urlCategory(url);
  if ((cat !== 'engine' && cat !== 'demo') || !/\.m?js$/.test(url)) return null;
  let text = _fileLines.get(url);
  if (text === undefined) {
    const abs = path.join(repoRoot, url.replace(/^\//, ''));
    try {
      text = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    } catch {
      text = null;
    }
    _fileLines.set(url, text);
  }
  return text ? (text[line - 1] ?? '').trim().slice(0, 160) : null;
}

/**
 * Per-thread and per-kind summary. Percentages are of busy time (window minus idle).
 * @param {Awaited<ReturnType<typeof readCpuTrace>>} trace
 * @param {{ limit?: number, hotFunctions?: number, hotLinesPer?: number }} [opts]
 */
export function summarizeCpuTrace(trace, opts = {}) {
  const limit = opts.limit ?? 30;
  const hotFunctions = opts.hotFunctions ?? 8;
  const hotLinesPer = opts.hotLinesPer ?? 6;
  const threads = [];
  const byKind = new Map();

  for (const prof of trace.profiles.values()) {
    if (!prof.totalUs) continue;
    const tname = trace.threadName.get(`${prof.pid}:${prof.tid}`) || `tid ${prof.tid}`;
    const kind = kindOf(prof, tname);
    const busyUs = prof.totalUs - prof.idleUs;
    const windowS = prof.totalUs / 1e6;
    const selfTop = topOf(prof.self, limit, busyUs);
    const hot = selfTop.filter((r) => !PSEUDO.has(r.key.split(' ')[0])).slice(0, hotFunctions);
    const hotLines = [];
    const callers = {};
    for (const fn of hot) {
      const rows = [];
      for (const [k, us] of prof.lines) {
        const sep = k.indexOf('\u0000');
        if (k.slice(0, sep) !== fn.key) continue;
        rows.push({ line: Number(k.slice(sep + 1)), us });
      }
      rows.sort((a, b) => b.us - a.us);
      const url = fn.key.split(' ')[1]?.replace(/:\d+$/, '') || '';
      hotLines.push({
        fn: fn.key,
        fnMs: fn.ms,
        lines: rows.slice(0, hotLinesPer).map((r) => ({
          line: r.line,
          ms: r.us / 1000,
          pctOfFn: fn.ms > 0 ? (100 * r.us) / 1000 / fn.ms : 0,
          text: sourceLine(url, r.line),
        })),
      });
      const cm = prof.callers.get(fn.key);
      if (cm) callers[fn.key] = topOf(cm, 5, prof.self.get(fn.key) || 0);
    }
    const t = {
      label: `${kind}@${prof.tid}`,
      kind,
      threadName: tname,
      pid: prof.pid,
      tid: prof.tid,
      samples: prof.windowSamples,
      medianDeltaUs: median(prof.deltas),
      windowMs: prof.totalUs / 1000,
      busyMs: busyUs / 1000,
      busyMsPerS: windowS > 0 ? busyUs / 1000 / windowS : 0,
      gcMs: prof.gcUs / 1000,
      programMs: prof.programUs / 1000,
      self: selfTop,
      inclusive: topOf(prof.inclusive, limit, busyUs),
      hotLines,
      callers,
    };
    threads.push(t);
    let k = byKind.get(kind);
    if (!k) byKind.set(kind, (k = { kind, threads: [], busyUs: 0, self: new Map(), inclusive: new Map() }));
    k.threads.push(t.label);
    k.busyUs += busyUs;
    for (const [key, us] of prof.self) if (!PSEUDO.has(key.split(' ')[0]) || key.startsWith('(garbage')) bump(k.self, key, us);
    for (const [key, us] of prof.inclusive) bump(k.inclusive, key, us);
  }

  threads.sort((a, b) => a.kind.localeCompare(b.kind) || b.busyMs - a.busyMs);
  const kinds = {};
  for (const k of byKind.values()) {
    const kt = threads.filter((t) => t.kind === k.kind);
    kinds[k.kind] = {
      threads: k.threads,
      busyMs: k.busyUs / 1000,
      maxThreadBusyMsPerS: Math.max(...kt.map((t) => t.busyMsPerS)),
      self: topOf(k.self, limit, k.busyUs),
      inclusive: topOf(k.inclusive, limit, k.busyUs),
    };
  }
  return {
    file: trace.file,
    events: trace.events,
    window: { fromMs: trace.fromMs, durationMs: Number.isFinite(trace.durationMs) ? trace.durationMs : null },
    medianDeltaUs: median(threads.map((t) => t.medianDeltaUs)),
    kinds,
    threads,
  };
}

/** Busy-share delta per function and kind: `cur - base` in percentage points. */
export function diffSummaries(base, cur, limit = 15) {
  const out = {};
  for (const [kind, c] of Object.entries(cur.kinds || {})) {
    const b = base.kinds?.[kind];
    if (!b) continue;
    const bm = new Map(b.self.map((r) => [r.key, r.pct]));
    const cm = new Map(c.self.map((r) => [r.key, r.pct]));
    const keys = new Set([...bm.keys(), ...cm.keys()]);
    const rows = [...keys].map((key) => ({ key, basePct: bm.get(key) ?? 0, curPct: cm.get(key) ?? 0 }));
    for (const r of rows) r.deltaPts = r.curPct - r.basePct;
    rows.sort((x, y) => Math.abs(y.deltaPts) - Math.abs(x.deltaPts));
    out[kind] = {
      busyMsPerSBase: b.maxThreadBusyMsPerS,
      busyMsPerSCur: c.maxThreadBusyMsPerS,
      rows: rows.slice(0, limit),
    };
  }
  return out;
}
