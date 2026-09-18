import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldGrid } from '../../demos/destructibleTerrainScene/worldGrid.js';

const {
  buildCellTriangleFixtures,
  buildContourFixtures,
  carveConvexAtPoint,
  centroidFromPolys,
  clipIslandAtPoint,
  pointInConvex,
  polygonArea,
  recenterPolys,
  splitConvexAtPoint,
  subdivideConvex,
} = WorldGrid;

const SQUARE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

test('pointInConvex: inside, outside, vertex', () => {
  assert.equal(pointInConvex(SQUARE, 5, 5), true);
  assert.equal(pointInConvex(SQUARE, 11, 5), false);
  assert.equal(pointInConvex(SQUARE, 0, 0), true);
  assert.equal(pointInConvex([{ x: 0, y: 0 }, { x: 1, y: 0 }], 0.5, 0), false);
});

test('subdivideConvex: splits until minArea, respects maxOut', () => {
  const pieces = subdivideConvex(SQUARE, 30, 24);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.length <= 24);
  let areaSum = 0;
  for (let i = 0; i < pieces.length; i++) {
    const a = polygonArea(pieces[i]);
    assert.ok(a > 0);
    assert.ok(a <= 30 + 1e-6);
    areaSum += a;
  }
  assert.ok(Math.abs(areaSum - 100) < 1e-4);

  const capped = subdivideConvex(SQUARE, 1, 1);
  assert.equal(capped.length, 1);
});

test('splitConvexAtPoint: hit child drops, others stay, area conserved', () => {
  const { keep, drop } = splitConvexAtPoint(SQUARE, 1, 1, 30, 24);
  assert.equal(drop.length, 1);
  assert.ok(keep.length >= 1);
  assert.equal(pointInConvex(drop[0], 1, 1), true);
  let area = polygonArea(drop[0]);
  for (let i = 0; i < keep.length; i++) area += polygonArea(keep[i]);
  assert.ok(Math.abs(area - 100) < 1e-4);
});

const CELL_TRI = [
  { x: 0, y: 0 },
  { x: 16, y: 0 },
  { x: 16, y: 16 },
];

test('carveConvexAtPoint: drills hit lineage, siblings stay, leaf vanishes', () => {
  const vanish = 32;
  const { keep, drop } = carveConvexAtPoint(CELL_TRI, 15, 1, vanish);
  assert.equal(drop.length, 1);
  assert.ok(keep.length >= 1);
  assert.equal(pointInConvex(drop[0], 15, 1), true);
  assert.ok(polygonArea(drop[0]) < vanish);
  let area = polygonArea(drop[0]);
  for (let i = 0; i < keep.length; i++) {
    assert.equal(keep[i].length, 3);
    assert.ok(polygonArea(keep[i]) > 1e-8);
    area += polygonArea(keep[i]);
  }
  assert.ok(Math.abs(area - 128) < 1e-4);
});

test('carveConvexAtPoint: already-small tri drops whole', () => {
  const tiny = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }];
  const { keep, drop } = carveConvexAtPoint(tiny, 1, 1, 32);
  assert.equal(keep.length, 0);
  assert.equal(drop.length, 1);
});

test('recenterPolys: COM back to origin after carve leftovers', () => {
  const { keep } = carveConvexAtPoint(CELL_TRI, 15, 1, 32);
  assert.ok(keep.length >= 1);
  const before = centroidFromPolys(keep);
  assert.ok(before);
  const shifted = recenterPolys(keep);
  assert.ok(Math.abs(shifted.x - before.x) < 1e-6);
  assert.ok(Math.abs(shifted.y - before.y) < 1e-6);
  const after = centroidFromPolys(keep);
  assert.ok(Math.abs(after.x) < 1e-6);
  assert.ok(Math.abs(after.y) < 1e-6);
});

test('buildCellTriangleFixtures: solid cells are 2 tris each; edges fan; no quads', () => {
  const CELL = 16;
  const island = {
    cellsMeta: [
      { cx: 0, cy: 0, caseId: 15, parts: [] },
      { cx: 1, cy: 0, caseId: 15, parts: [] },
      {
        cx: 2,
        cy: 0,
        caseId: 7,
        parts: [{
          verts: [
            { x: 32, y: 0 }, { x: 48, y: 0 },
            { x: 48, y: 16 }, { x: 32, y: 16 },
          ],
        }],
      },
      {
        cx: 3,
        cy: 0,
        caseId: 5,
        parts: [{
          verts: [
            { x: 48, y: 0 }, { x: 56, y: 0 }, { x: 64, y: 8 },
            { x: 56, y: 16 }, { x: 48, y: 16 },
          ],
        }],
      },
    ],
  };
  const built = buildCellTriangleFixtures(island, CELL);
  assert.equal(built.fallback, true);
  // 2 solid cells * 2 tris + quad→2 + pentagon→3
  assert.equal(built.polys.length, 9);
  for (const poly of built.polys) {
    assert.equal(poly.length, 3);
    assert.ok(polygonArea(poly) > 1e-8);
  }
});

const SQUARE64 = [
  [{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 64, y: 64 }],
  [{ x: 0, y: 0 }, { x: 64, y: 64 }, { x: 0, y: 64 }],
];

function islandArea(islands) {
  let a = 0;
  for (let i = 0; i < islands.length; i++) {
    for (let t = 0; t < islands[i].length; t++) a += polygonArea(islands[i][t]);
  }
  return a;
}

test('clipIslandAtPoint: edge bite remeshes to tris and drops area', () => {
  const { islands } = clipIslandAtPoint(SQUARE64, 0, 32, 16, 256);
  assert.ok(islands.length >= 1);
  let n = 0;
  for (let i = 0; i < islands.length; i++) {
    for (let t = 0; t < islands[i].length; t++) {
      assert.equal(islands[i][t].length, 3);
      n++;
    }
  }
  assert.ok(n >= 1);
  const area = islandArea(islands);
  assert.ok(area < 64 * 64 - 50);
  assert.ok(area > 256);
});

test('clipIslandAtPoint: center hole stays solid, hole centroid uncovered', () => {
  const { islands } = clipIslandAtPoint(SQUARE64, 32, 32, 12, 256);
  assert.equal(islands.length, 1);
  const tris = islands[0];
  assert.ok(tris.length >= 3);
  for (let t = 0; t < tris.length; t++) {
    assert.equal(tris[t].length, 3);
    const c = {
      x: (tris[t][0].x + tris[t][1].x + tris[t][2].x) / 3,
      y: (tris[t][0].y + tris[t][1].y + tris[t][2].y) / 3,
    };
    const d = Math.hypot(c.x - 32, c.y - 32);
    assert.ok(d > 8);
  }
  assert.ok(islandArea(islands) < 64 * 64 - 100);
});

test('buildContourFixtures fallback emits only tris', () => {
  WorldGrid.cellSize = 16;
  const island = {
    loops: [],
    contour: null,
    cellsMeta: [
      { cx: 0, cy: 0, caseId: 15, parts: [] },
      { cx: 0, cy: 1, caseId: 15, parts: [] },
    ],
  };
  const built = WorldGrid.buildContourFixtures(island, 3);
  assert.equal(built.fallback, true);
  assert.equal(built.polys.length, 4);
  for (const poly of built.polys) {
    assert.equal(poly.length, 3);
    assert.ok(polygonArea(poly) > 1e-8);
  }
});
