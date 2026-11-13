#!/usr/bin/env node
/**
 * What V8 made of the engine's JavaScript in Chrome: bytecode, tiers and inlining, read from the logs of a run with
 *
 *   node tests/bench/runIntegratedWorkerBenchmark.mjs --src --scene … --no-collect-detailed-stats \
 *     --js-flags="--log-code --log-code-disassemble" --v8-log-dir <dir>
 *
 * A release Chrome has no machine-code disassembler, but its log carries every function's bytecode (what Ignition
 * runs, and what TurboFan measures to decide inlining), each tier a function reached (Sparkplug ^, Maglev +,
 * TurboFan *) with the size of its machine code, and, in every optimized code object's source positions, the
 * functions it inlined, call site by call site. Per worker this lists:
 *
 *   calls    in each optimized function, the calls to the worker's own JS functions that were not inlined: real calls
 *            at run time (a frame, and doubles boxed across it: E-59, E-85), with the callee's bytecode length against
 *            the limits (TurboFan 460 bytes a callee and 920 a function, small functions of 30 bytes free; Maglev
 *            100) and the budget the caller had spent
 *   stuck    functions with self time that no optimized code inlined and that never reached TurboFan
 *   reopt    functions TurboFan compiled more than once (each recompile follows a deopt)
 *   allocs   bytecodes in hot functions that allocate or go generic (closures, literals, contexts, spreads,
 *            iterators, for-in, arguments objects), by source line; escape analysis removes some, the heap pass
 *            (heapSampleWorkers.mjs) says which are real
 *
 * With --cpu <cpu-summary.json> (summarizeChromeCpuTrace's, as profileSceneSweep's cpu pass writes it) functions are
 * ranked by their worker's self time, and a function is hot from --min-pct of it; without it, every function that
 * reached TurboFan counts as hot.
 *
 *   node tests/bench/summarizeV8Code.mjs <v8-log-dir> [--cpu cpu-summary.json] [--output code.json]
 *        [--min-pct 1] [--top 25] [--dump <dir>] [--dump-filter name,name]
 *
 * --dump writes one readable file per worker and function (the bytecode with its source lines between the
 * instructions, its tiers and its inlined and not inlined calls), for the hot functions or the named ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { normalizeUrl } from './cpuTraceLib.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';

/** V8 16's defaults (d8 --help): what a callee may weigh to be inlined. */
export const LIMITS = { turbofanCallee: 460, turbofanCumulative: 920, small: 30, maglevCallee: 100 };

const TIER_OF = { '~': 'ignition', '^': 'sparkplug', '+': 'maglev', '*': 'turbofan' };
const TIER_RANK = { ignition: 0, sparkplug: 1, maglev: 2, turbofan: 3 };

/** Bytecodes that allocate on the heap or take a generic path. */
const ALLOC_OPS = new Set([
  'CreateClosure', 'CreateFastClosure', 'CreateObjectLiteral', 'CreateEmptyObjectLiteral', 'CloneObject',
  'CreateArrayLiteral', 'CreateEmptyArrayLiteral', 'CreateArrayFromIterable', 'CreateRegExpLiteral',
  'CreateFunctionContext', 'CreateEvalContext', 'CreateBlockContext', 'CreateCatchContext', 'CreateWithContext',
  'CreateRestParameter', 'CreateMappedArguments', 'CreateUnmappedArguments', 'CallWithSpread', 'ConstructWithSpread',
  'GetIterator', 'ForInEnumerate', 'ForInPrepare', 'Construct', 'ConstructForwardAllArgs', 'ToString', 'TypeOf',
  'GetKeyedEnumeratedProperty',
]);

/** Receivers whose methods are builtins: Math.sqrt is lowered, never inlined as JS. */
const GLOBAL_RECEIVERS = new Set([
  'Math', 'Atomics', 'Number', 'Object', 'Array', 'Reflect', 'console', 'JSON', 'Date', 'performance', 'String',
  'Symbol', 'BigInt', 'Promise', 'globalThis', 'self', 'WebAssembly', 'Error', 'ArrayBuffer', 'SharedArrayBuffer',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView', 'Map', 'Set', 'WeakMap',
]);

/** Method names arrays, maps and typed arrays answer: a call to one is probably not the engine's method of that name. */
const BUILTIN_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'set', 'get', 'has', 'add', 'delete', 'clear', 'fill', 'subarray', 'slice',
  'splice', 'indexOf', 'lastIndexOf', 'includes', 'call', 'apply', 'bind', 'keys', 'values', 'entries', 'forEach',
  'map', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'sort', 'join', 'concat', 'reverse', 'toString',
  'charCodeAt', 'codePointAt', 'startsWith', 'endsWith', 'split', 'trim', 'replace', 'copyWithin', 'then', 'catch',
  'postMessage', 'next', 'resolve', 'reject', 'now', 'log', 'warn', 'error', 'notify', 'wait', 'load', 'store',
  'emit', 'on', 'off', 'update', 'destroy',
]);

const ESCAPE = /\\(\\|n|x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4}))/g;

/** Undo V8's log escapes (LogFile::MessageBuilder: \x2C for commas, \n, \\, \xHH, \uHHHH). */
export function unescapeV8(text) {
  return String(text).replace(ESCAPE, (_, c, hex2, hex4) => {
    if (c === '\\') return '\\';
    if (c === 'n') return '\n';
    return String.fromCharCode(parseInt(hex2 || hex4, 16));
  });
}

const NAME_RE = /^(.*?)\s*(\S+):(\d+):(\d+)$/;

/** `fn http://host/src/a.js?v=1:10:3` → its name, normalized url, line and column. */
export function parseCodeName(raw) {
  const m = NAME_RE.exec(raw);
  if (!m) return { name: raw.trim() || '(anonymous)', url: '', line: 0, col: 0 };
  return { name: m[1].trim() || '(anonymous)', url: normalizeUrl(m[2]), line: Number(m[3]), col: Number(m[4]) };
}

/** The inlining table of an optimized code object: `F<fn>O<pos>[I<parent>]` entries over `S<sfi>` functions. */
export function parseInlining(positions, fns) {
  const sfis = [...String(fns || '').matchAll(/S(0x[0-9a-fA-F]+)/g)].map((m) => m[1]);
  const entries = [...String(positions || '').matchAll(/F(\d+)O(\d+)(?:I(\d+))?/g)].map((m) => ({
    fn: Number(m[1]),
    pos: Number(m[2]),
    parent: m[3] === undefined ? -1 : Number(m[3]),
  }));
  return { sfis, entries };
}

const INSTR_RE = /^\s*(?:(\d+)\s+([SE])>)?\s*0x[0-9a-fA-F]+\s+@\s+(\d+)\s+:\s+((?:[0-9a-fA-F]{2}\s)+)\s*([A-Z]\w*)\s*(.*)$/;

/** Ignition's disassembly → header counts and instructions ({ pos, offset, bytes, op, args }). */
export function parseBytecode(text) {
  const out = { params: 0, registers: 0, frameSize: 0, length: 0, ops: [] };
  for (const line of String(text).split('\n')) {
    const m = INSTR_RE.exec(line);
    if (m) {
      const bytes = m[4].trim().split(/\s+/).length;
      const op = { pos: m[1] === undefined ? -1 : Number(m[1]), offset: Number(m[3]), bytes, op: m[5], args: m[6].trim() };
      out.ops.push(op);
      out.length = Math.max(out.length, op.offset + bytes);
      continue;
    }
    const h = /^(Parameter count|Register count|Frame size) (\d+)/.exec(line.trim());
    if (h) out[h[1] === 'Parameter count' ? 'params' : h[1] === 'Register count' ? 'registers' : 'frameSize'] = Number(h[2]);
  }
  return out;
}

const isCallOp = (op) => /^(Call|Construct)/.test(op) && !/^Call(Runtime|JSRuntime|RuntimeForPair)$/.test(op);
const ID_AT = /[A-Za-z_$][\w$]*/y;

/** The callee's name at a call's source position (V8 puts it on the called identifier, or on `new`, or on `(`). */
export function calleeAt(src, pos) {
  if (!src || pos < 0 || pos >= src.length) return null;
  ID_AT.lastIndex = pos;
  let m = ID_AT.exec(src);
  let start = pos;
  let name = m ? m[0] : '';
  if (name === 'new') {
    let p = pos + 3;
    while (p < src.length && /\s/.test(src[p])) p++;
    start = p;
    ID_AT.lastIndex = p;
    m = ID_AT.exec(src);
    name = m ? m[0] : '';
    let q = p + name.length;
    while (m && src[q] === '.') {
      ID_AT.lastIndex = q + 1;
      m = ID_AT.exec(src);
      if (m) {
        start = q + 1;
        name = m[0];
        q = start + name.length;
      }
    }
  } else if (!name) {
    let q = pos - 1;
    while (q >= 0 && /\s/.test(src[q])) q--;
    const end = q + 1;
    while (q >= 0 && /[\w$]/.test(src[q])) q--;
    start = q + 1;
    name = src.slice(start, end);
  }
  if (!name) return null;
  let r = start - 1;
  while (r >= 0 && /\s/.test(src[r])) r--;
  let receiver = null;
  if (src[r] === '.') {
    let q = r - 1;
    if (src[q] === '?') q--;
    const end = q + 1;
    while (q >= 0 && /[\w$]/.test(src[q])) q--;
    receiver = src.slice(q + 1, end) || '(expr)';
  }
  return { name, receiver };
}

function lineStarts(script) {
  if (!script.starts) {
    const starts = [0];
    const s = script.source;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) starts.push(i + 1);
    script.starts = starts;
  }
  return script.starts;
}

/** 1-based line of a script offset. */
export function lineOf(script, pos) {
  if (!script || pos < 0) return 0;
  const starts = lineStarts(script);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function sourceLineText(script, line) {
  if (!script || line < 1) return '';
  const starts = lineStarts(script);
  const a = starts[line - 1];
  const b = line < starts.length ? starts[line] - 1 : script.source.length;
  return script.source.slice(a, b).replace(/\r$/, '');
}

/** One isolate's log → scripts, functions (by SharedFunctionInfo) and code objects. */
export async function readIsolateLog(file) {
  const iso = { file, kind: null, label: null, scripts: new Map(), fns: new Map(), codes: new Map() };
  const fnFor = (sfi) => {
    let fn = iso.fns.get(sfi);
    if (!fn) {
      fn = { sfi, name: '(unknown)', url: '', line: 0, col: 0, key: '', bytecodeLen: 0, scriptId: -1, start: -1, end: -1, bytecodeText: '', codes: [] };
      iso.fns.set(sfi, fn);
    }
    return fn;
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const c = line.indexOf(',');
    const tag = c < 0 ? line : line.slice(0, c);
    if (tag === 'code-creation') {
      const p = line.split(',');
      if (p.length < 9) continue;
      // `o` before the tier marks code compiled on stack replacement (entered from a hot loop).
      const osr = p[8][0] === 'o';
      const tier = TIER_OF[p[8][osr ? 1 : 0]];
      if (!tier) continue;
      const fn = fnFor(p[7]);
      if (fn.name === '(unknown)') {
        Object.assign(fn, parseCodeName(unescapeV8(p[6])));
        fn.key = `${fn.name} ${fn.url}:${fn.line}`;
      }
      const code = { fn, tier, osr, time: Number(p[3]), addr: p[4], size: Number(p[5]), inlined: null };
      iso.codes.set(code.addr, code);
      fn.codes.push(code);
      if (tier === 'ignition') fn.bytecodeLen = code.size;
    } else if (tag === 'code-source-info') {
      const p = line.split(',');
      const code = iso.codes.get(p[1]);
      if (!code) continue;
      if (code.tier === 'ignition') {
        code.fn.scriptId = Number(p[2]);
        code.fn.start = Number(p[3]);
        code.fn.end = Number(p[4]);
      } else {
        const { sfis, entries } = parseInlining(p[6], p[7]);
        code.inlined = { fns: sfis.map(fnFor), entries };
      }
    } else if (tag === 'code-disassemble') {
      const p = line.split(',');
      const code = iso.codes.get(p[1]);
      if (code && code.tier === 'ignition' && p[2] === 'INTERPRETED_FUNCTION') code.fn.bytecodeText = unescapeV8(p.slice(3).join(','));
    } else if (tag === 'script-source') {
      const p = line.split(',');
      iso.scripts.set(Number(p[1]), { url: normalizeUrl(unescapeV8(p[2])), source: unescapeV8(p.slice(3).join(',')), starts: null });
    } else if (tag === 'sfi-move') {
      const p = line.split(',');
      const fn = iso.fns.get(p[1]);
      if (fn) {
        iso.fns.delete(p[1]);
        fn.sfi = p[2];
        iso.fns.set(p[2], fn);
      }
    } else if (tag === 'code-move') {
      const p = line.split(',');
      const code = iso.codes.get(p[1]);
      if (code) {
        iso.codes.delete(p[1]);
        code.addr = p[2];
        iso.codes.set(p[2], code);
      }
    }
  }
  iso.kind = isolateKind(iso);
  return iso;
}

/** The worker an isolate is, from the scripts it loaded. */
export function isolateKind(iso) {
  const urls = [...iso.scripts.values()].map((s) => s.url);
  for (const u of urls) {
    const w = /\/workers\/(logic|spatial|preRender|pixi|particle)Worker\.js$/.exec(u);
    if (w) return w[1];
  }
  if (urls.some((u) => /\/box2d\/(weedjsPost|box2dWasm|physicsHostImpl)\.js$/.test(u))) return 'physics';
  if (urls.some((u) => u.startsWith('/src/'))) return 'main';
  return null;
}

function prepare(iso) {
  iso.byName = new Map();
  for (const fn of iso.fns.values()) {
    if (!fn.bytecodeText) continue;
    fn.bc = parseBytecode(fn.bytecodeText);
    if (!fn.bytecodeLen) fn.bytecodeLen = fn.bc.length;
    fn.script = iso.scripts.get(fn.scriptId) || null;
    fn.top = fn.codes.reduce((t, c) => (TIER_RANK[c.tier] > TIER_RANK[t] ? c.tier : t), 'ignition');
    // Only OSR code at the top tier: the loop runs optimized, each call still enters below it.
    fn.topOsr = fn.codes.some((c) => c.tier === fn.top) && fn.codes.every((c) => c.tier !== fn.top || c.osr);
    fn.turbofanCompiles = fn.codes.filter((c) => c.tier === 'turbofan');
    const latest = (want) => [...fn.codes].reverse().find(want) || null;
    fn.optimized = latest((c) => c.tier === 'turbofan' && !c.osr) || latest((c) => c.tier === 'turbofan') || latest((c) => c.tier === 'maglev');
    const list = iso.byName.get(fn.name) || [];
    list.push(fn);
    iso.byName.set(fn.name, list);
  }
}

/** A function's call sites: position, source line, callee name and receiver. */
function callSites(fn) {
  if (fn.sites) return fn.sites;
  const sites = [];
  if (fn.bc) {
    let lastPos = -1;
    for (const op of fn.bc.ops) {
      if (op.pos >= 0) lastPos = op.pos;
      if (!isCallOp(op.op)) continue;
      const pos = op.pos >= 0 ? op.pos : lastPos;
      const callee = fn.script ? calleeAt(fn.script.source, pos) : null;
      sites.push({ pos, op: op.op, name: callee?.name || '', receiver: callee?.receiver || null, line: lineOf(fn.script, pos) });
    }
  }
  fn.sites = sites;
  return sites;
}

/** Every call of an optimized code object, inlined or not, frame by frame of its inlining tree. */
export function analyzeOptimized(iso, code) {
  const fnsOf = code.inlined?.fns || [];
  const entries = code.inlined?.entries || [];
  const at = new Map();
  entries.forEach((e, k) => {
    const id = `${e.parent}:${e.pos}`;
    if (!at.has(id)) at.set(id, []);
    at.get(id).push(k);
  });
  const limit = code.tier === 'turbofan' ? LIMITS.turbofanCallee : LIMITS.maglevCallee;
  let spent = 0;
  for (const e of entries) {
    const len = fnsOf[e.fn]?.bytecodeLen || 0;
    if (len > LIMITS.small) spent += len;
  }
  const chainOf = (k) => {
    const chain = [];
    for (let j = k; j >= 0; j = entries[j].parent) chain.unshift(fnsOf[entries[j].fn]?.name || '?');
    return chain;
  };
  const frames = [{ id: -1, fn: code.fn, chain: [] }, ...entries.map((e, k) => ({ id: k, fn: fnsOf[e.fn], chain: chainOf(k) }))];
  const notInlined = [];
  let matched = 0;
  for (const frame of frames) {
    if (!frame.fn) continue;
    for (const site of callSites(frame.fn)) {
      if (at.has(`${frame.id}:${site.pos}`)) {
        matched += at.get(`${frame.id}:${site.pos}`).length;
        continue;
      }
      if (!site.name || (site.receiver && GLOBAL_RECEIVERS.has(site.receiver))) continue;
      const cands = (iso.byName.get(site.name) || []).filter((f) => f.bytecodeLen > 0);
      if (!cands.length) continue;
      const sizes = [...new Set(cands.map((f) => f.bytecodeLen))].sort((a, b) => a - b);
      let reason;
      if (sizes[0] > limit) reason = `too big (${sizes.join('/')} > ${limit})`;
      else if (code.tier === 'turbofan' && spent + sizes[0] > LIMITS.turbofanCumulative && sizes[0] > LIMITS.small) reason = `budget (${spent} spent of ${LIMITS.turbofanCumulative})`;
      else if (cands.length > 1) reason = `${cands.length} functions of that name`;
      else reason = 'small enough: cold site, no feedback or a polymorphic target';
      notInlined.push({
        caller: code.fn.key,
        in: frame.chain.length ? frame.chain.join(' > ') : '',
        line: site.line,
        file: frame.fn.url,
        callee: site.name,
        receiver: site.receiver,
        op: site.op,
        calleeKeys: cands.map((f) => f.key),
        sizes,
        reason,
        maybeBuiltin: BUILTIN_METHODS.has(site.name) && site.receiver !== 'this',
      });
    }
  }
  return { tier: code.tier, machineBytes: code.size, inlinedCount: entries.length, spent, matched, notInlined };
}

function allocSites(fn) {
  const rows = new Map();
  let lastPos = -1;
  for (const op of fn.bc?.ops || []) {
    if (op.pos >= 0) lastPos = op.pos;
    if (!ALLOC_OPS.has(op.op)) continue;
    const line = lineOf(fn.script, op.pos >= 0 ? op.pos : lastPos);
    const id = `${op.op}:${line}`;
    const row = rows.get(id) || { op: op.op, line, count: 0, text: sourceLineText(fn.script, line).trim().slice(0, 120) };
    row.count++;
    rows.set(id, row);
  }
  return [...rows.values()];
}

/** CPU self time by function key for one worker kind, from summarizeChromeCpuTrace's JSON. */
export function cpuSelf(summary, kind) {
  const map = new Map();
  const k = summary?.kinds?.[kind];
  if (!k) return map;
  const busy = (k.self || []).reduce((s, f) => s + f.ms, 0);
  for (const f of k.self || []) map.set(f.key, { ms: f.ms, pct: busy > 0 ? (100 * f.ms) / busy : 0 });
  return map;
}

/** Fold a key's line away, for a profile taken on a slightly different revision. */
const looseKey = (key) => key.replace(/:\d+$/, '');

/** Summarize one worker kind (its isolates merged): hot functions, calls left out, stuck, reopt, allocations. */
export function summarizeKind(kind, isolates, cpu, { minPct = 1 } = {}) {
  const self = cpuSelf(cpu, kind);
  const loose = new Map();
  for (const [key, v] of self) {
    const lk = looseKey(key);
    const prev = loose.get(lk);
    loose.set(lk, prev ? { ms: prev.ms + v.ms, pct: prev.pct + v.pct } : v);
  }
  const selfOf = (fn) => self.get(fn.key) || loose.get(looseKey(fn.key)) || null;
  const byKey = new Map();
  const inlinedSomewhere = new Set();
  for (const iso of isolates) {
    for (const fn of iso.fns.values()) {
      // Inlined anywhere counts, game code's callers too (Predator's FSMs inline getNeighbor and setAnimationSpeed).
      for (const c of fn.codes) for (const f of c.inlined?.fns || []) inlinedSomewhere.add(f.key);
      if (!fn.bc || !fn.url.startsWith('/src/')) continue;
      const prev = byKey.get(fn.key);
      if (!prev || TIER_RANK[fn.top] > TIER_RANK[prev.fn.top]) byKey.set(fn.key, { fn, iso });
    }
  }
  const hot = [];
  for (const { fn, iso } of byKey.values()) {
    const s = selfOf(fn);
    const isHot = s ? s.pct >= minPct : cpu ? false : fn.top === 'turbofan';
    if (!isHot) continue;
    hot.push({ fn, iso, self: s });
  }
  hot.sort((a, b) => (b.self?.ms || 0) - (a.self?.ms || 0) || b.fn.bytecodeLen - a.fn.bytecodeLen);
  const functions = [];
  const calls = [];
  const stuck = [];
  const allocs = [];
  for (const { fn, iso, self: s } of hot) {
    const opt = fn.optimized ? analyzeOptimized(iso, fn.optimized) : null;
    functions.push({
      key: fn.key,
      selfMs: s ? +s.ms.toFixed(2) : null,
      selfPct: s ? +s.pct.toFixed(2) : null,
      bytecode: fn.bytecodeLen,
      registers: fn.bc.registers,
      top: fn.topOsr ? `${fn.top} (OSR only)` : fn.top,
      turbofanCompiles: fn.turbofanCompiles.length,
      machineBytes: opt?.machineBytes ?? 0,
      inlined: opt?.inlinedCount ?? 0,
      budgetSpent: opt?.spent ?? 0,
      sitesMatched: opt?.matched ?? 0,
      inlinedInto: inlinedSomewhere.has(fn.key),
    });
    for (const n of opt?.notInlined || []) {
      const calleeSelf = n.calleeKeys.map((k) => self.get(k) || loose.get(looseKey(k))).filter(Boolean);
      calls.push({ ...n, callerMs: s?.ms ?? 0, calleeMs: calleeSelf.reduce((t, v) => t + v.ms, 0) });
    }
    if (fn.top !== 'turbofan' && !inlinedSomewhere.has(fn.key)) {
      stuck.push({ key: fn.key, top: fn.top, bytecode: fn.bytecodeLen, maglevCompiles: fn.codes.filter((c) => c.tier === 'maglev').length, selfMs: s?.ms ?? null });
    }
    const a = allocSites(fn);
    if (a.length) allocs.push({ key: fn.key, selfMs: s?.ms ?? null, sites: a });
  }
  const reopt = [];
  for (const { fn } of byKey.values()) {
    if (fn.turbofanCompiles.length < 2) continue;
    reopt.push({ key: fn.key, compiles: fn.turbofanCompiles.length, atS: fn.turbofanCompiles.map((c) => +(c.time / 1e6).toFixed(2)), selfMs: selfOf(fn)?.ms ?? null });
  }
  reopt.sort((a, b) => b.compiles - a.compiles);
  const seen = new Set();
  const dedup = calls.filter((c) => {
    const id = `${c.caller}|${c.in}|${c.file}:${c.line}|${c.callee}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  dedup.sort((a, b) => b.calleeMs + b.callerMs - (a.calleeMs + a.callerMs));
  return { kind, isolates: isolates.length, functions, calls: dedup, stuck, reopt, allocs };
}

/** A function's bytecode with the source line each run of instructions comes from, and what TurboFan did with it. */
export function dumpFunction(iso, fn) {
  const lines = [];
  lines.push(`${fn.key}  [${iso.kind}]`);
  lines.push(`bytecode ${fn.bytecodeLen} bytes, ${fn.bc.registers} registers, ${fn.bc.params} parameters; tiers: ${fn.codes.map((c) => `${c.tier}${c.osr ? '(OSR)' : ''}@${(c.time / 1e6).toFixed(2)}s(${c.size}B)`).join(' ')}`);
  if (fn.optimized) {
    const a = analyzeOptimized(iso, fn.optimized);
    const inl = fn.optimized.inlined;
    lines.push(`${a.tier}${fn.optimized.osr ? ' (OSR)' : ''}: ${a.machineBytes} bytes of machine code, ${a.inlinedCount} inlined (${a.spent} of ${LIMITS.turbofanCumulative} bytes of budget)`);
    (inl?.entries || []).forEach((e, k) => {
      const f = inl.fns[e.fn];
      const parent = e.parent < 0 ? fn : inl.fns[inl.entries[e.parent].fn];
      lines.push(`  inlined #${k}: ${f?.name} (${f?.bytecodeLen} B) at ${parent?.url}:${lineOf(parent?.script, e.pos)}${e.parent >= 0 ? ` inside #${e.parent}` : ''}`);
    });
    for (const n of a.notInlined) lines.push(`  NOT inlined: ${n.callee} at ${n.file}:${n.line}${n.in ? ` (in ${n.in})` : ''}: ${n.reason}${n.maybeBuiltin ? ' [maybe a builtin]' : ''}`);
  }
  lines.push('');
  let lastLine = -1;
  for (const op of fn.bc.ops) {
    if (op.pos >= 0) {
      const line = lineOf(fn.script, op.pos);
      if (line !== lastLine) {
        lines.push(`        // ${line}: ${sourceLineText(fn.script, line).trim()}`);
        lastLine = line;
      }
    }
    const mark = ALLOC_OPS.has(op.op) ? ' <alloc>' : '';
    lines.push(`  @${String(op.offset).padStart(5)}  ${op.op} ${op.args}${mark}`);
  }
  return lines.join('\n');
}

function fmtCall(c) {
  const where = c.in ? ` (inlined path ${c.in})` : '';
  const ms = c.calleeMs ? `, callee ${c.calleeMs.toFixed(1)} ms` : '';
  return `- \`${c.caller.replace(/ \/src\//, ' ')}\` → \`${c.callee}\` at ${c.file.replace('/src/', '')}:${c.line}${where}: ${c.reason}${ms}${c.maybeBuiltin ? ' (maybe a builtin)' : ''}`;
}

export function renderMarkdown(kinds, { top = 25 } = {}) {
  const out = [];
  for (const k of kinds) {
    out.push(`## ${k.kind} (${k.isolates} isolate${k.isolates > 1 ? 's' : ''})`, '');
    out.push('| function | self ms | bytecode B | tier | TF compiles | machine B | inlined | budget |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const f of k.functions.slice(0, top)) {
      out.push(`| \`${f.key.replace(/ \/src\//, ' ')}\` | ${f.selfMs ?? '–'} | ${f.bytecode}${f.bytecode > LIMITS.turbofanCallee ? ' (>460)' : ''} | ${f.top}${f.inlinedInto ? ' (also inlined)' : ''} | ${f.turbofanCompiles} | ${f.machineBytes} | ${f.inlined} | ${f.budgetSpent} |`);
    }
    out.push('');
    const real = k.calls.filter((c) => !c.maybeBuiltin);
    out.push(`Calls not inlined in hot optimized code (${real.length}, builtin-named ${k.calls.length - real.length} left out):`);
    for (const c of real.slice(0, top)) out.push(fmtCall(c));
    out.push('');
    if (k.stuck.length) {
      out.push('Hot, never in TurboFan, inlined nowhere:');
      for (const s of k.stuck.slice(0, top)) out.push(`- \`${s.key.replace(/ \/src\//, ' ')}\` top ${s.top}, ${s.bytecode} B, ${s.maglevCompiles} Maglev compiles${s.selfMs != null ? `, ${s.selfMs.toFixed(1)} ms` : ''}`);
      out.push('');
    }
    if (k.reopt.length) {
      out.push('Compiled by TurboFan more than once:');
      for (const r of k.reopt.slice(0, top)) out.push(`- \`${r.key.replace(/ \/src\//, ' ')}\` ×${r.compiles} at ${r.atS.join(', ')} s${r.selfMs != null ? ` (${r.selfMs.toFixed(1)} ms self)` : ''}`);
      out.push('');
    }
    if (k.allocs.length) {
      out.push('Allocating or generic bytecodes in hot functions:');
      for (const a of k.allocs.slice(0, top)) {
        out.push(`- \`${a.key.replace(/ \/src\//, ' ')}\`: ${a.sites.map((s) => `${s.op}${s.count > 1 ? `×${s.count}` : ''} L${s.line}`).join(', ')}`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

const safeFile = (s) => s.replace(/[^A-Za-z0-9._@-]+/g, '_').slice(0, 120);

export async function summarizeCodeLogs(dir, opts = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => path.join(dir, f));
  const isolates = [];
  for (const file of files) {
    const iso = await readIsolateLog(file);
    if (!iso.kind) continue;
    prepare(iso);
    isolates.push(iso);
  }
  const cpu = opts.cpu ? JSON.parse(fs.readFileSync(opts.cpu, 'utf8')) : null;
  const kinds = [...new Set(isolates.map((i) => i.kind))].sort();
  const result = kinds.map((kind) => summarizeKind(kind, isolates.filter((i) => i.kind === kind), cpu, opts));
  if (opts.dump) {
    const filter = opts.dumpFilter ? new Set(opts.dumpFilter) : null;
    for (const k of result) {
      const want = filter ? null : new Set(k.functions.map((f) => f.key));
      const done = new Set();
      for (const iso of isolates.filter((i) => i.kind === k.kind)) {
        for (const fn of iso.fns.values()) {
          if (!fn.bc || done.has(fn.key)) continue;
          if (filter ? !filter.has(fn.name) : !want.has(fn.key)) continue;
          done.add(fn.key);
          const d = path.join(opts.dump, k.kind);
          fs.mkdirSync(d, { recursive: true });
          const file = `${safeFile(fn.name)}@${safeFile(path.basename(fn.url))}_${fn.line}.txt`;
          fs.writeFileSync(path.join(d, file), dumpFunction(iso, fn) + '\n');
        }
      }
    }
  }
  return result;
}

async function main() {
  const args = parseArgs();
  const argv = process.argv.slice(2);
  const valueFlags = new Set(['--cpu', '--output', '--min-pct', '--top', '--dump', '--dump-filter']);
  const dir = argv.find((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1]));
  if (!dir) throw new Error('usage: summarizeV8Code.mjs <v8-log-dir> [--cpu cpu-summary.json] [--output code.json] [--dump dir]');
  const opts = {
    cpu: args.cpu ? String(args.cpu) : null,
    minPct: Number(args['min-pct'] ?? 1),
    dump: args.dump ? String(args.dump) : null,
    dumpFilter: args['dump-filter'] ? String(args['dump-filter']).split(',').map((s) => s.trim()) : null,
  };
  const result = await summarizeCodeLogs(dir, opts);
  const md = renderMarkdown(result, { top: Number(args.top ?? 25) });
  console.log(md);
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(String(args.output))), { recursive: true });
    fs.writeFileSync(String(args.output), JSON.stringify({ limits: LIMITS, kinds: result }, null, 2));
  }
}

if (isCli(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
