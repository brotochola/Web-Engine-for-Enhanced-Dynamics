#!/usr/bin/env node
/**
 * Kernel: PreRenderWorker._sortPrefix on a real worker instance (review E-08
 * reopened). It sorts [0, n) of a pooled array by a comparator. The callers are
 * the stamp lights (distance, n ≤ ~20) and the visible-light lists (y, n up to
 * the light cap: the visPoly row has 360). Three input orders, because the
 * visible-light list arrives in grid-cell order, rows of cells top to bottom,
 * which is already close to y order: random, cell order, and sorted.
 *
 *   node tests/bench/sortPrefixMicrobench.mjs [--output path]
 */
import { loadWorker } from './workerHarness.mjs';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const CELL = 128;

function lights(n, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: i, x: rnd() * 4000, y: rnd() * 3000 });
  return out;
}

function ordered(list, order) {
  const a = list.slice();
  if (order === 'sorted') a.sort((p, q) => p.y - q.y);
  else if (order === 'cells') {
    a.sort((p, q) => ((p.y / CELL) | 0) - ((q.y / CELL) | 0) || ((p.x / CELL) | 0) - ((q.x / CELL) | 0));
  }
  return a;
}

async function main() {
  const args = parseArgs();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const cmp = (a, b) => a.y - b.y;
  const cases = {};
  let checksum = 0;
  for (const n of [20, 46, 128, 360]) {
    for (const order of ['random', 'cells', 'sorted']) {
      const src = ordered(lights(n, 0x5047 + n), order);
      // Pooled tail past n, as the callers have.
      const arr = src.concat(lights(8, 99).map((l) => ({ ...l, id: 10000 + l.id })));
      const run = (iters) => {
        for (let k = 0; k < iters; k++) {
          for (let i = 0; i < n; i++) arr[i] = src[i];
          pre._sortPrefix(arr, n, cmp);
        }
      };
      run(1);
      const ids = new Int32Array(arr.length);
      for (let i = 0; i < arr.length; i++) ids[i] = arr[i].id;
      checksum = (checksum ^ checksumInts(ids, ids.length)) >>> 0;
      run(5000);
      cases[`n${n}_${order}`] = timeIt(`_sortPrefix n=${n} ${order}`, run, { iterations: 2000 });
    }
  }
  const report = { feature: 'sort-prefix', checksum, cases };
  if (args.output) writeReport(String(args.output), report);
  else for (const [k, c] of Object.entries(cases)) console.log(k, (1e6 / c.opsPerSec).toFixed(2), 'us');
}

if (isCli(import.meta.url)) await main();
