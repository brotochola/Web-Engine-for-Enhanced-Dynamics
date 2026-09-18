import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TerrainField,
  ISO,
  MAT_DIRT,
  extractIslands,
  buildContourFixtures,
  centroidFromPolys,
  polysToLocal,
  polygonArea,
  paintBrush,
} from '../../demos/destructibleTerrainScene/terrainMesh.js';

function makeFilledRect(cols, rows, cell, x0, y0, x1, y1) {
  const field = new TerrainField(cols, rows, cell);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      field.setAmount(x, y, 1, MAT_DIRT);
    }
  }
  return field;
}

test('seeded rectangle is one static-sized island with CCW tris', () => {
  const field = makeFilledRect(24, 16, 8, 4, 8, 20, 12);
  const islands = extractIslands(field);
  assert.equal(islands.length, 1);
  assert.ok(islands[0].areaCells > 20);
  assert.ok(islands[0].nodes.every((n) => field.node(n.x, n.y) >= ISO));

  const built = buildContourFixtures(islands[0], field, 3);
  assert.ok(built.polys.length >= 1);
  const cen = centroidFromPolys(built.polys);
  assert.ok(cen);
  const local = polysToLocal(built.polys, cen.x, cen.y);
  assert.ok(local.length >= 1);
  for (const poly of local) {
    assert.ok(poly.length >= 3 && poly.length <= 8);
    assert.ok(polygonArea(poly) > 1e-6);
  }
});

test('paint erase splits or shrinks the island', () => {
  const field = makeFilledRect(20, 12, 8, 2, 5, 18, 8);
  const before = extractIslands(field);
  assert.equal(before.length, 1);
  paintBrush(field, 10 * 8, 6.5 * 8, 3, 1, 1, true, MAT_DIRT);
  const after = extractIslands(field);
  assert.ok(after.length >= 1);
  const areaAfter = after.reduce((s, i) => s + i.areaCells, 0);
  assert.ok(areaAfter < before[0].areaCells - 1);
});
