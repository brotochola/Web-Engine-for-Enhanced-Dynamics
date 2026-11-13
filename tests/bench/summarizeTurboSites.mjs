#!/usr/bin/env node
/**
 * Line-level sites in TurboFan code (E-222): what each optimized engine function still does that costs, by the line it
 * comes from. The heap profiler (heapSampleWorkers.mjs) names the function that allocates, never the line, and charges
 * an inlined callee's allocations to its caller; TurboFan's trace holds every operation of the final graph with its
 * source position.
 *
 * Capture: a scene with TurboFan's JSON trace and V8's code log, e.g.
 *   MSYS_NO_PATHCONV=1 node tests/bench/runIntegratedWorkerBenchmark.mjs --src --scene /demos/predatorScene/predatorScene.js \
 *     --scene-export PredatorScene --warmup-ms 20000 --duration-ms 5000 --no-collect-detailed-stats \
 *     --js-flags="--trace-turbo --trace-turbo-path=D:/tmp/turbo/predator --no-concurrent-recompilation --log-code" \
 *     --v8-log-dir D:/tmp/turbo/predator/log
 * (--no-concurrent-recompilation: a trace written on a background thread is cut when the browser closes), then
 *   node tests/bench/summarizeTurboSites.mjs D:/tmp/turbo/predator [--log D:/tmp/turbo/predator/log] [--heap heap.json]
 *     [--top 40] [--output sites.json]
 *
 * It reads the last Turboshaft graph of each trace (after machine lowering and memory optimization) and the calls left in
 * it, each by its callee:
 *   alloc     an allocation's slow-path call (Allocate): an object, array, closure, context or a boxed double. Some never
 *             run (an int32 tagged as a heap number only past the Smi range): --heap says which functions really allocate
 *   ic        a generic inline cache (LoadWithVector, StoreWithVector, KeyedLoadIC...): an access TurboFan could not
 *             specialize (megamorphic, or no feedback)
 *   migrate   TryMigrateInstance: an object whose map was deprecated (a field changed representation after it was made)
 *   tdz       ThrowAccessedUninitializedVariable: a let, const or imported binding checked against the hole at each use
 *   call      a JS call TurboFan did not inline (its doubles are boxed across it)
 *   builtin   any other builtin or runtime call (Math, typed array methods, string ops, Atomics...)
 * An inlined callee's site is on the callee's own line and names it. With --log (V8's code log, --log-code), the highest
 * tier each engine function reached: one that never reached TurboFan has no trace and is listed apart. With --heap
 * (heapSampleWorkers.mjs --output), functions are ranked by the KB/s the profiler charged them.
 * A site is a place in the code, not a count: one in a per-entity loop costs per entity.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { isCli } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE_FILE = /(?:^|\/)src\/(?!vendor\/|box2d\/box2dWasm\.js)[^?#:]+\.m?js/;

/** The kind of a call left in the final graph, from its callee (the operation's properties). */
export function callKind(props) {
  const p = String(props || '');
  if (/Code:Allocate\b/.test(p)) return 'alloc';
  if (/Code:(TryMigrateInstance)/.test(p)) return 'migrate';
  if (/Code:ThrowAccessedUninitializedVariable/.test(p)) return 'tdz';
  if (/Code:(LoadWithVector|StoreWithVector|Keyed(Load|Store|Has)IC|LoadIC|StoreIC|LoadGlobalIC|StoreGlobalIC|DefineNamedOwnIC|DefineKeyedOwnIC|LoadSuperIC|KeyedLoadIC_Megamorphic|LoadIC_Megamorphic)/.test(p)) return 'ic';
  if (/JS:js-call/.test(p)) return 'call';
  if (/Code:(HandleNoHeapWritesInterrupts|StackGuard)/.test(p)) return null; // loop interrupt checks: everywhere
  if (/Code:Throw|Code:Abort|Code:Deoptimiz/.test(p)) return null; // exits
  return 'builtin';
}

const KINDS = ['alloc', 'ic', 'migrate', 'tdz', 'call', 'builtin'];

function parseArgs(argv) {
  const out = { dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else if (!out.dir) out.dir = a;
  }
  return out;
}

/** The repo file a served URL or a path names (src/ only, not the vendored Pixi or the Box2D glue), or null. */
export function localFile(url) {
  const m = ENGINE_FILE.exec(String(url || ''));
  if (!m) return null;
  const rel = m[0].startsWith('/') ? m[0].slice(1) : m[0];
  return fs.existsSync(path.join(repoRoot, rel)) ? rel : null;
}

const fileLines = new Map();
function linesOf(rel) {
  let v = fileLines.get(rel);
  if (!v) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    v = { starts, lines: text.split('\n') };
    fileLines.set(rel, v);
  }
  return v;
}

/** 1-based line of a script offset in a repo file. */
function lineOf(rel, offset) {
  const { starts } = linesOf(rel);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const lineText = (rel, line) => (linesOf(rel).lines[line - 1] || '').trim().slice(0, 120);

/** Where an operation's code came from: { rel, line, fn, inlined } (rel null outside the engine's sources). */
function siteOf(pos, trace) {
  if (!pos || !(pos.scriptOffset >= 0)) return null;
  const inl = pos.inliningId;
  let source;
  if (inl === undefined || inl === -1) source = trace.function;
  else {
    const inlining = trace.inlinings?.[inl] ?? trace.inlinings?.[String(inl)];
    source = inlining ? trace.sources?.[inlining.sourceId] ?? trace.sources?.[String(inlining.sourceId)] : null;
  }
  if (!source) return null;
  const rel = localFile(source.sourceName);
  return {
    rel,
    line: rel ? lineOf(rel, pos.scriptOffset) : 0,
    fn: source.functionName || '(anonymous)',
    inlined: inl !== undefined && inl !== -1,
    outside: rel ? null : String(source.sourceName || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, ''),
  };
}

/** One trace file: its function and the sites of its final graph; null when it is not engine code or not complete. */
export function readTrace(file) {
  let trace;
  try {
    trace = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { broken: true };
  }
  const fn = trace.function;
  if (!fn) return null;
  const rel = localFile(fn.sourceName);
  if (!rel) return null;
  const phases = trace.phases || [];
  let gi = -1;
  for (let i = phases.length - 1; i >= 0; i--) {
    if (phases[i].type === 'turboshaft_graph') {
      gi = i;
      break;
    }
  }
  if (gi < 0) return null;
  const graph = phases[gi];
  // The graph's per-operation strings follow it ("Properties", data_target "operations").
  let props = null;
  for (let i = gi + 1; i < phases.length && phases[i].type === 'turboshaft_custom_data'; i++) {
    if (phases[i].name === 'Properties') props = new Map(phases[i].data.map((d) => [d.key, d.value]));
  }
  if (!props) return null;
  const sites = [];
  let deoptChecks = 0;
  for (const op of graph.data.nodes) {
    if (op.title === 'DeoptimizeIf') deoptChecks++;
    if (op.title !== 'Call') continue;
    const callee = props.get(op.id);
    const kind = callKind(callee);
    if (!kind) continue;
    const at = siteOf(op.sourcePosition, trace);
    if (!at) continue;
    sites.push({ kind, callee: String(callee).replace(/:r\d+s\d+i\d+f\d+\]$/, ']').replace(/0x[0-9a-f]+/g, ''), ...at });
  }
  return { name: fn.functionName || '(anonymous)', rel, line: lineOf(rel, fn.startPosition ?? 0), deoptChecks, sites, ops: graph.data.nodes.length };
}

/** V8's code log: the highest tier each engine function reached (code-creation markers ~ ^ + *). */
export async function readTiers(logPath) {
  const tiers = new Map();
  const rank = { '~': 0, '^': 1, '+': 2, '*': 3 };
  const names = ['Ignition', 'Sparkplug', 'Maglev', 'TurboFan'];
  const files = fs.statSync(logPath).isDirectory()
    ? fs.readdirSync(logPath).filter((f) => /\.log$/i.test(f)).map((f) => path.join(logPath, f))
    : [logPath];
  // The marker may carry a quote (V8 marks code it compiled for on-stack replacement or with a variant that way): `+'`.
  const re = /^code-creation,JS,\d+,(\d+),0x[0-9a-f]+,\d+,(.*) (\S+):(\d+):(\d+),0x[0-9a-f]+,([~^+*])('?)$/;
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.startsWith('code-creation,JS,')) continue;
      const m = re.exec(line);
      if (!m) continue;
      const rel = localFile(m[3]);
      if (!rel) continue;
      const key = `${rel}:${m[4]} ${m[2]}`;
      const r = rank[m[6]];
      const us = Number(m[1]);
      let t = tiers.get(key);
      if (t === undefined) {
        t = { rank: r, tier: names[r], rel, line: Number(m[4]), fn: m[2], firstUs: us, reachedUs: [null, null, null, null] };
        tiers.set(key, t);
      }
      if (us < t.firstUs) t.firstUs = us;
      if (t.reachedUs[r] === null || us < t.reachedUs[r]) t.reachedUs[r] = us;
      if (r > t.rank) {
        t.rank = r;
        t.tier = names[r];
      }
    }
  }
  // Seconds from a function's first code to each tier it reached (per isolate the clock starts at its own start).
  for (const t of tiers.values()) t.secondsTo = t.reachedUs.map((us) => (us === null ? null : Math.round((us - t.firstUs) / 1e5) / 10));
  return tiers;
}

/** heapSampleWorkers --output ({ "<worker> <id>": { top: [{ site: "fn path:line", kbPerS }] } }): KB/s per function. */
export function readHeap(file) {
  const out = new Map();
  if (!file) return out;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const w of Object.values(j)) {
    for (const row of w.top || []) {
      const m = /^(.*) (\S+):(\d+)$/.exec(String(row.site || ''));
      if (!m) continue;
      const rel = localFile(m[2]);
      if (!rel) continue;
      const key = `${rel}:${m[3]} ${m[1]}`;
      out.set(key, (out.get(key) || 0) + (row.kbPerS || 0));
    }
  }
  return out;
}

export async function summarizeTurboSites(dir, opts = {}) {
  const files = fs.readdirSync(dir).filter((f) => /^turbo-.*\.json$/.test(f) && !/^turbo-wasm/.test(f));
  const byFunction = new Map();
  let broken = 0;
  for (const f of files) {
    const t = readTrace(path.join(dir, f));
    if (!t) continue;
    if (t.broken) {
      broken++;
      continue;
    }
    // A function optimized more than once (after a deopt, or in several workers): the trace with more sites stands.
    const key = `${t.rel}:${t.line} ${t.name}`;
    const prev = byFunction.get(key);
    if (!prev || t.sites.length > prev.sites.length) byFunction.set(key, t);
  }
  const tiers = opts.log ? await readTiers(opts.log) : new Map();
  const heap = readHeap(opts.heap);
  const rows = [];
  for (const [key, t] of byFunction) {
    const counts = Object.fromEntries(KINDS.map((k) => [k, t.sites.filter((s) => s.kind === k).length]));
    rows.push({ key, ...t, counts, kbps: heap.get(key) || 0 });
  }
  rows.sort((a, b) => b.kbps - a.kbps || (b.counts.alloc + b.counts.ic + b.counts.migrate + b.counts.tdz) - (a.counts.alloc + a.counts.ic + a.counts.migrate + a.counts.tdz));
  const totals = Object.fromEntries(KINDS.map((k) => [k, rows.reduce((s, r) => s + r.counts[k], 0)]));
  const notTurbo = [...tiers.values()].filter((t) => t.rank < 3);
  const heapNotTraced = [...heap.entries()].filter(([k]) => !byFunction.has(k)).map(([k, kbps]) => ({ key: k, kbps, tier: tiers.get(k)?.tier ?? '?' }));
  heapNotTraced.sort((a, b) => b.kbps - a.kbps);
  return { traces: files.length, broken, functions: rows.length, totals, rows, notTurbo, heapNotTraced };
}

function printReport(r, top) {
  console.log(`${r.traces} traces (${r.broken} cut short), ${r.functions} engine functions in TurboFan`);
  console.log(`sites: ${KINDS.map((k) => `${k} ${r.totals[k]}`).join(', ')}`);
  let shown = 0;
  for (const row of r.rows) {
    const worth = row.counts.alloc + row.counts.ic + row.counts.migrate + row.counts.tdz + row.counts.call;
    if (!worth && !row.kbps) continue;
    if (shown++ >= top) break;
    console.log(`\n${row.kbps ? `${row.kbps.toFixed(1)} KB/s  ` : ''}${row.name}  ${row.rel}:${row.line}  ` +
      `(${KINDS.filter((k) => row.counts[k]).map((k) => `${k} ${row.counts[k]}`).join(', ')}; ${row.deoptChecks} deopt checks)`);
    const grouped = new Map();
    for (const s of row.sites) {
      if (s.kind === 'builtin' && !/Typed|Math|String|Array|Atomics|Number|Object|Map|Set/.test(s.callee)) continue;
      const where = s.rel ? `${s.rel}:${s.line}` : s.outside;
      const k = `${s.kind}|${s.kind === 'builtin' || s.kind === 'ic' ? s.callee : ''}|${where}`;
      const g = grouped.get(k) || { ...s, where, n: 0 };
      g.n++;
      grouped.set(k, g);
    }
    for (const g of grouped.values()) {
      const text = g.rel ? lineText(g.rel, g.line) : '';
      const callee = g.kind === 'builtin' || g.kind === 'ic' ? ` ${g.callee}` : '';
      console.log(`  ${g.kind.padEnd(8)}${g.n > 1 ? `${g.n}x ` : '   '}${g.where}${g.inlined ? ` [${g.fn}]` : ''}${callee}  ${text}`);
    }
  }
  if (r.heapNotTraced.length) {
    console.log('\nAllocating functions (heap sample) with no TurboFan trace (their tier):');
    for (const h of r.heapNotTraced.slice(0, 25)) console.log(`  ${h.kbps.toFixed(1).padStart(6)} KB/s  ${h.tier.padEnd(9)} ${h.key}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('usage: summarizeTurboSites.mjs <turbo dir> [--log <v8 log dir|file>] [--heap heap.json] [--top N] [--output file]');
    process.exit(2);
  }
  const r = await summarizeTurboSites(args.dir, { log: args.log, heap: args.heap });
  printReport(r, Number(args.top ?? 40));
  if (args.output) fs.writeFileSync(String(args.output), JSON.stringify(r, null, 1));
}

if (isCli(import.meta.url)) await main();
