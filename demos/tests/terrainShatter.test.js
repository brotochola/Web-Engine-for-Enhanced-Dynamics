import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldGrid } from '../../demos/destructibleTerrainScene/worldGrid.js';

const { polygonArea, subdivideConvex, shatterConvex } = WorldGrid;

// N-8. The shatter tool deleted the rock and spawned nothing. subdivideConvex
// split depth-first while a piece was over 35 px², so the 24-piece cap filled
// with ~11 px² pieces of the first fixture alone, and the shard spawn then
// dropped every piece under one cell (100 px²). shatterConvex splits the
// largest piece of the whole rock until there are 24 or the largest is under
// two minimum pieces.

const CELL_AREA = 100;
const MAX = 24;

// A 60 × 40 rock as 7 convex fixtures: four triangles, two quads, a pentagon.
const ROCK = [
  [[0, 0], [20, 0], [0, 20]],
  [[20, 0], [20, 20], [0, 20]],
  [[20, 0], [40, 0], [40, 20], [20, 20]],
  [[40, 0], [60, 0], [60, 20]],
  [[40, 0], [60, 20], [40, 20]],
  [[0, 20], [30, 20], [30, 40], [0, 40]],
  [[30, 20], [60, 20], [60, 30], [50, 40], [30, 40]],
].map((poly) => poly.map(([x, y]) => ({ x, y })));

const total = (polys) => polys.reduce((s, p) => s + Math.abs(polygonArea(p)), 0);

test('the old split leaves nothing the shard spawn keeps', () => {
  const out = [];
  for (const fixture of ROCK) subdivideConvex(fixture, CELL_AREA * 0.35, MAX, out);
  assert.equal(out.filter((p) => Math.abs(polygonArea(p)) >= CELL_AREA).length, 0);
});

test('shatterConvex spreads the pieces over the whole rock, none a sliver', () => {
  // 2550 px²: halving every piece of 2 cells or more ends at 20 pieces of 1-2 cells.
  const pieces = shatterConvex(ROCK, MAX, CELL_AREA);
  assert.equal(pieces.length, 20);
  assert.ok(Math.abs(total(pieces) - total(ROCK)) < 1e-6, 'area is kept');
  const areas = pieces.map((p) => Math.abs(polygonArea(p)));
  assert.ok(Math.min(...areas) >= CELL_AREA / 2, `smallest piece ${Math.min(...areas)}`);
  assert.ok(Math.max(...areas) < 2 * CELL_AREA, `largest piece ${Math.max(...areas)}`);
  // Every fixture contributes: some piece's centroid lies inside each one.
  const centroid = (p) => ({ x: p.reduce((s, v) => s + v.x, 0) / p.length, y: p.reduce((s, v) => s + v.y, 0) / p.length });
  for (const [i, fixture] of ROCK.entries()) {
    assert.ok(pieces.some((p) => { const c = centroid(p); return WorldGrid.pointInConvex(fixture, c.x, c.y); }), `fixture ${i}`);
  }
  for (const p of pieces) assert.ok(p.length >= 3 && p.length <= 8, 'a Box2D polygon');
});

test('a big rock stops at the piece cap', () => {
  const big = ROCK.map((poly) => poly.map((v) => ({ x: v.x * 2, y: v.y * 2 })));
  const pieces = shatterConvex(big, MAX, CELL_AREA);
  assert.equal(pieces.length, MAX);
  assert.ok(Math.abs(total(pieces) - total(big)) < 1e-6);
  assert.ok(Math.min(...pieces.map((p) => Math.abs(polygonArea(p)))) >= CELL_AREA);
});

test('a small rock stops splitting before it makes slivers', () => {
  const pieces = shatterConvex([ROCK[0]], MAX, CELL_AREA);
  // 200 px² halves once into two 100 px² pieces, then stops.
  assert.equal(pieces.length, 2);
  for (const p of pieces) assert.ok(Math.abs(polygonArea(p)) >= CELL_AREA - 1e-9);
});
