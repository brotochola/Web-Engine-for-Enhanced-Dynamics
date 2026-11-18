// Kernel: writeWallRow (src/render/visibility/lampWallRow.js), a lamp's row for the light pass (OL-4), written by
// pre-render once a lamp with walls a frame. Imports the shipped function. Does not patch src/.
//
// A polygon is what the sweep leaves: vertices in rising angle around the lamp, each with its own code (0 where its ray
// hit nothing), four a wall in sight: what lies behind the wall's first corner, the wall there, the wall at its last
// corner and what lies behind that, two rays in all (a row's branches then repeat as a scene's do; codes drawn a vertex
// at a time made every one a coin toss, and the kernel read 25 ns a vertex). Three sizes, since a row's cost has a part a vertex and a part a row (its 256 directions' index):
// 16 vertices (a lamp with two or three walls in reach), 48 (visPolyStressScene's widest at 360 lights was 51) and 128
// (lighting.maxPolygonVertices' default).
//
//   node tests/bench/wallRowMicrobench.mjs
//   node tests/bench/wallRowMicrobench.mjs --output tests/results/wall-row/kernel.json
//
// Timed in TurboFan as a normal compile (warmNormalCompile: short calls first), not OSR.

import {
  WALL_ROW_ARGS, WALL_ROW_MAX_VERTS, wallEdgeCode, wallRowTexels, writeWallRow,
} from '../../src/render/visibility/lampWallRow.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const SEED = 0x0a11f0e5;
const POLYGONS = 256;
const SIZES = [16, 48, 128];
const ROW_FLOATS = 4 * wallRowTexels(WALL_ROW_MAX_VERTS);

/** `count` polygons of `n` vertices each (n / 4 walls) around lamps scattered over a field; behind a wall, nothing or another wall. */
function makePolygons(rng, n, count) {
  const xs = new Float32Array(count * n);
  const ys = new Float32Array(count * n);
  const codes = new Float32Array(count * n);
  const lamps = new Float64Array(count * 2);
  for (let p = 0; p < count; p++) {
    const lx = 200 + rng() * 2000;
    const ly = 200 + rng() * 1400;
    lamps[p * 2] = lx;
    lamps[p * 2 + 1] = ly;
    const radius = 150 + rng() * 300;
    // Rising atan2 from -PI, as the sweep emits them: each wall takes a slot of the turn, its two corners' rays in it.
    const walls = n >> 2;
    for (let w = 0; w < walls; w++) {
      const a1 = -Math.PI + ((w + 0.1 + rng() * 0.3) / walls) * 2 * Math.PI;
      const a2 = -Math.PI + ((w + 0.5 + rng() * 0.4) / walls) * 2 * Math.PI;
      const near = radius * (0.15 + rng() * 0.6);
      const wall = wallEdgeCode(1 + ((rng() * 4000) | 0), rng() < 0.2 ? 128 : 255);
      for (let k = 0; k < 4; k++) {
        const v = p * n + w * 4 + k;
        const onWall = k === 1 || k === 2;
        // Behind a corner: the far boundary (a free ray), or one time in three another wall.
        const behind = rng() < 0.33 ? wallEdgeCode(1 + ((rng() * 4000) | 0), 255) : 0;
        const r = onWall ? near : behind !== 0 ? radius * 0.9 : radius * 1.414;
        const a = k < 2 ? a1 : a2;
        xs[v] = lx + Math.cos(a) * r;
        ys[v] = ly + Math.sin(a) * r * 0.7;
        codes[v] = onWall ? wall : behind;
      }
    }
  }
  // Each polygon's own views, made once: the timed loop allocates nothing, as the worker's call (whole arrays) does not.
  const px = [];
  const py = [];
  const pc = [];
  for (let p = 0; p < count; p++) {
    px.push(xs.subarray(p * n, p * n + n));
    py.push(ys.subarray(p * n, p * n + n));
    pc.push(codes.subarray(p * n, p * n + n));
  }
  return { n, count, px, py, pc, lamps };
}

/** Writes `iterations` rows, the polygons in turn, each into the one row `out` holds. */
function run(iterations, set, out) {
  const { n, count, px, py, pc, lamps } = set;
  let written = 0;
  for (let i = 0; i < iterations; i++) {
    const p = i % count;
    WALL_ROW_ARGS[0] = lamps[p * 2];
    WALL_ROW_ARGS[1] = lamps[p * 2 + 1];
    WALL_ROW_ARGS[2] = 1 / 0.7;
    written += writeWallRow(out, 0, px[p], py[p], pc[p], n);
  }
  return written;
}

/** Every polygon's row, one after the other: what the kernel wrote, for the checksum. */
function checksum(set) {
  const { n, count } = set;
  const rows = new Float32Array(count * ROW_FLOATS);
  for (let p = 0; p < count; p++) {
    WALL_ROW_ARGS[0] = set.lamps[p * 2];
    WALL_ROW_ARGS[1] = set.lamps[p * 2 + 1];
    WALL_ROW_ARGS[2] = 1 / 0.7;
    writeWallRow(rows, p * ROW_FLOATS, set.px[p], set.py[p], set.pc[p], n);
  }
  return checksumFloats(rows);
}

function main() {
  const args = parseArgs();
  const rng = mulberry32(SEED);
  const out = new Float32Array(ROW_FLOATS);
  const payload = { seed: SEED, polygons: POLYGONS, tier: 'TurboFan, normal compile (warmNormalCompile)', cases: {} };
  for (const n of SIZES) {
    const set = makePolygons(rng, n, POLYGONS);
    const sum = checksum(set);
    if (!Number.isFinite(sum)) throw new Error(`wall row ${n}: the checksum is not finite`);
    warmNormalCompile(() => run(POLYGONS, set, out), 400);
    const timed = timeIt(`wallRow n=${n}`, (iterations) => {
      run(iterations, set, out);
    }, { iterations: args.iters || 200000 });
    payload.cases[`n${n}`] = {
      opsPerSec: timed.opsPerSec,
      nsPerRow: 1e9 / timed.opsPerSec,
      n: timed.iterations,
      vertices: n,
      seed: SEED,
      checksum: sum,
      sampleMs: timed.ms,
    };
    console.log(`  ${(1e9 / timed.opsPerSec).toFixed(0)} ns a row, checksum ${sum}`);
  }
  if (args.output) writeReport(args.output, payload);
  return payload;
}

if (isCli(import.meta.url)) main();

export { main };
