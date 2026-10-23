/**
 * Where a Node script allocates: a sampling heap profile of one run of a kernel (or any script),
 * counting the objects minor and major GCs have already collected (allocation sites, not the live
 * heap). The fast loop for allocation work: Node showed the same sites as Chrome for doubles
 * boxed as arguments to functions too big to inline (E-85), but not for tagged fields (E-66), so
 * Chrome (heapSampleWorkers.mjs) still decides.
 *
 *   node tests/bench/heapSampleNode.mjs [--interval 262144] [--top 15] -- tests/bench/bulletTickMicrobench.mjs --steps 100
 *
 * Everything after `--` is the script and its own arguments. Prints the top allocating functions in
 * MB and their callers. Sampling: a site is accurate to about the interval per sample, so compare
 * totals of the same script, not single small rows. A long run at a small interval makes a profile
 * too big to return; raise the interval or shorten the run.
 */
import inspector from 'node:inspector/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const split = process.argv.indexOf('--');
if (split < 0 || !process.argv[split + 1]) {
  console.error('usage: node tests/bench/heapSampleNode.mjs [--interval N] [--top N] -- <script> [args]');
  process.exit(2);
}
const own = process.argv.slice(2, split);
const opt = (name, fallback) => {
  const i = own.indexOf(`--${name}`);
  return i >= 0 ? Number(own[i + 1]) : fallback;
};
const interval = opt('interval', 262144);
const top = opt('top', 15);
const script = path.resolve(process.argv[split + 1]);
// The script parses process.argv as if it had been run directly.
process.argv = [process.argv[0], script, ...process.argv.slice(split + 2)];

const session = new inspector.Session();
session.connect();
await session.post('HeapProfiler.enable');
await session.post('HeapProfiler.startSampling', {
  samplingInterval: interval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
});
const t0 = performance.now();
await import(pathToFileURL(script).href);
const { profile } = await session.post('HeapProfiler.stopSampling');
const seconds = (performance.now() - t0) / 1000;

const rows = new Map();
let total = 0;
const siteOf = (f) =>
  `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*?\/(src|tests|demos)\//, '$1/')}:${f.lineNumber + 1}`;
const walk = (node, parent) => {
  const key = siteOf(node.callFrame);
  if (node.selfSize > 0) {
    const r = rows.get(key) || { bytes: 0, from: new Map() };
    r.bytes += node.selfSize;
    r.from.set(parent, (r.from.get(parent) || 0) + node.selfSize);
    rows.set(key, r);
    total += node.selfSize;
  }
  for (const c of node.children || []) walk(c, key);
};
walk(profile.head, '');

const mb = (b) => (b / 1048576).toFixed(1);
console.log(`\n== ${path.basename(script)}: ${mb(total)} MB sampled in ${seconds.toFixed(1)} s`);
for (const [site, r] of [...rows].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top)) {
  const from = [...r.from].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([p, b]) => `${p} (${mb(b)})`).join(' | ');
  console.log(`${mb(r.bytes).padStart(9)} MB  ${site}   <- ${from}`);
}
