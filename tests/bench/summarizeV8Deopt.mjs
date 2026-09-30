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

const NOISE_URL = /(?:chrome-extension:|devtools:\/\/|node:internal)/i;
const IC_KINDS = /^(LoadIC|StoreIC|KeyedLoadIC|KeyedStoreIC|LoadGlobalIC|StoreInArrayLiteralIC),/;
const IC_STATE_RE = /uninitialized|premonomorphic|monomorphic|polymorphic|megamorphic|recompute/i;

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
    for await (const line of rl) {
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
      if (IC_KINDS.test(line)) {
        icLines++;
        const cols = line.split(',');
        const kind = cols[0];
        const stateMatch = line.match(IC_STATE_RE);
        const state = stateMatch ? stateMatch[0].toLowerCase() : '?';
        bump(icState, `${kind} ${state}`);
        if (state === 'megamorphic' || /megamorph/i.test(line)) {
          megaLines++;
          const loc = stripHost(cols.slice(4).join(',').slice(0, 160));
          bump(megaIc, `${kind} ${loc}`);
        }
      }
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
