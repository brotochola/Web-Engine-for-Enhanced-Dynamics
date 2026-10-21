// E-17 kernel: how much does the stamp-grid scatter pass actually cost, and is it
// a share of the pre-render step worth a sitting for?
//
// Per E-25, this kernel reports the effect as a SHARE OF THE OWNER'S MEASURED STEP,
// not as a bare ops/s, because a kernel win on a function that is 0.001% of the frame
// is a win on nothing. E-03's premise probe printed 0.0018% and would have saved a
// twenty-minute sitting; this is the same guard applied before the work.
//
// Both variants run the shipped `buildStampGrid` shape against the same inputs:
//   base    - recompute the cell in the scatter pass (what shipped until 2026-10-18)
//   cached  - read the cell the count pass recorded
//
// The inputs are built, not assumed: Predator's ~13 400 casters spread over a
// 5000 x 3000 world, which is what `GPU_CASTERS` reports there.
//
// E-17 in docs/internal/EXECUTION_PLAN.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, timeIt, writeReport, isCli, mulberry32 } from './microbenchHelpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/render/gpuShadowCasters.js'), 'utf8');

const DEFAULTS = {
  seed: 0xe17,
  // Predator: GPU_CASTERS ~13 400.
  nSun: 13400,
  worldWidth: 5000,
  worldHeight: 3000,
  // Pre-render STEP_MS, Predator, 2026-10-18 E-05 sitting: 6.475 ms on the side that
  // runs the stamp pack. SHADOW_Q_MS within it is the sub-timer this lives in.
  preRenderStepMs: 6.475,
  shadowQMs: 2.668,
};

const STAMP_CELL = Number(src.match(/STAMP_CELL\s*=\s*([\d.]+)/)[1]);
const STAMP_GRID_MAX_CELLS = 128 * 128;

function build(args) {
  const sf = 4;
  const sun = new Float32Array(args.nSun * sf);
  const rnd = mulberry32(args.seed);
  for (let c = 0; c < args.nSun; c++) {
    sun[c * sf] = rnd() * args.worldWidth;
    sun[c * sf + 1] = rnd() * args.worldHeight;
    sun[c * sf + 2] = 1;
    sun[c * sf + 3] = 1;
  }
  const counts = new Int32Array(STAMP_GRID_MAX_CELLS);
  const starts = new Int32Array(STAMP_GRID_MAX_CELLS + 1);
  const items = new Uint32Array(args.nSun);
  const cellOf = new Int32Array(args.nSun);
  return { sun, sf, nSun: args.nSun, counts, starts, items, cellOf };
}

/** The shape of buildStampGrid with the scatter pass RECOMPUTING, as shipped. */
function gridBase(sun, nSun, sf, counts, starts, items) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    const x = sun[b], y = sun[b + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  const gw = (Math.floor((maxX - minX) / STAMP_CELL) | 0) + 1;
  const gh = (Math.floor((maxY - minY) / STAMP_CELL) | 0) + 1;
  const cells = gw * gh;
  if (gw < 1 || gh < 1 || cells > counts.length || cells > STAMP_GRID_MAX_CELLS || nSun > items.length) return null;
  counts.fill(0, 0, cells);
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    let col = Math.floor((sun[b] - minX) / STAMP_CELL) | 0;
    let row = Math.floor((sun[b + 1] - minY) / STAMP_CELL) | 0;
    if (col < 0) col = 0; else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0; else if (row >= gh) row = gh - 1;
    counts[row * gw + col]++;
  }
  let sum = 0;
  for (let i = 0; i < cells; i++) { starts[i] = sum; sum += counts[i]; }
  starts[cells] = nSun;
  const cursor = counts;
  for (let i = 0; i < cells; i++) cursor[i] = starts[i];
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    let col = Math.floor((sun[b] - minX) / STAMP_CELL) | 0;
    let row = Math.floor((sun[b + 1] - minY) / STAMP_CELL) | 0;
    if (col < 0) col = 0; else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0; else if (row >= gh) row = gh - 1;
    items[cursor[row * gw + col]++] = c;
  }
  return cells;
}

/** The shipped shape: the count pass records the cell, the scatter pass reads it. */
function gridCached(sun, nSun, sf, counts, starts, items, cellOf) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    const x = sun[b], y = sun[b + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  const gw = (Math.floor((maxX - minX) / STAMP_CELL) | 0) + 1;
  const gh = (Math.floor((maxY - minY) / STAMP_CELL) | 0) + 1;
  const cells = gw * gh;
  if (gw < 1 || gh < 1 || cells > counts.length || cells > STAMP_GRID_MAX_CELLS || nSun > items.length) return null;
  counts.fill(0, 0, cells);
  for (let c = 0; c < nSun; c++) {
    const b = c * sf;
    let col = Math.floor((sun[b] - minX) / STAMP_CELL) | 0;
    let row = Math.floor((sun[b + 1] - minY) / STAMP_CELL) | 0;
    if (col < 0) col = 0; else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0; else if (row >= gh) row = gh - 1;
    const cell = row * gw + col;
    cellOf[c] = cell;
    counts[cell]++;
  }
  let sum = 0;
  for (let i = 0; i < cells; i++) { starts[i] = sum; sum += counts[i]; }
  starts[cells] = nSun;
  const cursor = counts;
  for (let i = 0; i < cells; i++) cursor[i] = starts[i];
  for (let c = 0; c < nSun; c++) items[cursor[cellOf[c]]++] = c;
  return cells;
}

function checksumItems(items, n) {
  let h = 2166136261;
  for (let i = 0; i < n; i++) h = Math.imul(h ^ items[i], 16777619) >>> 0;
  return h >>> 0;
}

async function main() {
  const args = { ...DEFAULTS, ...parseArgs(process.argv.slice(2)) };
  const b = build(args);

  // Gate 1 first: the two must produce identical items, or ops/s is not read.
  const itemsA = new Uint32Array(args.nSun);
  const itemsB = new Uint32Array(args.nSun);
  const countsA = new Int32Array(STAMP_GRID_MAX_CELLS);
  const countsB = new Int32Array(STAMP_GRID_MAX_CELLS);
  const startsA = new Int32Array(STAMP_GRID_MAX_CELLS + 1);
  const startsB = new Int32Array(STAMP_GRID_MAX_CELLS + 1);
  gridBase(b.sun, b.nSun, b.sf, countsA, startsA, itemsA);
  gridCached(b.sun, b.nSun, b.sf, countsB, startsB, itemsB, b.cellOf);
  const checksumBase = checksumItems(itemsA, args.nSun);
  const checksumCached = checksumItems(itemsB, args.nSun);
  if (checksumBase !== checksumCached) {
    console.error(`REJECTED: checksums differ ${checksumBase} vs ${checksumCached}`);
    process.exitCode = 1;
    return;
  }
  let startsSame = true;
  for (let i = 0; i <= countsA.length; i++) if (startsA[i] !== startsB[i]) { startsSame = false; break; }

  const a = timeIt('stamp-grid-base', () => gridBase(b.sun, b.nSun, b.sf, b.counts, b.starts, b.items), { iterations: 1 });
  const c = timeIt('stamp-grid-cached', () => gridCached(b.sun, b.nSun, b.sf, b.counts, b.starts, b.items, b.cellOf), { iterations: 1 });

  const msBase = 1000 / a.opsPerSec;
  const msCached = 1000 / c.opsPerSec;
  const savedMs = msBase - msCached;

  const report = {
    name: 'stampGridCellCache',
    seed: args.seed,
    checksum: checksumBase,
    checksumMatch: true,
    startsMatch: startsSame,
    cases: { base: { opsPerSec: a.opsPerSec }, cached: { opsPerSec: c.opsPerSec } },
    shape: {
      nSun: args.nSun,
      worldWidth: args.worldWidth,
      worldHeight: args.worldHeight,
      stampCell: STAMP_CELL,
    },
    reading: {
      msPerBuildBase: +msBase.toFixed(5),
      msPerBuildCached: +msCached.toFixed(5),
      msSavedPerFrame: +savedMs.toFixed(5),
      deltaPct: +(((c.opsPerSec - a.opsPerSec) / a.opsPerSec) * 100).toFixed(2),
      // THE NUMBER THAT DECIDES WHETHER TO RUN A SCENE SITTING.
      shareOfShadowQMsPct: +((savedMs / args.shadowQMs) * 100).toFixed(3),
      shareOfPreRenderStepPct: +((savedMs / args.preRenderStepMs) * 100).toFixed(3),
      perFrameAt60Hz: +savedMs.toFixed(5),
    },
    gate25:
      'A hypothesis goes to a scene sitting only if shareOfPreRenderStepPct is a ' +
      'meaningful fraction of the 3% bar. Below ~0.5% the kernel wins cannot be ' +
      'resolved by this harness and the verdict is hygiene.',
    verdict: 'screen-only',
  };
  if (isCli(import.meta.url)) writeReport(args.output || 'tests/results/e17-stamp-grid/kernel.json', report);
  console.log(JSON.stringify(report, null, 2));
}

if (isCli(import.meta.url)) main();