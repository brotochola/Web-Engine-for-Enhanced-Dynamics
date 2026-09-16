import test from 'node:test';
import assert from 'node:assert/strict';

import { BulletComponent } from '../../src/components/bulletComponent.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { Layer } from '../../src/core/layer.js';
import { tickBulletsBuffers } from '../../src/util/bulletTick.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { Ray } from '../../src/core/ray.js';
import { Grid } from '../../src/core/grid.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';

const BUILT_IN_LAYERS = {
  BACKGROUND: {},
  DECALS: {},
  CASTED_SHADOWS: {},
  ENTITIES: {},
  LIGHTING: {},
};

function assertApprox(actual, expected, epsilon = 1e-4) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be close to ${expected}`
  );
}

function setupEmptyGrid() {
  Grid.cellSize = 128;
  Grid.invCellSize = 1 / 128;
  Grid.gridWidth = 4;
  Grid.gridHeight = 4;
  Grid.totalCells = 16;
  Grid.maxEntitiesPerCell = 8;
  Grid.cellByteSize = 4 + 8 * 2;
  const buf = new ArrayBuffer(Grid.totalCells * Grid.cellByteSize);
  Grid._gridCounts = new Uint8Array(buf);
  Grid._gridEntities = new Uint16Array(buf);
  Transform.active = new Uint8Array(1);
  Transform.x = new Float32Array(1);
  Transform.y = new Float32Array(1);
  Collider.active = new Uint8Array(1);
  Collider.shapeType = new Uint8Array(1);
  Collider.offsetX = new Float32Array(1);
  Collider.offsetY = new Float32Array(1);
  Collider.radius = new Float32Array(1);
  Collider.width = new Float32Array(1);
  Collider.height = new Float32Array(1);
  Collider.collisionLayer = new Uint8Array(1);
  Ray._rayGenStamp = new Uint32Array(1);
}

function setupPool(count) {
  const previous = {};
  for (const key of Object.keys(BulletComponent.ARRAY_SCHEMA)) {
    previous[key] = BulletComponent[key];
  }
  previous.bulletCount = BulletComponent.bulletCount;

  Layer.reset();
  Layer.initializeFromConfig({}, BUILT_IN_LAYERS, true);

  const buffer = new SharedArrayBuffer(BulletComponent.getBufferSize(count));
  BulletComponent.initializeArrays(buffer, count);
  BulletComponent.bulletCount = count;

  const freeListBuffer = new SharedArrayBuffer(count * Uint16Array.BYTES_PER_ELEMENT);
  const freeList = new Uint16Array(freeListBuffer);
  const freeListTopBuffer = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  resetFreeList(new Int32Array(freeListTopBuffer), freeList, count, 1);

  BulletPool.reset();
  BulletPool.initialize(count);
  BulletPool.initializeFreeList(freeListBuffer, freeListTopBuffer);

  setupEmptyGrid();

  return () => {
    BulletPool.reset();
    Layer.reset();
    for (const [key, value] of Object.entries(previous)) {
      BulletComponent[key] = value;
    }
  };
}

test('BulletPool.spawn writes speed = hypot(vx,vy) and a unit rot', () => {
  const restore = setupPool(8);
  try {
    const vx = 1200;
    const vy = 900;
    const i = BulletPool.spawn({
      x: 10,
      y: 20,
      vx,
      vy,
      damage: 1,
      ownerId: 0,
    });
    assert.ok(i >= 0);
    const expected = Math.hypot(vx, vy);
    assertApprox(BulletComponent.speed[i], expected);
    const n =
      BulletComponent.bulletRotC[i] * BulletComponent.bulletRotC[i] +
      BulletComponent.bulletRotS[i] * BulletComponent.bulletRotS[i];
    assertApprox(n, 1);
  } finally {
    restore();
  }
});

test('tickBulletsBuffers open field moves x += vx/60 at dtRatio 1', () => {
  const restore = setupPool(8);
  try {
    const vx = 600;
    const vy = 0;
    const i = BulletPool.spawn({
      x: 100,
      y: 50,
      vx,
      vy,
      damage: 1,
      ownerId: 3,
    });
    const activeData = new Uint16Array(9);
    tickBulletsBuffers({
      maxBullets: 8,
      dtRatio: 1,
      active: BulletComponent.active,
      x: BulletComponent.x,
      y: BulletComponent.y,
      prevX: BulletComponent.prevX,
      prevY: BulletComponent.prevY,
      vx: BulletComponent.vx,
      vy: BulletComponent.vy,
      speed: BulletComponent.speed,
      bulletRotC: BulletComponent.bulletRotC,
      bulletRotS: BulletComponent.bulletRotS,
      damage: BulletComponent.damage,
      ownerId: BulletComponent.ownerId,
      shooterEntityType: BulletComponent.shooterEntityType,
      activeData,
      impactHeader: null,
      impactData: null,
      maxImpacts: 0,
      excludeSet: null,
    });
    assertApprox(BulletComponent.x[i], 100 + vx / 60);
    assertApprox(BulletComponent.y[i], 50);
    assert.equal(activeData[0], 1);
    assert.equal(activeData[1], i);
  } finally {
    restore();
  }
});
