/**
 * ensureCompoundSolid rebuilds (review G1). A compound body's outline is rebuilt
 * whenever ColliderFixture.revision moves, and that revision is pool-wide: any
 * remesh anywhere rebuilds every lit compound body. This times one rebuild of a
 * terrain-like compound (triangles of a jittered grid, so interior edges are
 * shared by two triangles) and counts minor GCs per 1000 rebuilds.
 *
 *   node tests/bench/compoundSolidMicrobench.mjs [--output path]
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { ensureCompoundSolid } from '../../src/render/visibility/angularSweep.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';
import { checksumFloats, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { mulberry32 } from './benchMath.js';

const NONE = 0xffff;
const V = MAX_POLYGON_VERTICES;

/** cols × rows cells, two triangles each, jittered interior points. */
export function gridCompound(cols, rows, cell, seed) {
  const rnd = mulberry32(seed);
  const px = new Float32Array((cols + 1) * (rows + 1));
  const py = new Float32Array((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const edge = r === 0 || c === 0 || r === rows || c === cols;
      const j = edge ? 0 : (rnd() - 0.5) * cell * 0.4;
      px[r * (cols + 1) + c] = 100 + c * cell + j;
      py[r * (cols + 1) + c] = 200 + r * cell + (edge ? 0 : (rnd() - 0.5) * cell * 0.4);
    }
  }
  const n = cols * rows * 2;
  const vx = new Float32Array(n * V);
  const vy = new Float32Array(n * V);
  const vertCount = new Uint8Array(n);
  const active = new Uint8Array(n).fill(1);
  const next = new Uint16Array(n);
  let f = 0;
  const put = (a, b, c) => {
    const o = f * V;
    vx[o] = px[a]; vy[o] = py[a];
    vx[o + 1] = px[b]; vy[o + 1] = py[b];
    vx[o + 2] = px[c]; vy[o + 2] = py[c];
    vertCount[f] = 3;
    next[f] = f + 1 < n ? f + 1 : NONE;
    f++;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      put(a, b, e);
      put(a, e, d);
    }
  }
  return { head: new Uint16Array([0]), next, active, vertCount, vx, vy, fixtures: n };
}

function rebuildCase(label, body, wantFill) {
  let revision = 1;
  const call = () => ensureCompoundSolid(
    0, revision++, body.head, body.next, body.active, body.vertCount, body.vx, body.vy, 0, body.fixtures, wantFill,
  );
  const s = call();
  const checksum = checksumFloats(s.seg, s.segCount * 4) ^ (wantFill ? checksumFloats(s.fill, s.fillVerts * 2) : 0);
  // The cases share one function and flip wantFill; let it re-optimize for
  // this mode before timing, or the cheap cases time the deopt (bimodal runs).
  for (let k = 0; k < 5000; k++) call();
  const timed = timeIt(label, (iters) => {
    for (let k = 0; k < iters; k++) call();
  }, { iterations: 200 });

  let minor = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.detail?.kind === 1 || e.kind === 1) minor++;
  });
  obs.observe({ entryTypes: ['gc'] });
  const N = 1000;
  for (let k = 0; k < N; k++) call();
  return new Promise((resolve) => setTimeout(() => {
    obs.disconnect();
    resolve({ label, opsPerSec: timed.opsPerSec, ms: timed.ms, iterations: timed.iterations, minorGcPer1000: minor, segCount: s.segCount, checksum });
  }, 50));
}

async function main() {
  const args = parseArgs();
  const cases = {};
  for (const [name, cols, rows] of [['small', 4, 2], ['island', 16, 8], ['large', 48, 24]]) {
    const body = gridCompound(cols, rows, 10, 7 + cols);
    cases[`${name}Outline`] = await rebuildCase(`${name} outline (${body.fixtures} tris)`, body, false);
    cases[`${name}Fill`] = await rebuildCase(`${name} outline+fill (${body.fixtures} tris)`, body, true);
  }
  const checksum = Object.values(cases).reduce((h, c) => (h ^ c.checksum) >>> 0, 0);
  const report = { name: 'compoundSolid', cases, checksum };
  for (const [k, c] of Object.entries(cases)) {
    console.log(`${k}: ${Math.round(c.opsPerSec).toLocaleString()} rebuilds/s, ${c.minorGcPer1000} minor GCs per 1000, ${c.segCount} outline segs`);
  }
  writeReport(args.output || 'tests/results/compound-solid/kernel.json', report);
}

if (isCli(import.meta.url)) await main();
