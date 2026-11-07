// DX-SUNMESH on the real path: heights go in the mesh's U column and reach the UV batch's rows; a layer flagged
// sunProjected moves its uniform with the sun, and only a sun that moved redraws it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { normalizeAlphaBySun } from '../../src/core/layer.js';

const read = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');

function geometry(entities = 4, verts = 64, indices = 96) {
  const bytes = MeshGeometry.getBufferSize(verts, indices, entities);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), verts, indices, entities);
  MeshGeometry.clearAll?.();
}

test('setHeights writes one height per vertex to U, zeroes V and moves the mesh to the UV rows', () => {
  geometry();
  const positions = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(MeshGeometry.replace(1, positions, [0, 1, 2, 0, 2, 3], null), true);
  const revision = MeshGeometry.revision[0];
  assert.equal(MeshGeometry.hasUv[1], 0);

  assert.equal(MeshGeometry.writeHeights(1, [0, 0, 40, 40]), true);
  const off = MeshGeometry.vertOffset[1];
  assert.deepEqual(Array.from(MeshGeometry.uvU.subarray(off, off + 4)), [0, 0, 40, 40]);
  assert.deepEqual(Array.from(MeshGeometry.uvV.subarray(off, off + 4)), [0, 0, 0, 0]);
  assert.equal(MeshGeometry.hasUv[1], 1);
  assert.equal(MeshGeometry.revision[0], revision + 1, 'the rows move batch: a topology change');
});

test('heights on a mesh already in the UV rows are an in-place write: generations, no topology change', () => {
  geometry();
  MeshGeometry.replace(1, [0, 0, 10, 0, 10, 10], null, null);
  MeshGeometry.writeHeights(1, [0, 0, 40]);
  const revision = MeshGeometry.revision[0];
  const uvGen = MeshGeometry.uvGen[1];
  const vertGen = MeshGeometry.vertGen[1];
  const epoch = MeshGeometry.vertEpoch[0];
  assert.equal(MeshGeometry.writeHeights(1, [0, 0, 50]), true);
  assert.equal(MeshGeometry.revision[0], revision);
  assert.equal(MeshGeometry.uvGen[1], uvGen + 1);
  assert.equal(MeshGeometry.vertGen[1], vertGen + 1);
  assert.equal(MeshGeometry.vertEpoch[0], epoch + 1);
});

test('setHeights refuses a wrong count, a non-finite height and a mesh that is not there', () => {
  geometry();
  MeshGeometry.replace(1, [0, 0, 10, 0, 10, 10], null, null);
  assert.equal(MeshGeometry.writeHeights(1, [0, 0]), false);
  assert.equal(MeshGeometry.writeHeights(1, [0, NaN, 1]), false);
  assert.equal(MeshGeometry.writeHeights(2, [0, 0, 1]), false);
  assert.equal(MeshGeometry.hasUv[1], 0);
});

test('MeshRenderer.setHeights is the geometry call, on this entity, and chains', () => {
  geometry();
  MeshGeometry.replace(2, [0, 0, 10, 0, 10, 10], null, null);
  const renderer = Object.create(MeshRenderer.prototype);
  Object.defineProperty(renderer, 'index', { value: 2 });
  assert.equal(renderer.setHeights([1, 2, 3]), renderer);
  const off = MeshGeometry.vertOffset[2];
  assert.deepEqual(Array.from(MeshGeometry.uvU.subarray(off, off + 3)), [1, 2, 3]);
});

test('both UV shaders move the vertex by height times the uniform, and it starts at 0 for every other layer', () => {
  assert.match(
    read('meshUvFill.vert.glsl'),
    /vec2 world = rotated \+ xy \+ \(aUV0\.x \+ aTri\.x \* \(aUV1\.x - aUV0\.x\) \+ aTri\.y \* \(aUV2\.x - aUV0\.x\)\) \* uSunShadow\.xy;/,
  );
  const wgsl = read('meshUvFill.wgsl');
  assert.match(wgsl, /let height = aUV0\.x \+ aTri\.x \* \(aUV1\.x - aUV0\.x\) \+ aTri\.y \* \(aUV2\.x - aUV0\.x\);/);
  assert.match(wgsl, /let world = rotated \+ xy \+ height \* sunShadow\.uSunShadow\.xy;/);
  const batch = fs.readFileSync(new URL('../../src/render/meshUvFillBatch.js', import.meta.url), 'utf8');
  assert.match(batch, /this\._sunShadow = new Float32Array\(4\);/);
});

test('a sunProjected layer defaults its alpha to the sun shadow’s', () => {
  const layer = fs.readFileSync(new URL('../../src/core/layer.js', import.meta.url), 'utf8');
  assert.match(layer, /config\.alphaBySun \?\? \(config\.sunProjected \? 'shadow' : null\)/);
  assert.equal(normalizeAlphaBySun('a', 'shadow'), 'shadow');
});
