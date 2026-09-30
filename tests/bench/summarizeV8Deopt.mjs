#!/usr/bin/env node
/**
 * Rank V8 deopts / ICs and optional Chrome CPU samples.
 *
 *   node tests/bench/summarizeV8Deopt.mjs tests/results/v8-deopt/chromium-logs
 *   node tests/bench/summarizeV8Deopt.mjs tests/results/v8-deopt --trace tests/results/v8-deopt/engine_trace.json
 *
 * Frequency is the signal. Warmup-only deopts show up a handful of times;
 * a per-frame deopt shows up thousands of times.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const NOISE_URL = /(?:chrome-extension:|devtools:\/\/|node:internal)/i;
const IC_KINDS = /^(LoadIC|StoreIC|KeyedLoadIC|KeyedStoreIC|LoadGlobalIC|StoreInArrayLiteralIC),/;
const IC_STATE_RE = /uninitialized|premonomorphic|monomorphic|polymorphic|megamorphic|recompute/i;

function parseArgs(argv) {
  const out = { dir: null, trace: null, limit: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trace' && argv[i + 1]) out.trace = path.resolve(argv[++i]);
    else if (a === '--limit' && argv[i + 1]) out.limit = Math.max(1, parseInt(argv[++i], 10) || 40);
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
  return {
    loc: stripHost(loc),
    reason: (after || 'unknown').trim(),
    kind: kindMatch ? kindMatch[1] : 'deopt',
  };
}

async function parseTextLogs(files) {
  const deoptByFn = new Map();
  const deoptByReason = new Map();
  const deoptByPair = new Map();
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
    icState,
    megaIc,
    sourceHits,
    deoptLines,
    megaLines,
    icLines,
  };
}

function collectCpuFromProfile(cpuProfile, samples) {
  const nodes = cpuProfile.nodes || [];
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);
  const counts = new Map();
  const sampleList = cpuProfile.samples || samples || [];
  for (const id of sampleList) {
    const node = byId.get(id);
    if (!node) continue;
    const frame = node.callFrame || node;
    const name = frame.functionName || node.functionName || '(anonymous)';
    const url = stripHost(frame.url || node.url || '');
    if (NOISE_URL.test(url)) continue;
    const line = frame.lineNumber != null ? `:${frame.lineNumber}` : '';
    bump(counts, `${name} ${url}${line}`.trim());
  }
  return counts;
}

function mergeMaps(into, from) {
  for (const [k, v] of from) bump(into, k, v);
}

function parseChromeTrace(tracePath) {
  if (!tracePath || !fs.existsSync(tracePath)) return { cpu: new Map(), note: 'no trace' };
  const st = fs.statSync(tracePath);
  if (st.size > 80e6) {
    return {
      cpu: new Map(),
      note: `trace ${(st.size / 1e6).toFixed(1)} MB — too big to JSON.parse here; open in Perfetto`,
    };
  }
  const raw = fs.readFileSync(tracePath, 'utf8');
  let events;
  try {
    const parsed = JSON.parse(raw);
    events = Array.isArray(parsed) ? parsed : parsed.traceEvents || [];
  } catch (err) {
    return { cpu: new Map(), note: `trace parse failed: ${err.message}` };
  }
  const cpu = new Map();
  let profiles = 0;
  for (const ev of events) {
    const name = ev.name || '';
    const args = ev.args || {};
    const data = args.data || args;
    if (name === 'ProfileChunk' || name === 'CpuProfile' || name === 'Profile') {
      const profile = data.cpuProfile || data.profile || data;
      if (profile && (profile.nodes || profile.samples)) {
        profiles++;
        mergeMaps(cpu, collectCpuFromProfile(profile, data.samples || profile.samples));
      }
    }
  }
  return { cpu, note: `${profiles} cpu profile chunks, ${(st.size / 1e6).toFixed(1)} MB` };
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
  const parsed = await parseTextLogs(files);
  const tracePath =
    args.trace ||
    (fs.existsSync(path.join(path.dirname(dir), 'engine_trace.json'))
      ? path.join(path.dirname(dir), 'engine_trace.json')
      : fs.existsSync(path.join(dir, 'engine_trace.json'))
        ? path.join(dir, 'engine_trace.json')
        : null);
  const cpu = parseChromeTrace(tracePath);

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
    cpuNote: cpu.note,
    cpuTop: Object.fromEntries(topEntries(cpu.cpu, args.limit)),
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
  printSection('CPU samples (JS)', topEntries(cpu.cpu, args.limit), '(no JS samples in trace)');
  console.log(`\nWrote ${outJson}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
