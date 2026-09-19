import test from 'node:test';
import assert from 'node:assert/strict';

import {
  packColliderFill,
  COLLIDER_FILL_FLOATS,
  COLLIDER_FILL_PACK_FIRST_FRAME,
  colliderFillCanSkipPack,
  copyMeshFillPoseScratch,
} from '../../src/render/colliderFillBatch.js';

const INV = 0xffff;

function makeViews({ entities, fixtures }) {
  const n = entities;
  const fx = fixtures;
  const views = {
    entityCount: n,
    meshActive: new Uint8Array(n),
    meshVisible: new Uint8Array(n),
    meshLayerMask: new Uint16Array(n),
    meshTint: new Uint32Array(n),
    meshAlpha: new Float32Array(n),
    fixtureCount: new Uint16Array(n),
    fixtureHead: new Uint16Array(n),
    fixtureNext: new Uint16Array(fx),
    fixtureActive: new Uint8Array(fx),
    vertCount: new Uint8Array(fx),
    vertexX: new Float32Array(fx * 8),
    vertexY: new Float32Array(fx * 8),
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n),
    rotS: new Float32Array(n),
    offsetX: new Float32Array(n),
    offsetY: new Float32Array(n),
    meshBits: 1,
    maxFixtures: fx,
    fixtureRevision: new Uint32Array(1),
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

function addTri(views, entity, fx, x0, y0, x1, y1, x2, y2) {
  views.fixtureActive[fx] = 1;
  views.vertCount[fx] = 3;
  const b = fx * 8;
  views.vertexX[b] = x0;
  views.vertexY[b] = y0;
  views.vertexX[b + 1] = x1;
  views.vertexY[b + 1] = y1;
  views.vertexX[b + 2] = x2;
  views.vertexY[b + 2] = y2;
  views.fixtureNext[fx] = views.fixtureHead[entity];
  views.fixtureHead[entity] = fx;
  views.fixtureCount[entity] = (views.fixtureCount[entity] + 1) | 0;
}

function checksumFloat(out, count) {
  let s = 0;
  const n = count | 0;
  for (let i = 0; i < n; i++) {
    const b = i * COLLIDER_FILL_FLOATS;
    // Skip tintBits (index 10): those bits are often a float NaN.
    for (let k = 0; k < 10; k++) s += out[b + k];
    s += out[b + 11];
  }
  return s;
}

test('first frame always packs; unchanged revision+pose can skip', () => {
  const views = makeViews({ entities: 2, fixtures: 2 });
  views.meshActive[0] = 1;
  views.meshActive[1] = 1;
  views.meshLayerMask[0] = 1;
  views.meshLayerMask[1] = 1;
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);
  addTri(views, 1, 1, 1, 1, 5, 1, 1, 5);
  views.fixtureRevision[0] = 3;

  const prevPose = {};
  assert.equal(
    colliderFillCanSkipPack(views, COLLIDER_FILL_PACK_FIRST_FRAME, prevPose),
    false,
  );

  const out = new Float32Array(8 * COLLIDER_FILL_FLOATS);
  const packed = packColliderFill(out, 8, 0, views);
  assert.equal(packed, 2);
  const sum0 = checksumFloat(out, packed);
  copyMeshFillPoseScratch(views, prevPose);

  assert.equal(colliderFillCanSkipPack(views, 3, prevPose), true);
  assert.equal(checksumFloat(out, packed), sum0);
});

test('fixture revision bump forces pack and checksum changes', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);
  views.fixtureRevision[0] = 1;

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const packed0 = packColliderFill(out, 4, 0, views);
  const sum0 = checksumFloat(out, packed0);
  const prevPose = {};
  copyMeshFillPoseScratch(views, prevPose);

  views.vertexX[0] = 10;
  views.vertexY[0] = 2;
  views.fixtureRevision[0] = 2;
  assert.equal(colliderFillCanSkipPack(views, 1, prevPose), false);

  const packed1 = packColliderFill(out, 4, 0, views);
  assert.equal(packed1, packed0);
  assert.notEqual(checksumFloat(out, packed1), sum0);
});

test('moving one entity forces pack', () => {
  const views = makeViews({ entities: 2, fixtures: 2 });
  views.meshActive[0] = 1;
  views.meshActive[1] = 1;
  views.meshLayerMask[0] = 1;
  views.meshLayerMask[1] = 1;
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);
  addTri(views, 1, 1, 1, 1, 5, 1, 1, 5);
  views.x[0] = 10;
  views.y[0] = 20;
  views.fixtureRevision[0] = 4;

  const prevPose = {};
  copyMeshFillPoseScratch(views, prevPose);
  assert.equal(colliderFillCanSkipPack(views, 4, prevPose), true);

  views.x[1] = 3;
  assert.equal(colliderFillCanSkipPack(views, 4, prevPose), false);
});

test('paintEpoch O(1) forces pack without scanning renderDirty', () => {
  const views = makeViews({ entities: 4, fixtures: 4 });
  views.meshActive.fill(1);
  views.meshLayerMask.fill(1);
  addTri(views, 0, 0, 0, 0, 2, 0, 0, 2);
  views.fixtureRevision[0] = 1;
  views.paintEpoch = new Uint32Array([3]);
  views.lastPaintEpoch = 3;
  const prevPose = {};
  copyMeshFillPoseScratch(views, prevPose);
  assert.equal(colliderFillCanSkipPack(views, 1, prevPose), true);
  views.paintEpoch[0] = 4;
  assert.equal(colliderFillCanSkipPack(views, 1, prevPose), false);
});

test('renderDirty paint forces pack', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.meshDirty = new Uint8Array(1);
  addTri(views, 0, 0, 0, 0, 2, 0, 0, 2);
  views.fixtureRevision[0] = 1;
  const prevPose = {};
  copyMeshFillPoseScratch(views, prevPose);
  assert.equal(colliderFillCanSkipPack(views, 1, prevPose), true);
  views.meshDirty[0] = 1;
  assert.equal(colliderFillCanSkipPack(views, 1, prevPose), false);
});

test('presence change (hide mesh) forces pack', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  addTri(views, 0, 0, 0, 0, 2, 0, 0, 2);
  views.fixtureRevision[0] = 1;
  const prevPose = {};
  copyMeshFillPoseScratch(views, prevPose);
  views.meshVisible[0] = 0;
  assert.equal(colliderFillCanSkipPack(views, 1, prevPose), false);
});
