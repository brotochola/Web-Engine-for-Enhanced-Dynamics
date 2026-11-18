// OL-8: writeWallRow fills its 256 directions' index by runs, as the vertices go by, instead of walking the bins and
// comparing each against the vertices' angles. The row must not change by a bit: the shipped writer against the plain
// one (tests/reference/wallRowJs.mjs) on thousands of polygons, the awkward ones among them (vertices on one ray, a
// polygon that starts anywhere on the turn, three vertices, a full row, a row not at the buffer's start).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WALL_BINS, WALL_ROW_ARGS, WALL_ROW_MAX_VERTS, WALL_VERT0, wallEdgeCode, wallRowTexels, writeWallRow,
} from '../../src/render/visibility/lampWallRow.js';
import { mulberry32 } from '../bench/benchMath.js';
import { writeWallRowRef } from '../reference/wallRowJs.mjs';

const ROW_FLOATS = 4 * wallRowTexels(WALL_ROW_MAX_VERTS);

/** A polygon of n vertices in rising angle around (lx, ly), from `start` radians; `stack` of them share a ray with the one before. */
function polygon(rng, n, { start = -Math.PI, stack = 0.15, floor = 0.7 } = {}) {
  const lx = 100 + rng() * 2000;
  const ly = 100 + rng() * 1500;
  const radius = 40 + rng() * 500;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const codes = new Float32Array(n);
  let angle = start;
  for (let v = 0; v < n; v++) {
    // The turn left over, shared among the vertices left; some keep the last ray (a wall's corner: two hits, one ray).
    if (v > 0 && rng() >= stack) angle += ((start + 2 * Math.PI - angle) / (n - v + 1)) * (0.2 + rng() * 1.6);
    const free = rng() < 0.3;
    const r = free ? radius * 1.414 : radius * (0.05 + rng() * 0.9);
    xs[v] = lx + Math.cos(angle) * r;
    ys[v] = ly + Math.sin(angle) * r * floor;
    codes[v] = free ? 0 : wallEdgeCode(1 + ((rng() * 60000) | 0), 0.1 + rng() * 0.9);
  }
  return { lx, ly, floorInv: 1 / floor, xs, ys, codes, n };
}

/** Both writers on one polygon, each into its own buffer at float `o`; the rows as bits. */
function bothRows(p, o = 0) {
  const a = new Float32Array(o + ROW_FLOATS).fill(-7);
  const b = new Float32Array(o + ROW_FLOATS).fill(-7);
  WALL_ROW_ARGS[0] = p.lx;
  WALL_ROW_ARGS[1] = p.ly;
  WALL_ROW_ARGS[2] = p.floorInv;
  const wrote = writeWallRow(a, o, p.xs, p.ys, p.codes, p.n);
  const wroteRef = writeWallRowRef(b, o, p.xs, p.ys, p.codes, p.n);
  return { wrote, wroteRef, bits: new Uint32Array(a.buffer), bitsRef: new Uint32Array(b.buffer) };
}

function assertSameRow(p, label, o = 0) {
  const { wrote, wroteRef, bits, bitsRef } = bothRows(p, o);
  assert.equal(wrote, wroteRef, `${label}: vertices written`);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== bitsRef[i]) {
      const at = i - o;
      const where = at < 4 ? 'header' : at < 4 + WALL_BINS ? `bin ${at - 4}` : `vertex ${((at - 4 * WALL_VERT0) / 4) | 0} float ${at % 4}`;
      assert.fail(`${label}: float ${i} (${where}) differs`);
    }
  }
}

test('OL-8: the row is the plain writer\'s, bit for bit, on 4000 polygons of every size', () => {
  const rng = mulberry32(0x0b175);
  for (let k = 0; k < 4000; k++) {
    const n = 3 + ((rng() * rng() * (WALL_ROW_MAX_VERTS - 2)) | 0);
    assertSameRow(polygon(rng, n, { start: -Math.PI + (k % 7 === 0 ? rng() * 6 : 0), floor: k % 3 === 0 ? 1 : 0.7 }), `polygon ${k} (n ${n})`);
  }
});

test('OL-8: vertices that share rays, a full row, three vertices and fewer', () => {
  const rng = mulberry32(0x57ac);
  for (let k = 0; k < 300; k++) assertSameRow(polygon(rng, 4 + (k % 60), { stack: 0.7 }), `stacked ${k}`);
  for (let k = 0; k < 20; k++) assertSameRow(polygon(rng, WALL_ROW_MAX_VERTS), `full ${k}`);
  for (let k = 0; k < 50; k++) assertSameRow(polygon(rng, 3), `triangle ${k}`);
  // Every vertex on one ray: no bin is under any of them but the first.
  const flat = polygon(rng, 12, { stack: 1 });
  assertSameRow(flat, 'one ray');
  for (const n of [0, 1, 2]) assertSameRow({ ...polygon(rng, 3), n }, `n ${n}`);
});

test('OL-8: a row that is not the buffer\'s first', () => {
  const rng = mulberry32(0x0ff5e7);
  for (let k = 0; k < 100; k++) assertSameRow(polygon(rng, 5 + (k % 90)), `offset ${k}`, 4 * (1 + (k % 9)) * 13);
});
