#!/usr/bin/env node
/**
 * Stream-parse a Chrome/Playwright CPU trace (engine_trace.json) without
 * JSON.parse of the whole file. One event per line.
 *
 *   node tests/bench/summarizeChromeCpuTrace.mjs tests/results/v8-deopt/engine_trace.json
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

function parseArgs(argv) {
  const out = { file: null, limit: 30, srcOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) out.limit = Math.max(1, parseInt(argv[++i], 10) || 30);
    else if (a === '--src-only') out.srcOnly = true;
    else if (!a.startsWith('--') && !out.file) out.file = path.resolve(a);
  }
  return out;
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function stripHost(url) {
  return String(url || '')
    .replace(/^https?:\/\/127\.0\.0\.1:\d+/, '')
    .replace(/^https?:\/\/[^/]+/, '');
}

function workerLabel(url) {
  const u = stripHost(url);
  const m = u.match(/\/src\/workers\/([^/?]+)/);
  if (m) return m[1];
  if (u.includes('/src/box2d/')) return 'physicsWasm';
  if (u.includes('pixi')) return 'pixi';
  return null;
}

function parseLine(raw) {
  let s = raw.trim();
  if (!s || s === '{' || s === '}' || s === '[' || s === ']' || s.startsWith('{"traceEvents"')) {
    return null;
  }
  if (s.endsWith(',')) s = s.slice(0, -1);
  if (!s.startsWith('{')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function frameKey(frame) {
  const name = frame.functionName || '(anonymous)';
  const url = stripHost(frame.url || '');
  const line = frame.lineNumber != null && frame.lineNumber >= 0 ? `:${frame.lineNumber}` : '';
  return `${name} ${url}${line}`.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file || path.resolve('tests/results/v8-deopt/engine_trace.json');
  if (!fs.existsSync(file)) {
    console.error(`missing ${file}`);
    process.exitCode = 1;
    return;
  }

  const threadName = new Map();
  const profiles = new Map();
  const eventNames = new Map();
  let events = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    const ev = parseLine(raw);
    if (!ev) continue;
    events++;
    bump(eventNames, ev.name || '(no name)');

    if (ev.name === 'thread_name' && ev.args?.name != null) {
      threadName.set(`${ev.pid}:${ev.tid}`, ev.args.name);
    }

    const data = ev.args?.data;
    if (!data) continue;
    const name = ev.name || '';
    if (name !== 'Profile' && name !== 'ProfileChunk' && name !== 'CpuProfile') continue;

    const key = String(ev.id ?? `${ev.pid}:${ev.tid}`);
    let prof = profiles.get(key);
    if (!prof) {
      prof = {
        pid: ev.pid,
        tid: ev.tid,
        nodes: new Map(),
        samples: [],
        urls: new Map(),
      };
      profiles.set(key, prof);
    }
    if (ev.pid != null) prof.pid = ev.pid;
    if (ev.tid != null) prof.tid = ev.tid;

    const cpu = data.cpuProfile || data.profile || null;
    const nodes = cpu?.nodes || data.nodes || null;
    if (nodes) {
      for (const n of nodes) {
        const frame = n.callFrame || n;
        prof.nodes.set(n.id, {
          parent: n.parent,
          name: frame.functionName || n.functionName || '(anonymous)',
          url: frame.url || n.url || '',
          line: frame.lineNumber,
        });
        const w = workerLabel(frame.url || n.url || '');
        if (w) bump(prof.urls, w);
      }
    }
    const samples = cpu?.samples || data.samples || null;
    if (samples && samples.length) {
      for (let i = 0; i < samples.length; i++) prof.samples.push(samples[i]);
    }
  }

  const byThread = new Map();
  const byWorkerGuess = new Map();
  const globalSelf = new Map();
  const srcSelf = new Map();
  const perWorker = new Map();

  for (const prof of profiles.values()) {
    const tname = threadName.get(`${prof.pid}:${prof.tid}`) || `tid ${prof.tid}`;
    const threadKey = `${tname} (pid ${prof.pid} tid ${prof.tid})`;
    const guess = [...prof.urls.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || tname;
    if (!perWorker.has(guess)) perWorker.set(guess, new Map());
    const workerMap = perWorker.get(guess);

    for (const id of prof.samples) {
      const node = prof.nodes.get(id);
      if (!node) continue;
      const key = `${node.name} ${stripHost(node.url)}${node.line != null ? ':' + node.line : ''}`.trim();
      bump(globalSelf, key);
      bump(byThread, threadKey);
      bump(byWorkerGuess, guess);
      bump(workerMap, key);
      const url = stripHost(node.url);
      if (url.includes('/src/') || url.includes('/demos/')) bump(srcSelf, key);
    }
  }

  const report = {
    file,
    bytes: fs.statSync(file).size,
    events,
    profiles: profiles.size,
    topEventNames: Object.fromEntries(topEntries(eventNames, 25)),
    samplesByThread: Object.fromEntries(topEntries(byThread, 40)),
    samplesByWorkerGuess: Object.fromEntries(topEntries(byWorkerGuess, 20)),
    topSelf: Object.fromEntries(topEntries(globalSelf, args.limit)),
    topSrc: Object.fromEntries(topEntries(srcSelf, args.limit)),
    perWorkerTop: Object.fromEntries(
      [...perWorker.entries()].map(([w, m]) => [w, Object.fromEntries(topEntries(m, args.limit))])
    ),
  };

  const outDir = path.dirname(file);
  const outJson = path.join(outDir, 'cpu-summary.json');
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`Events: ${events} | profiles: ${profiles.size} | ${(report.bytes / 1e6).toFixed(1)} MB`);
  console.log('\n## Samples by thread');
  for (const [k, n] of topEntries(byThread, 20)) console.log(`${String(n).padStart(8)}  ${k}`);
  console.log('\n## Samples by worker guess (from script URLs in that profile)');
  for (const [k, n] of topEntries(byWorkerGuess, 15)) console.log(`${String(n).padStart(8)}  ${k}`);
  console.log('\n## Self samples (all JS)');
  for (const [k, n] of topEntries(args.srcOnly ? srcSelf : globalSelf, args.limit)) {
    console.log(`${String(n).padStart(8)}  ${k}`);
  }
  console.log('\n## Self samples (/src and /demos only)');
  for (const [k, n] of topEntries(srcSelf, args.limit)) console.log(`${String(n).padStart(8)}  ${k}`);
  const interesting = [
    'preRenderWorker.js',
    'pixi',
    'logicWorker.js',
    'spatialWorker.js',
    'particleWorker.js',
    'physicsWasm',
  ];
  for (const w of interesting) {
    const m = perWorker.get(w);
    if (!m) continue;
    console.log(`\n## ${w}`);
    for (const [k, n] of topEntries(m, 12)) console.log(`${String(n).padStart(8)}  ${k}`);
  }
  console.log(`\nWrote ${outJson}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
