import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { Grid } from '../../src/core/grid.js';
import { Ray } from '../../src/core/ray.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

const N = 4;

function initSoA(maxFixtures = 16) {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N);
  Transform.rotS = new Float32Array(N);
  Transform.rotC.fill(1);
  Transform.rotS.fill(0);
  Transform.active[0] = 1;

  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  Collider.active[0] = 1;

  const fSize = ColliderFixture.getBufferSize(maxFixtures, N);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, N);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

/** One 128 px cell at the origin holding entity 0. */
function initOneCellGrid() {
  Grid.cellSize = 128;
  Grid.invCellSize = 1 / 128;
  Grid.gridWidth = 1;
  Grid.gridHeight = 1;
  Grid.totalCells = 1;
  Grid.maxEntitiesPerCell = 8;
  Grid.cellByteSize = 4 + 8 * 2;
  Grid._cellIdStride = Grid.cellByteSize / 2;
  Grid._headerIds = 2;
  const buf = new ArrayBuffer(Grid.cellByteSize);
  Grid._gridCounts = new Uint8Array(buf);
  Grid._gridEntities = new Uint16Array(buf);
  assert.ok(Grid.addEntityToCell(0, 0));
}

function initCompound() {
  initSoA();
  initOneCellGrid();
  assert.ok(Collider.replacePolygons(0, [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 20, y: 10 }],
  ]));
}

test('compound ray pick reports the closer ColliderFixture', () => {
  initCompound();
  const near = ColliderFixture.headOf(0);
  const far = ColliderFixture.next[near];
  assert.ok(near !== 0xffff && far !== 0xffff);

  // From the left the first triangle (x 0..7 at y = 3) is hit first; from the right, the second.
  const fromLeft = Ray.castWithInfo(-5, 3, 75, 3);
  assert.equal(fromLeft.hit, true);
  assert.equal(fromLeft.distance, 5);
  assert.equal(fromLeft.fixtureIndex, near);

  const fromRight = Ray.castWithInfo(40, 3, -40, 3);
  assert.equal(fromRight.hit, true);
  assert.equal(fromRight.distance, 13);
  assert.equal(fromRight.fixtureIndex, far);
});

test('castWithInfo scratch includes fixtureIndex -1 on miss', () => {
  const info = Ray._tempHitInfo;
  info.fixtureIndex = 99;
  const out = { hit: false, entityIndex: -1, distance: Infinity, hitX: 0, hitY: 0, fixtureIndex: 99 };
  const r = Ray.castWithInfo(0, 0, 0, 0, 10, 0xffffffff, out);
  assert.equal(r.fixtureIndex, -1);
});

test('castWithInfo skips excludeEntity', () => {
  initCompound();
  assert.equal(Ray.castWithInfo(-5, 3, 75, 3, Infinity, 0xffffffff, null, 1).hit, true);
  const r = Ray.castWithInfo(-5, 3, 75, 3, Infinity, 0xffffffff, null, 0);
  assert.equal(r.hit, false);
  assert.equal(r.entityIndex, -1);
});
