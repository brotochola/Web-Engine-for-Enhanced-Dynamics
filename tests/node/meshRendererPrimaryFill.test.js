import test from 'node:test';
import assert from 'node:assert/strict';

import {
  packColliderFill,
  COLLIDER_FILL_FLOATS,
  resetColliderFillMeshLayerWarn,
} from '../../src/render/colliderFillBatch.js';
import { ShapeType, MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';

const INV = 0xffff;

function makeViews(n) {
  const views = {
    entityCount: n,
    meshActive: new Uint8Array(n),
    meshVisible: new Uint8Array(n),
    meshLayerMask: new Uint16Array(n),
    meshTint: new Uint32Array(n),
    meshAlpha: new Float32Array(n),
    fixtureCount: new Uint16Array(n),
    fixtureHead: new Uint16Array(n),
    fixtureNext: new Uint16Array(8),
    fixtureActive: new Uint8Array(8),
    vertCount: new Uint8Array(8),
    vertexX: new Float32Array(8 * 8),
    vertexY: new Float32Array(8 * 8),
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n),
    rotS: new Float32Array(n),
    offsetX: new Float32Array(n),
    offsetY: new Float32Array(n),
    meshBits: 1,
    maxFixtures: 8,
    primaryShapeType: new Uint8Array(n),
    primaryPolyCount: new Uint8Array(n),
    primaryPolyVertexX: new Float32Array(n * 8),
    primaryPolyVertexY: new Float32Array(n * 8),
    primaryWidth: new Float32Array(n),
    primaryHeight: new Float32Array(n),
    primaryRadius: new Float32Array(n),
  };
  views.meshVisible.fill(1);
  views.meshAlpha.fill(1);
  views.meshTint.fill(0x88aa66);
  views.rotC.fill(1);
  views.fixtureHead.fill(INV);
  views.fixtureNext.fill(INV);
  return views;
}

test('packColliderFill emits two tris for a primary box', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews(1);
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.primaryShapeType[0] = ShapeType.Box;
  views.primaryWidth[0] = 20;
  views.primaryHeight[0] = 10;
  const out = new Float32Array(8 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 8, 0, views);
  assert.equal(n, 2);
  assert.equal(out[0], -10);
  assert.equal(out[1], -5);
  assert.equal(out[2], 10);
  assert.equal(out[3], -5);
  assert.equal(out[4], 10);
  assert.equal(out[5], 5);
});

test('packColliderFill fans a primary makePolygon triangle', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews(1);
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.primaryShapeType[0] = ShapeType.Polygon;
  views.primaryPolyCount[0] = 3;
  views.primaryPolyVertexX[0] = 0;
  views.primaryPolyVertexY[0] = 0;
  views.primaryPolyVertexX[1] = 8;
  views.primaryPolyVertexY[1] = 0;
  views.primaryPolyVertexX[2] = 0;
  views.primaryPolyVertexY[2] = 6;
  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[0], 0);
  assert.equal(out[4], 0);
  assert.equal(out[5], 6);
});

test('packColliderFill emits a display 8-gon for a physics circle', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews(1);
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.primaryShapeType[0] = ShapeType.Circle;
  views.primaryRadius[0] = 10;
  const out = new Float32Array(16 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 16, 0, views);
  assert.equal(n, MAX_POLYGON_VERTICES - 2);
  assert.equal(out[0], 10);
  assert.equal(out[1], 0);
});

test('fixtures win over a primary box on the same entity', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews(1);
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.primaryShapeType[0] = ShapeType.Box;
  views.primaryWidth[0] = 40;
  views.primaryHeight[0] = 40;
  views.fixtureCount[0] = 1;
  views.fixtureHead[0] = 0;
  views.fixtureActive[0] = 1;
  views.vertCount[0] = 3;
  views.vertexX[0] = 1;
  views.vertexY[0] = 2;
  views.vertexX[1] = 3;
  views.vertexY[1] = 2;
  views.vertexX[2] = 1;
  views.vertexY[2] = 4;
  const out = new Float32Array(8 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 8, 0, views);
  assert.equal(n, 1);
  assert.equal(out[0], 1);
  assert.equal(out[1], 2);
});

test('packer warns once when MESH layer is set but collider is empty', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews(1);
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  const warnings = [];
  const prev = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
    assert.equal(packColliderFill(out, 4, 0, views), 0);
    assert.equal(packColliderFill(out, 4, 0, views), 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no drawable collider/);
  } finally {
    console.warn = prev;
    resetColliderFillMeshLayerWarn();
  }
});
