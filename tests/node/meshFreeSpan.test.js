import test from 'node:test';
import assert from 'node:assert/strict';

import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';

function initPool(verts, entities) {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const bytes = MeshGeometry.getBufferSize(verts, 0, entities);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), verts, 0, entities);
}

function outline(vertN) {
  const xy = new Float32Array(vertN * 2);
  for (let i = 0; i < vertN; i++) {
    xy[i * 2] = i;
    xy[i * 2 + 1] = (i & 1) ? 1 : 0;
  }
  return xy;
}

test('a freed span merges with a neighbor that was already skipped', () => {
  initPool(64, 4);
  MeshGeometry.vertFreeCount[0] = 2;
  MeshGeometry.vertFreeOff[0] = 0;
  MeshGeometry.vertFreeLen[0] = 10;
  MeshGeometry.vertFreeOff[1] = 10;
  MeshGeometry.vertFreeLen[1] = 15;
  MeshGeometry._freeSpan(
    MeshGeometry.vertFreeOff,
    MeshGeometry.vertFreeLen,
    MeshGeometry.vertFreeCount,
    25,
    10,
  );
  assert.equal(MeshGeometry.vertFreeCount[0], 1);
  assert.equal(MeshGeometry.vertFreeOff[0], 0);
  assert.equal(MeshGeometry.vertFreeLen[0], 35);
});

test('replace counts ignore the scratch tail', () => {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const verts = 32;
  const indices = 32;
  const bytes = MeshGeometry.getBufferSize(verts, indices, 1);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), verts, indices, 1);
  const pos = new Float32Array([0, 0, 4, 0, 0, 3, 99, 99]);
  const idx = new Uint32Array([0, 1, 2, 7, 7, 7]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1, 9, 9]);
  assert.equal(MeshGeometry.replace(0, pos, idx, uv, 3, 3), true);
  const at = MeshGeometry.vertOffset[0] | 0;
  assert.equal(MeshGeometry.vertCount[0], 3);
  assert.equal(MeshGeometry.indexCount[0], 3);
  assert.equal(MeshGeometry.vertexX[at + 2], 0);
  assert.equal(MeshGeometry.vertexY[at + 2], 3);
  assert.equal(MeshGeometry.uvU[at + 2], 0);
  assert.equal(MeshGeometry.indices[MeshGeometry.indexOffset[0] + 2], 2);
});

test('alternating mesh sizes return to one span covering the pool', () => {
  const verts = 64;
  const entities = 8;
  initPool(verts, entities);
  const sizes = [3, 6, 4, 8, 3, 5, 7, 4];
  for (let i = 0; i < entities; i++) {
    assert.equal(MeshGeometry.replace(i, outline(sizes[i]), null, null), true);
  }
  for (let i = entities - 1; i >= 0; i -= 2) MeshGeometry.clearEntity(i);
  for (let i = 0; i < entities; i += 2) MeshGeometry.clearEntity(i);
  assert.equal(MeshGeometry.vertFreeCount[0], 1);
  assert.equal(MeshGeometry.vertFreeOff[0], 0);
  assert.equal(MeshGeometry.vertFreeLen[0], verts);
});
