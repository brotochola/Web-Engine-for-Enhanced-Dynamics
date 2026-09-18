import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedResource } from '../../src/core/sharedResource.js';
import { WorldGrid, ISO, MAT_DIRT } from '../../demos/destructibleTerrainScene/worldGrid.js';

function makeFilledRect(cols, rows, cell, x0, y0, x1, y1) {
  WorldGrid.attach(cols, rows, cell);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      WorldGrid.setAmount(x, y, 1, MAT_DIRT);
    }
  }
}

function teardown() {
  SharedResource.resetAll();
  WorldGrid.cols = 640;
  WorldGrid.rows = 200;
  WorldGrid.cellSize = 10;
}

test('seeded rectangle is one static-sized island with CCW tris', () => {
  try {
    makeFilledRect(24, 16, 8, 4, 8, 20, 12);
    const islands = WorldGrid.extractIslands();
    assert.equal(islands.length, 1);
    assert.ok(islands[0].areaCells > 20);
    assert.ok(islands[0].nodes.every((n) => WorldGrid.node(n.x, n.y) >= ISO));

    const built = WorldGrid.buildContourFixtures(islands[0], 3);
    assert.ok(built.polys.length >= 1);
    const cen = WorldGrid.centroidFromPolys(built.polys);
    assert.ok(cen);
    const local = WorldGrid.polysToLocal(built.polys, cen.x, cen.y);
    assert.ok(local.length >= 1);
    for (const poly of local) {
      assert.ok(poly.length >= 3 && poly.length <= 8);
      assert.ok(WorldGrid.polygonArea(poly) > 1e-6);
    }
  } finally {
    teardown();
  }
});

test('paint erase splits or shrinks the island', () => {
  try {
    makeFilledRect(20, 12, 8, 2, 5, 18, 8);
    const before = WorldGrid.extractIslands();
    assert.equal(before.length, 1);
    WorldGrid.paint(10 * 8, 6.5 * 8, 3, 1, 1, true, MAT_DIRT);
    const after = WorldGrid.extractIslands();
    assert.ok(after.length >= 1);
    const areaAfter = after.reduce((s, i) => s + i.areaCells, 0);
    assert.ok(areaAfter < before[0].areaCells - 1);
  } finally {
    teardown();
  }
});

test('castRay hits a filled rect; origin inside is not t=0', () => {
  try {
    makeFilledRect(16, 10, 8, 4, 3, 12, 7);
    const hit = WorldGrid.castRay(8, 40, 1, 0, 200);
    assert.equal(hit.hit, true);
    assert.ok(hit.distance > 0);
    assert.ok(hit.x >= 32 - 1e-6);

    const inside = WorldGrid.castRay(8 * 6, 8 * 5, 1, 0, 200);
    assert.equal(inside.hit, false);
  } finally {
    teardown();
  }
});

test('setAmount writes the bound SAB', () => {
  try {
    WorldGrid.attach(4, 3, 8);
    assert.equal(WorldGrid.setAmount(1, 1, 0.5, MAT_DIRT), true);
    assert.equal(WorldGrid.amount[1 * 4 + 1], 0.5);
    assert.equal(WorldGrid.material[1 * 4 + 1], MAT_DIRT);
  } finally {
    teardown();
  }
});
