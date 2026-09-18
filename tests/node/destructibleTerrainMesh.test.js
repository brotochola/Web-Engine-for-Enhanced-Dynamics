import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedResource } from '../../src/core/sharedResource.js';
import { WorldGrid, ISO, MAT_DIRT, TUNE } from '../../demos/destructibleTerrainScene/worldGrid.js';

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
    const isl = islands[0];
    for (let i = 0; i < isl.nodeCount; i++) {
      assert.ok(WorldGrid.amount[isl.nodeIdx[isl.nodeStart + i]] >= ISO);
    }

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
    const beforeArea = before[0].areaCells;
    WorldGrid.paint(10 * 8, 6.5 * 8, 3, 1, 1, true, MAT_DIRT);
    const after = WorldGrid.extractIslands();
    assert.ok(after.length >= 1);
    const areaAfter = after.reduce((s, i) => s + i.areaCells, 0);
    assert.ok(areaAfter < beforeArea - 1);
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
    assert.ok(WorldGrid.hasDirty());
    const box = WorldGrid.consumeDirty(0);
    assert.equal(box.minX, 1);
    assert.equal(box.minY, 1);
    assert.equal(box.maxX, 1);
    assert.equal(box.maxY, 1);
    assert.equal(WorldGrid.hasDirty(), false);
  } finally {
    teardown();
  }
});

test('extractIslands(box) returns only the island that touches dirty', () => {
  try {
    WorldGrid.attach(24, 12, 8);
    for (let y = 2; y < 5; y++) {
      for (let x = 2; x < 6; x++) WorldGrid.setAmount(x, y, 1, MAT_DIRT);
    }
    for (let y = 2; y < 5; y++) {
      for (let x = 14; x < 18; x++) WorldGrid.setAmount(x, y, 1, MAT_DIRT);
    }
    WorldGrid.resetDirty();
    const all = WorldGrid.extractIslands();
    assert.equal(all.length, 2);
    const local = WorldGrid.extractIslands({ minX: 1, minY: 1, maxX: 7, maxY: 6 });
    assert.equal(local.length, 1);
    assert.ok(local[0].maxX < 10);
  } finally {
    teardown();
  }
});

test('crater remesh stays contour tris, not per-cell fallback', () => {
  try {
    makeFilledRect(28, 16, 8, 4, 4, 24, 12);
    for (let y = 7; y < 10; y++) {
      for (let x = 12; x < 16; x++) WorldGrid.setAmount(x, y, 0);
    }
    const islands = WorldGrid.extractIslands();
    assert.equal(islands.length, 1);
    const built = WorldGrid.buildContourFixtures(islands[0], 3);
    assert.equal(built.fallback, false);
    assert.ok(built.polys.length >= 1);
    assert.ok(built.polys.length < 200);
    let triArea = 0;
    for (let i = 0; i < built.polys.length; i++) triArea += WorldGrid.polygonArea(built.polys[i]);
    const ratio = triArea / islands[0].areaPx;
    assert.ok(ratio >= 0.72 && ratio <= 1.2);
    const hx = 14 * 8;
    const hy = 8.5 * 8;
    let coversHole = false;
    for (let i = 0; i < built.polys.length; i++) {
      if (WorldGrid.pointInPolygon(hx, hy, built.polys[i])) coversHole = true;
    }
    assert.equal(coversHole, false);
  } finally {
    teardown();
  }
});

test('extractIslands clip does not flood past the box', () => {
  try {
    makeFilledRect(40, 10, 8, 0, 2, 40, 6);
    const left = WorldGrid.extractIslands({ minX: 0, minY: 0, maxX: 15, maxY: 9 }, { clip: true });
    assert.ok(left.length >= 1);
    for (let i = 0; i < left.length; i++) {
      assert.ok(left[i].maxX <= 15);
    }
  } finally {
    teardown();
  }
});

test('no loops does not invent an AABB contour', () => {
  try {
    WorldGrid.attach(16, 12, 8);
    const island = {
      loops: [],
      contour: [],
      areaPx: 8000,
      areaCells: 200,
      cellCx: 40,
      cellCy: 40,
      cellsMeta: [],
    };
    const built = WorldGrid.buildContourFixtures(island, 3);
    assert.equal(built.fallback, false);
    assert.equal(built.polys.length, 0);
  } finally {
    teardown();
  }
});

test('simplify ladder accepts tris when low tol exceeds fixture cap', () => {
  try {
    makeFilledRect(28, 16, 8, 4, 4, 24, 12);
    for (let y = 7; y < 10; y++) {
      for (let x = 12; x < 16; x++) WorldGrid.setAmount(x, y, 0);
    }
    const islands = WorldGrid.extractIslands();
    assert.equal(islands.length, 1);
    WorldGrid.tuneSet(TUNE.FIXTURE_CAP, 20);
    WorldGrid.tuneSet(TUNE.SIMPLIFY_TOL, 1);
    WorldGrid.tuneSet(TUNE.SIMPLIFY_MAX, 16);
    const built = WorldGrid.buildContourFixtures(islands[0], 1);
    assert.ok(built.polys.length >= 1);
    assert.ok(built.polys.length <= 20);
    assert.equal(built.fallback, false);
  } finally {
    teardown();
  }
});

test('chunksOverlapping of a small dirty is 1-4 shards', () => {
  try {
    WorldGrid.attach(80, 20, 10);
    const one = WorldGrid.chunksOverlapping({ minX: 2, minY: 2, maxX: 6, maxY: 5 });
    assert.ok(one.length >= 1 && one.length <= 4);
    assert.equal(one[0].chunkX, 0);
    const two = WorldGrid.chunksOverlapping({ minX: 30, minY: 2, maxX: 40, maxY: 5 });
    assert.ok(two.length >= 1);
    const xs = [];
    for (let i = 0; i < two.length; i++) xs.push(two[i].chunkX);
    assert.ok(xs.includes(0) && xs.includes(1));
    const quads = WorldGrid.splitBoxQuads({ minX: 0, minY: 0, maxX: 31, maxY: 31 });
    assert.equal(quads.length, 4);
    const a = WorldGrid.chunkRect(0, 0);
    const b = WorldGrid.chunkRect(1, 0);
    assert.ok(a.maxX < b.minX);
  } finally {
    teardown();
  }
});

test('second WorldGrid.initialize keeps tune and dirty', () => {
  try {
    makeFilledRect(8, 8, 10, 2, 2, 4, 4);
    WorldGrid.tuneSet(0, 7);
    assert.equal(WorldGrid.hasDirty(), true);
    WorldGrid.initialize(WorldGrid.sharedBuffer, WorldGrid._schema);
    assert.equal(WorldGrid.tuneGet(0), 7);
    assert.equal(WorldGrid.hasDirty(), true);
  } finally {
    teardown();
  }
});
