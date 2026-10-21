#!/usr/bin/env node
/**
 * Rank V8 deopts / ICs and optional Chrome CPU samples.
 *
 *   node tests/bench/summarizeV8Deopt.mjs tests/results/v8-deopt/chromium-logs
 *   node tests/bench/summarizeV8Deopt.mjs tests/results/v8-deopt --trace tests/results/v8-deopt/engine_trace.json
 *
 * Frequency is the signal. Warmup-only deopts show up a handful of times;
 * a per-frame deopt shows up thousands of times. A deopt in a cold function
 * does not matter, so the ranking is steady-state count × that function's
 * self ms in the CPU trace (same streaming parser as summarizeChromeCpuTrace).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { normalizeUrl, readCpuTrace, summarizeCpuTrace } from './cpuTraceLib.mjs';
import { isCli } from './microbenchHelpers.mjs';

const NOISE_URL = /(?:chrome-extension:|chrome:\/\/|devtools:\/\/|node:internal)/i;
const IC_KINDS = /^(LoadIC|StoreIC|KeyedLoadIC|KeyedStoreIC|LoadGlobalIC|StoreGlobalIC|StoreInArrayLiteralIC|DefineKeyedOwnIC|DefineNamedOwnIC),/;
const IC_STATE_RE = /uninitialized|premonomorphic|monomorphic|polymorphic|megamorphic|recompute/i;
// Current V8 logs `kind,pc,time,line,column,old,new,map,key,modifier,slowReason`
// with one-letter states (ic.cc TransitionMarkFromState). Matching the words
// alone found none of them, so every summary said "no megamorphic IC lines" (N-33).
const IC_STATE_CODES = {
  X: 'no-feedback',
  0: 'uninitialized',
  1: 'monomorphic',
  '^': 'recompute',
  P: 'polymorphic',
  N: 'megamorphic',
  D: 'megadom',
  G: 'generic',
};

function parseArgs(argv) {
  const out = { dir: null, trace: null, limit: 40, warmupMs: DEFAULT_WARMUP_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trace' && argv[i + 1]) out.trace = path.resolve(argv[++i]);
    else if (a === '--limit' && argv[i + 1]) out.limit = Math.max(1, parseInt(argv[++i], 10) || 40);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = Number(argv[++i]);
    else if (!a.startsWith('--') && !out.dir) out.dir = path.resolve(a);
  }
  return out;
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  const st = fs.statSync(dir);
  if (st.isFile()) {
    acc.push(dir);
    return acc;
  }
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const s = fs.statSync(p);
      if (s.isDirectory()) walkFiles(p, acc);
      else acc.push(p);
    } catch {
      /* ignore */
    }
  }
  return acc;
}

function looksLikeLog(file) {
  const base = path.basename(file).toLowerCase();
  return (
    base.includes('v8') ||
    base.endsWith('.log') ||
    base.includes('dumpio') ||
    base.includes('chrome_debug') ||
    base.includes('stderr')
  );
}

function stripHost(url) {
  return String(url || '').replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').replace(/^https?:\/\/[^/]+/, '');
}

/**
 * One IC line. `state` is the state it moved to; `pc` locates the code that
 * owns the IC (see codeAt).
 * @returns {{ kind: string, pc: number, tsUs: number, line: string, col: string, state: string, key: string } | null}
 */
export function parseIcLine(line) {
  const kind = line.match(IC_KINDS);
  if (!kind) return null;
  const cols = line.split(',');
  const coded = IC_STATE_CODES[cols[6]];
  const worded = coded ? null : (IC_STATE_RE.test(cols[6] || '') ? [cols[6]] : line.match(IC_STATE_RE));
  return {
    kind: kind[1],
    pc: parseInt(cols[1], 16),
    tsUs: Number(cols[2]) || 0,
    line: cols[3],
    col: cols[4],
    state: coded || (worded ? worded[0].toLowerCase() : '?'),
    key: cols[8] ?? '',
  };
}

/** `code-creation,<tag>,<kind>,<ts>,<addr>,<size>,<name...>,<sfi>,<tier>` → a code range. */
export function parseCodeCreation(line) {
  if (!line.startsWith('code-creation,')) return null;
  const cols = line.split(',');
  const start = parseInt(cols[4], 16);
  const size = Number(cols[5]);
  if (!Number.isFinite(start) || !(size > 0)) return null;
  const name = cols.slice(6, -2).join(',');
  return { start, end: start + size, name: normalizeUrl(stripHost(name.replace(/ https?:\/\/[^/]+/, ' '))) };
}

/** The code range containing pc, from ranges sorted by start. */
export function codeAt(ranges, pc) {
  let lo = 0;
  let hi = ranges.length - 1;
  let hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start <= pc) {
      hit = ranges[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit && pc < hit.end ? hit : null;
}

function parseCodeDeopt(line) {
  if (!line.startsWith('code-deopt,')) return null;
  const locMatch = line.match(/<([^>]+)>/);
  const loc = locMatch ? locMatch[1] : '';
  if (NOISE_URL.test(loc)) return null;
  const after = line.includes('>,') ? line.slice(line.lastIndexOf('>,') + 2) : '';
  const kindMatch = line.match(/,(deopt-eager|deopt-lazy|dependency-change),/);
  const tsUs = Number(line.split(',')[1]);
  return {
    loc: normalizeUrl(stripHost(loc).replace(/:(\d+):(\d+)$/, '')) + (loc.match(/:(\d+):(\d+)$/)?.[0] ?? ''),
    reason: (after || 'unknown').trim(),
    kind: kindMatch ? kindMatch[1] : 'deopt',
    tsUs: Number.isFinite(tsUs) ? tsUs : 0,
  };
}

async function parseTextLogs(files, warmupMs) {
  const deoptByFn = new Map();
  const deoptByReason = new Map();
  const deoptByPair = new Map();
  const steadyByPair = new Map();
  const icState = new Map();
  const megaIc = new Map();
  const sourceHits = new Map();
  let deoptLines = 0;
  let megaLines = 0;
  let icLines = 0;

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    // Code addresses are per isolate, so each log resolves its own ICs.
    const ranges = [];
    const megaEvents = [];
    for await (const line of rl) {
      const code = parseCodeCreation(line);
      if (code) {
        ranges.push(code);
        continue;
      }
      const deopt = parseCodeDeopt(line);
      if (deopt) {
        deoptLines++;
        const fn = deopt.loc || 'unknown';
        bump(deoptByFn, fn);
        bump(deoptByReason, `${deopt.kind}: ${deopt.reason}`);
        bump(deoptByPair, `${fn} | ${deopt.kind} | ${deopt.reason}`);
        if (deopt.tsUs >= warmupMs * 1000) bump(steadyByPair, `${fn} | ${deopt.kind} | ${deopt.reason}`);
        const src = fn.match(/(\/(?:src|demos|tests)\/[^:]+\.js)(?::(\d+))?/);
        if (src) bump(sourceHits, `${src[1]}${src[2] ? ':' + src[2] : ''}`);
        continue;
      }
      if (line.length > 500) continue;
      const ic = parseIcLine(line);
      if (ic) {
        icLines++;
        bump(icState, `${ic.kind} ${ic.state}`);
        if (ic.state === 'megamorphic' || ic.state === 'generic') {
          megaLines++;
          megaEvents.push(ic);
        }
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    for (const ic of megaEvents) {
      const fn = codeAt(ranges, ic.pc);
      if (fn && NOISE_URL.test(fn.name)) continue;
      const phase = ic.tsUs >= warmupMs * 1000 ? 'steady' : 'warm-up';
      bump(megaIc, `${phase} ${ic.state} ${ic.kind} ${fn ? fn.name : '(no code)'} @${ic.line}:${ic.col} key=${ic.key}`);
    }
  }

  return {
    deoptByFn,
    deoptByReason,
    deoptByPair,
    steadyByPair,
    icState,
    megaIc,
    sourceHits,
    deoptLines,
    megaLines,
    icLines,
  };
}

/** Self ms per function key ("name /url:startLine"), summed over every thread kind. */
async function cpuSelfByFunction(tracePath, warmupMs) {
  if (!tracePath || !fs.existsSync(tracePath)) return { selfMs: new Map(), note: 'no trace' };
  const trace = await readCpuTrace(tracePath, { fromMs: warmupMs });
  const summary = summarizeCpuTrace(trace, { limit: 400 });
  const selfMs = new Map();
  for (const k of Object.values(summary.kinds)) {
    for (const r of k.self) bump(selfMs, r.key, r.ms);
  }
  return { selfMs, note: `${trace.events} events, window from ${warmupMs} ms` };
}

/** Deopt position "/url:line:col" → the CPU function whose start line is the closest one above. */
function functionForDeopt(loc, byUrl) {
  const m = loc.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  const list = byUrl.get(m[1]);
  if (!list) return null;
  const line = Number(m[2]);
  let best = null;
  for (const f of list) {
    if (f.line <= line && (!best || f.line > best.line)) best = f;
  }
  return best;
}

function rankDeopts(steadyByPair, selfMs) {
  const byUrl = new Map();
  for (const [key, ms] of selfMs) {
    const m = key.match(/^(\S+) (\/\S+):(\d+)$/);
    if (!m) continue;
    let list = byUrl.get(m[2]);
    if (!list) byUrl.set(m[2], (list = []));
    list.push({ key, line: Number(m[3]), ms });
  }
  const rows = [];
  for (const [pair, count] of steadyByPair) {
    const loc = pair.split(' | ')[0];
    const fn = functionForDeopt(loc, byUrl);
    const ms = fn?.ms ?? 0;
    rows.push({ pair, steadyCount: count, fn: fn?.key ?? null, selfMs: ms, score: count * ms });
  }
  return rows.sort((a, b) => b.score - a.score || b.steadyCount - a.steadyCount);
}

function printSection(title, rows, empty) {
  console.log(`\n## ${title}`);
  if (!rows.length) {
    console.log(empty || '(none)');
    return;
  }
  for (const [k, n] of rows) {
    console.log(`${String(n).padStart(8)}  ${k}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir || path.resolve('tests/results/v8-deopt');
  const files = walkFiles(dir).filter(looksLikeLog);
  const parsed = await parseTextLogs(files, args.warmupMs);
  const tracePath =
    args.trace ||
    (fs.existsSync(path.join(path.dirname(dir), 'engine_trace.json'))
      ? path.join(path.dirname(dir), 'engine_trace.json')
      : fs.existsSync(path.join(dir, 'engine_trace.json'))
        ? path.join(dir, 'engine_trace.json')
        : null);
  const cpu = await cpuSelfByFunction(tracePath, args.warmupMs);
  const ranked = rankDeopts(parsed.steadyByPair, cpu.selfMs);

  const report = {
    dir,
    files: files.map((f) => path.relative(dir, f)),
    deoptLines: parsed.deoptLines,
    megaLines: parsed.megaLines,
    icLines: parsed.icLines,
    deoptByFn: Object.fromEntries(topEntries(parsed.deoptByFn, args.limit)),
    deoptByReason: Object.fromEntries(topEntries(parsed.deoptByReason, args.limit)),
    deoptByPair: Object.fromEntries(topEntries(parsed.deoptByPair, args.limit)),
    icState: Object.fromEntries(topEntries(parsed.icState, args.limit)),
    megaIc: Object.fromEntries(topEntries(parsed.megaIc, args.limit)),
    sourceHits: Object.fromEntries(topEntries(parsed.sourceHits, args.limit)),
    steadyByPair: Object.fromEntries(topEntries(parsed.steadyByPair, args.limit)),
    cpuNote: cpu.note,
    cpuTopSelfMs: Object.fromEntries(topEntries(cpu.selfMs, args.limit)),
    rankedSteadyDeopts: ranked.slice(0, args.limit),
  };

  const outJson = path.join(dir, 'summary.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`Logs scanned: ${files.length} under ${dir}`);
  console.log(
    `Deopt-like lines: ${parsed.deoptLines} | IC lines: ${parsed.icLines} | megamorphic IC lines: ${parsed.megaLines}`
  );
  printSection('Deopts by location', topEntries(parsed.deoptByFn, args.limit), '(no deopt lines found)');
  printSection('Deopts by reason', topEntries(parsed.deoptByReason, 20));
  printSection('Deopt location + reason', topEntries(parsed.deoptByPair, args.limit));
  printSection('IC state histogram', topEntries(parsed.icState, 20));
  printSection('Megamorphic ICs', topEntries(parsed.megaIc, args.limit), '(no megamorphic IC lines)');
  printSection('Source path hits in deopts', topEntries(parsed.sourceHits, args.limit));
  console.log(`\nCPU trace: ${cpu.note}`);
  printSection(
    'CPU self ms (JS)',
    topEntries(cpu.selfMs, args.limit).map(([k, v]) => [k, v.toFixed(1)]),
    '(no JS samples in trace)'
  );
  console.log(`\n## Steady deopts (after ${args.warmupMs} ms) × self ms of the function`);
  if (!ranked.length) console.log('(none)');
  for (const r of ranked.slice(0, args.limit)) {
    console.log(
      `${r.score.toFixed(0).padStart(10)}  ${String(r.steadyCount).padStart(6)} × ${r.selfMs.toFixed(1).padStart(8)} ms  ${r.pair}  [${r.fn ?? 'no CPU match'}]`
    );
  }
  console.log(`\nWrote ${outJson}`);
}

if (isCli(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
