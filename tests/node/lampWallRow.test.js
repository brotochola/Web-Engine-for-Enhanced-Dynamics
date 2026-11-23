// OL-4: a lamp's row (lampWallRow.js) against the polygon it was made from: a point is lit, in a wall's shadow or of the
// wall itself exactly where the sweep's polygon says, whatever the polygon's shape.
import assert from 'node:assert/strict';
import test from 'node:test';

import { lightingSource } from '../../src/render/faceMap.js';
import {
  WALL_BINS, WALL_ROW_ARGS, WALL_ROW_MAX_VERTS, WALL_UMBRA, WALL_VERT0, WALL_WALK, wallAngle, wallEdgeCode, wallRowLight, wallRowTexels, wallRowsLayout,
  writeEmptyWallRow, writeWallRow,
} from '../../src/render/visibility/lampWallRow.js';
import { readEngineShader } from './engineShaderSources.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A polygon as the sweep leaves it: sectors in rising atan2 from -π, each free (its two ends past the radius, code 0) or
 * a wall's face (two hits inside the radius, the wall's code). Neighbouring sectors share a ray, so their ends make the
 * step along it (two vertices on one ray), as the sweep's events do.
 */
function sectorPolygon(rand, { lx, ly, radius, sectors, wallShare }) {
  const cuts = [-Math.PI];
  for (let i = 1; i < sectors; i++) cuts.push(-Math.PI + (2 * Math.PI * (i + (rand() - 0.5) * 0.6)) / sectors);
  cuts.push(Math.PI - 1e-5);
  const list = [];
  const xs = [];
  const ys = [];
  const codes = [];
  const far = radius * Math.SQRT2;
  for (let k = 0; k < sectors; k++) {
    const a0 = cuts[k];
    const a1 = cuts[k + 1];
    const wall = rand() < wallShare && a1 - a0 < 1.2;
    const id = 1 + Math.floor(rand() * 900);
    const opacity = rand() < 0.5 ? 1 : 0.2 + 0.7 * rand();
    const d0 = wall ? radius * (0.15 + 0.8 * rand()) : far;
    const d1 = wall ? radius * (0.15 + 0.8 * rand()) : far;
    const code = wall ? wallEdgeCode(id, opacity) : 0;
    const steps = wall ? 1 : Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2)));
    const sector = { a0, a1, wall, id, opacity, ax: lx + Math.cos(a0) * d0, ay: ly + Math.sin(a0) * d0, bx: lx + Math.cos(a1) * d1, by: ly + Math.sin(a1) * d1 };
    list.push(sector);
    for (let s = 0; s <= steps; s++) {
      const a = a0 + ((a1 - a0) * s) / steps;
      const d = wall ? (s === 0 ? d0 : d1) : far;
      xs.push(Math.fround(lx + Math.cos(a) * d));
      ys.push(Math.fround(ly + Math.sin(a) * d));
      codes.push(code);
    }
  }
  return { list, xs: Float32Array.from(xs), ys: Float32Array.from(ys), codes: Float32Array.from(codes), n: xs.length };
}

/** What the polygon says of a point: 1 lit, or the wall's shadow for a pixel of entity selfId; null near an edge or a ray. */
function truth(poly, lx, ly, px, py, selfId) {
  const a = Math.atan2(py - ly, px - lx);
  for (const s of poly.list) {
    if (a < s.a0 || a >= s.a1) continue;
    if (a - s.a0 < 2e-3 || s.a1 - a < 2e-3) return null;
    if (!s.wall) return 1;
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const side = (ex * (py - s.ay) - ey * (px - s.ax)) / Math.sqrt(ex * ex + ey * ey);
    if (Math.abs(side) < 1.5) return null;
    if (side > 0) return 1;
    return selfId === s.id ? 1 : WALL_UMBRA + (1 - WALL_UMBRA) * (1 - Math.round(s.opacity * 255) / 255);
  }
  return null;
}

test('a row says what its polygon says, for every point around the lamp', () => {
  const rand = rng(20261118);
  const maxVerts = 128;
  const rows = new Float32Array(4 * wallRowTexels(maxVerts) * 3);
  let checked = 0;
  for (let round = 0; round < 60; round++) {
    const lx = (rand() - 0.5) * 20000;
    const ly = (rand() - 0.5) * 20000;
    const radius = 80 + rand() * 900;
    const sectors = 3 + Math.floor(rand() * (round % 3 === 0 ? 40 : 12));
    const poly = sectorPolygon(rand, { lx, ly, radius, sectors, wallShare: 0.6 });
    assert.ok(poly.n <= maxVerts, `the polygon fits (${poly.n})`);
    const o = 4 * wallRowTexels(maxVerts) * (round % 3);
    WALL_ROW_ARGS[0] = lx;
    WALL_ROW_ARGS[1] = ly;
    assert.equal(writeWallRow(rows, o, poly.xs, poly.ys, poly.codes, poly.n), poly.n);
    for (let k = 0; k < 400; k++) {
      const a = (rand() * 2 - 1) * Math.PI;
      const d = radius * (0.02 + 1.2 * rand());
      const px = lx + Math.cos(a) * d;
      const py = ly + Math.sin(a) * d;
      const selfId = rand() < 0.4 ? poly.list[Math.floor(rand() * poly.list.length)].id : rand() < 0.5 ? 0 : 7777;
      const want = truth(poly, lx, ly, px, py, selfId);
      if (want === null) continue;
      const got = wallRowLight(rows, o, px, py, selfId);
      assert.ok(Math.abs(got - want) < 1e-3, `round ${round}: point (${px}, ${py}) reads ${got}, the polygon says ${want}`);
      checked++;
    }
  }
  assert.ok(checked > 15000, `points compared (${checked})`);
});

test('on a foreshortened floor the row is the same polygon, in the floor\'s terms', () => {
  // The polygon is in world px (the colliders'), drawn on a floor 0.7 as tall as it is wide; the light pass asks in floor
  // px (world y / 0.7). Sight lines stay straight, so a point is lit or shaded as on the flat floor.
  const rand = rng(77);
  const floor = 0.7;
  const rows = new Float32Array(4 * wallRowTexels(128));
  let checked = 0;
  for (let round = 0; round < 20; round++) {
    const lx = (rand() - 0.5) * 4000;
    const ly = (rand() - 0.5) * 4000;
    const radius = 100 + rand() * 500;
    const poly = sectorPolygon(rand, { lx, ly, radius, sectors: 4 + Math.floor(rand() * 14), wallShare: 0.6 });
    WALL_ROW_ARGS[0] = lx;
    WALL_ROW_ARGS[1] = ly;
    WALL_ROW_ARGS[2] = 1 / floor;
    writeWallRow(rows, 0, poly.xs, poly.ys, poly.codes, poly.n);
    WALL_ROW_ARGS[2] = 1;
    for (let k = 0; k < 300; k++) {
      const a = (rand() * 2 - 1) * Math.PI;
      const d = radius * (0.05 + rand());
      const px = lx + Math.cos(a) * d;
      const py = ly + Math.sin(a) * d;
      const want = truth(poly, lx, ly, px, py, 0);
      if (want === null) continue;
      // Away from an edge by more than the ramp, in floor px too (the floor's scale stretches distances by up to 1 / 0.7).
      const got = wallRowLight(rows, 0, px, py / floor, 0);
      if (Math.abs(got - want) > 1e-3) {
        const near = truth(poly, lx, ly, px + 2.5 * Math.cos(a), py + 2.5 * Math.sin(a), 0) !== want
          || truth(poly, lx, ly, px - 2.5 * Math.cos(a), py - 2.5 * Math.sin(a), 0) !== want;
        assert.ok(near, `round ${round}: point (${px}, ${py}) reads ${got} on the scaled floor, the polygon says ${want}`);
        continue;
      }
      checked++;
    }
  }
  assert.ok(checked > 3500, `points compared (${checked})`);
});

test('many vertices in one direction bin are still found (up to the walk)', () => {
  // A fan of thin walls inside one bin's width: the search walks on from the bin's start vertex.
  const lx = 100;
  const ly = -50;
  const radius = 400;
  const binWidth = (2 * Math.PI) / WALL_BINS;
  const xs = [];
  const ys = [];
  const codes = [];
  const far = radius * Math.SQRT2;
  const push = (a, d, code) => {
    xs.push(Math.fround(lx + Math.cos(a) * d));
    ys.push(Math.fround(ly + Math.sin(a) * d));
    codes.push(code);
  };
  push(-Math.PI, far, 0);
  push(-Math.PI / 2, far, 0);
  const base = 0.3;
  const walls = Math.floor((WALL_WALK - 2) / 4);
  for (let w = 0; w < walls; w++) {
    const a0 = base + (binWidth * 0.5 * w) / walls;
    const a1 = base + (binWidth * 0.5 * (w + 0.6)) / walls;
    const code = wallEdgeCode(10 + w, 1);
    push(a0, far, 0);
    push(a0, 150 + 10 * w, code);
    push(a1, 150 + 10 * w, code);
    push(a1, far, 0);
  }
  push(Math.PI / 2, far, 0);
  push(Math.PI - 1e-5, far, 0);
  const n = xs.length;
  const rows = new Float32Array(4 * wallRowTexels(128));
  WALL_ROW_ARGS[0] = lx;
  WALL_ROW_ARGS[1] = ly;
  writeWallRow(rows, 0, Float32Array.from(xs), Float32Array.from(ys), Float32Array.from(codes), n);
  for (let w = 0; w < walls; w++) {
    const mid = base + (binWidth * 0.5 * (w + 0.3)) / walls;
    const gap = base + (binWidth * 0.5 * (w + 0.8)) / walls;
    const at = (a, d) => wallRowLight(rows, 0, lx + Math.cos(a) * d, ly + Math.sin(a) * d, 0);
    assert.equal(at(mid, 100), 1, `in front of wall ${w}`);
    assert.ok(Math.abs(at(mid, 300) - WALL_UMBRA) < 1e-6, `behind wall ${w}`);
    assert.equal(at(gap, 300), 1, `through the gap after wall ${w}`);
  }
});

test('an empty row and a row of too few vertices stop nothing', () => {
  const rows = new Float32Array(4 * wallRowTexels(16)).fill(9);
  writeEmptyWallRow(rows, 0);
  assert.equal(wallRowLight(rows, 0, 5, 5, 0), 1);
  rows.fill(9);
  WALL_ROW_ARGS[0] = 0;
  WALL_ROW_ARGS[1] = 0;
  assert.equal(writeWallRow(rows, 0, new Float32Array([1, 2]), new Float32Array([0, 1]), new Float32Array(2), 2), 0);
  assert.equal(wallRowLight(rows, 0, 50, 5, 3), 1);
});

test('the layout: a header, the directions, the vertices and the closing one', () => {
  assert.equal(WALL_VERT0, 1 + WALL_BINS / 4);
  assert.equal(wallRowTexels(128), WALL_VERT0 + 129);
  // Rising atan2, a unit a quarter turn.
  assert.equal(wallAngle(1, 0), 0);
  assert.equal(wallAngle(0, 1), 1);
  assert.equal(wallAngle(-1, 0), 2);
  assert.equal(wallAngle(0, -1), 3);
  assert.equal(wallEdgeCode(5, 0), 5 * 256 + 1, 'a wall is never read as free');
  const layout = wallRowsLayout(128, 128);
  // The header: the rows written, a lamp a row, and the frame's signature (OL-10: two words).
  assert.deepEqual(layout, {
    rowVerts: 128, rowTexels: 194, rowFloats: 776, lights: 128, headerInts: 131, signatureAt: 129, rowsByte: 528, bytes: 528 + 128 * 776 * 4,
  });
  assert.equal(wallRowsLayout(8, 5000).rowVerts, WALL_ROW_MAX_VERTS, 'a row is no wider than WALL_ROW_MAX_VERTS, whatever the polygons cap is');
  assert.equal(layout.rowsByte % 16, 0, 'the rows start on a float boundary');
  const xs = new Float32Array([-10, 0, 10, 0]);
  const ys = new Float32Array([0, -10, 0, 10]);
  const rows = new Float32Array(4 * wallRowTexels(4));
  WALL_ROW_ARGS[0] = 0;
  WALL_ROW_ARGS[1] = 0;
  writeWallRow(rows, 0, xs, ys, new Float32Array(4), 4);
  const v = 4 * WALL_VERT0;
  assert.deepEqual([rows[0], rows[1], rows[2], rows[3]], [4, 2, 0, 0]);
  assert.deepEqual([rows[v + 2], rows[v + 6], rows[v + 10], rows[v + 14], rows[v + 18]], [2, 3, 4, 5, 6], 'angles only rise, the closing vertex a turn on');
  assert.deepEqual([rows[v + 16], rows[v + 17]], [-10, 0], 'the closing vertex is the first');
});

test('the light pass reads rows by the module\'s numbers, in the WALLS variant alone', () => {
  for (const name of ['lightingBasic.frag.glsl', 'lightingBasic.wgsl']) {
    const source = readEngineShader(name);
    const on = lightingSource(source, { faces: true, sunMap: false, ids: true, walls: true });
    const number = (id) => Number(on.match(new RegExp(`const (?:int |float )?${id}(?:: (?:i32|f32))? = ([0-9.]+);`))[1]);
    assert.equal(number('WALL_BINS'), WALL_BINS, `${name}: WALL_BINS`);
    assert.equal(number('WALL_VERT0'), WALL_VERT0, `${name}: WALL_VERT0`);
    assert.equal(number('WALL_WALK'), WALL_WALK, `${name}: WALL_WALK`);
    // What a wall's shadow keeps is lighting.lightBehindWalls, the walls' second number, not a constant of the pass.
    assert.ok(!/WALL_UMBRA/.test(on), `${name}: no fixed share behind a wall`);
    assert.match(on, /uWalls.y/, `${name}: the share behind a wall is the uniform's`);
    // Each lamp loop's body asks the walls: the cones' and the points', for the floor and for a face.
    assert.equal(on.split('wallVisibility(').length - 1, 5, `${name}: the function and its four calls`);
    assert.ok(!on.includes('#if') && !on.includes('#endif'), `${name}: no block left open`);
    // Without walls, or without the ids a wall's own pixels are told by, nothing of it is left.
    for (const flags of [{ faces: true, sunMap: false, ids: true }, { faces: true, sunMap: false, ids: false, walls: true }]) {
      const off = lightingSource(source, flags);
      assert.ok(!off.includes('uWallRows') && !off.includes('wallVisibility') && !off.includes('uWalls'), `${name}: the walls are out`);
    }
  }
});

test('lighting.wallDepth: the light enters a wall that far from its edge and fades out, whatever is drawn there', () => {
  // A wall straight across in front of the lamp, 100 px away, from 45 degrees left to 45 right; free elsewhere.
  const far = 300 * Math.SQRT2;
  const pts = [[-Math.PI, far, 0], [-Math.PI / 2, far, 0], [-Math.PI / 4, far, 0], [-Math.PI / 4, 100 * Math.SQRT2, 1], [Math.PI / 4, 100 * Math.SQRT2, 1],
    [Math.PI / 4, far, 0], [Math.PI / 2, far, 0], [Math.PI - 1e-5, far, 0]];
  const code = wallEdgeCode(9, 1);
  const xs = Float32Array.from(pts, ([a, d]) => Math.cos(a) * d);
  const ys = Float32Array.from(pts, ([a, d]) => Math.sin(a) * d);
  const codes = Float32Array.from(pts, ([, , wall]) => (wall ? code : 0));
  const rows = new Float32Array(4 * wallRowTexels(16));
  WALL_ROW_ARGS[0] = 0;
  WALL_ROW_ARGS[1] = 0;
  writeWallRow(rows, 0, xs, ys, codes, pts.length);
  const at = (x, selfId, depth) => wallRowLight(rows, 0, x, 0, selfId, depth);
  // The wall's face is the line x = 100.
  assert.equal(at(90, 0, 0), 1, 'in front of the wall');
  assert.ok(Math.abs(at(120, 0, 0) - WALL_UMBRA) < 1e-6, 'behind it, without a depth: the shadow');
  assert.equal(at(120, 9, 0), 1, 'the wall\'s own pixel, without a depth: lit whole');
  // With a depth of 40 px: full at the edge, the shadow from 40 px in, falling all the way between, for any pixel.
  assert.ok(at(101, 0, 40) > 0.99, 'just inside the edge');
  const mid = at(120, 0, 40);
  assert.ok(mid > WALL_UMBRA + 0.2 && mid < 0.9, `half way in (${mid})`);
  assert.ok(at(110, 0, 40) > mid && mid > at(130, 0, 40), 'it only falls');
  assert.ok(Math.abs(at(140, 0, 40) - WALL_UMBRA) < 1e-6, 'at the depth: the shadow');
  assert.ok(Math.abs(at(180, 0, 40) - WALL_UMBRA) < 1e-6, 'and past it');
  assert.equal(at(120, 9, 40), mid, 'the wall\'s own pixel is lit as any other there: no sprite is lit whole');
});
