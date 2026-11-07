// DX-VOLUME on real code: what a volume writes to its mesh slot, the layer it joins and keeps, its floor scale down to the row,
// the mesh it refuses, and what a scene gets for listing the component.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { VolumeShadowCaster, resetVolumeShadowCasterWarns } from '../../src/components/volumeShadowCaster.js';
import { Layer } from '../../src/core/layer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { packMeshUvFill, MESH_UV_FILL_FLOATS, FILL_ROW } from '../../src/render/colliderFillBatch.js';
import { collectComponents } from '../../src/util/utils.js';
import { DEFAULT_LAYERS, LAYER_KIND, LIGHTING_DEFAULTS, VOLUME_LAYER, VOLUME_LAYER_Z } from '../../src/util/configDefaults.js';
import { resolveGroundScaleY } from '../../src/util/lightRadius.js';

const ENTITIES = 6;

function setup({ verts = 256, indices = 1024 } = {}) {
  MeshGeometry.reset();
  MeshGeometry.initializeArrays(new SharedArrayBuffer(MeshGeometry.getBufferSize(verts, indices, ENTITIES)), verts, indices, ENTITIES);
  MeshRenderer.initializeArrays(new SharedArrayBuffer(MeshRenderer.getBufferSize(ENTITIES)), ENTITIES);
  VolumeShadowCaster.initializeArrays(new SharedArrayBuffer(VolumeShadowCaster.getBufferSize(ENTITIES)), ENTITIES);
  VolumeShadowCaster.defaultFloorScaleY = 1;
  Layer.initializeFromConfig({ [VOLUME_LAYER]: { kind: LAYER_KIND.MESH, zIndex: VOLUME_LAYER_Z, sunProjected: true, volumeFloor: true } }, DEFAULT_LAYERS);
  resetVolumeShadowCasterWarns();
}

function volume(index, floorScaleY = 1) {
  VolumeShadowCaster.floorScaleY[index] = floorScaleY;
  const v = Object.create(VolumeShadowCaster.prototype);
  Object.defineProperty(v, 'index', { value: index });
  return v;
}

function renderer(index) {
  const r = Object.create(MeshRenderer.prototype);
  Object.defineProperty(r, 'index', { value: index });
  return r;
}

function mesh(i) {
  const at = MeshGeometry.vertOffset[i];
  const n = MeshGeometry.vertCount[i];
  const xy = [];
  const heights = [];
  for (let v = 0; v < n; v++) {
    xy.push(MeshGeometry.vertexX[at + v], MeshGeometry.vertexY[at + v]);
    heights.push(MeshGeometry.uvU[at + v]);
  }
  const ixAt = MeshGeometry.indexOffset[i];
  const indices = Array.from(MeshGeometry.indices.subarray(ixAt, ixAt + MeshGeometry.indexCount[i]));
  return { n, xy, heights, indices };
}

function warnings(run) {
  const seen = [];
  const warn = console.warn;
  console.warn = (m) => seen.push(String(m));
  try {
    run();
  } finally {
    console.warn = warn;
  }
  return seen;
}

beforeEach(() => setup());
afterEach(() => {
  VolumeShadowCaster.clearArrays();
  MeshRenderer.clearArrays();
  MeshGeometry.reset();
  Layer.reset();
});

test('setBox: the floor ring, the roof ring, the roof and four sides; no floor face', () => {
  volume(1).setBox(100, 40, 30);
  const { n, xy, heights, indices } = mesh(1);
  assert.equal(n, 8);
  assert.deepEqual(xy.slice(0, 8), [-50, -20, 50, -20, 50, 20, -50, 20]);
  assert.deepEqual(xy.slice(8), [-50, -20, 50, -20, 50, 20, -50, 20]);
  assert.deepEqual(heights, [0, 0, 0, 0, 30, 30, 30, 30]);
  assert.equal(indices.length, 30);
  for (let t = 0; t < 6; t++) assert.ok(indices[t] >= 4, 'the roof is made of roof corners');
  assert.equal(MeshGeometry.hasUv[1], 1);
});

test('setBox: its centre and a smaller roof', () => {
  volume(1).setBox(100, 40, 30, { offsetX: 5, offsetY: -20, topScale: 0.5 });
  const { xy } = mesh(1);
  assert.deepEqual(xy.slice(0, 2), [-45, -40]);
  assert.deepEqual(xy.slice(4, 6), [55, 0]);
  assert.deepEqual(xy.slice(8, 10), [-20, -30]);
  assert.deepEqual(xy.slice(12, 14), [30, -10]);
});

test('addLevel stacks: each level after what the volume has, its indices on its own corners', () => {
  const v = volume(2);
  v.addLevel([-10, -5, 10, -5, 10, 5, -10, 5], 0, 13);
  v.addLevel([-8, -4, 8, -4, 8, 4, -8, 4], 13, 27, [-5, -3, 5, -3, 5, 3, -5, 3]);
  const { n, xy, heights, indices } = mesh(2);
  assert.equal(n, 16);
  assert.deepEqual(heights, [0, 0, 0, 0, 13, 13, 13, 13, 13, 13, 13, 13, 27, 27, 27, 27]);
  assert.deepEqual(xy.slice(24, 26), [-5, -3]);
  assert.equal(indices.length, 60);
  assert.ok(indices.slice(30).every((c) => c >= 8), 'the second level uses its own corners');
  assert.ok(indices.slice(0, 30).every((c) => c < 8));
});

test('addLevel takes objects, and an outline that is not convex', () => {
  const v = volume(2);
  v.addLevel([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }], 0, 9);
  const { n, indices } = mesh(2);
  assert.equal(n, 12);
  assert.equal(indices.length, 12 + 36, 'four roof triangles, twelve on the sides');
});

test('levels leave no holes: an arena with room for the volumes exactly holds them', () => {
  setup({ verts: 5 * 20, indices: 5 * 78 });
  const seen = warnings(() => {
    for (let i = 0; i < 5; i++) {
      const v = volume(i);
      v.setBox(10, 10, 10);
      v.addLevel([-1, -1, 1, -1, 1, 1, 0, 2, -1, 1, -2, 0], 10, 20);
    }
  });
  assert.deepEqual(seen, []);
  for (let i = 0; i < 5; i++) assert.equal(MeshGeometry.vertCount[i], 20);
});

test('setBox replaces the volume; addLevel on nothing starts one; clear leaves none', () => {
  const v = volume(1);
  v.setBox(10, 10, 10);
  v.addLevel([-1, -1, 1, -1, 1, 1], 10, 20);
  assert.equal(mesh(1).n, 14);
  v.setBox(10, 10, 10);
  assert.equal(mesh(1).n, 8);
  v.clear();
  assert.equal(MeshGeometry.vertOffset[1], -1);
});

test('setHull: heights in the U column, no face on the floor, no point left inside', () => {
  // A box, and two points inside it.
  const points = [0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0, 0, 0, 30, 20, 0, 30, 20, 10, 30, 0, 10, 30, 10, 5, 0, 10, 5, 15];
  volume(1).setHull(points);
  const { n, xy, heights, indices } = mesh(1);
  assert.equal(n, 8);
  assert.equal(indices.length, 30, 'twelve hull triangles, less the two on the floor');
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    assert.ok(tri.some((c) => heights[c] > 0), 'no triangle lies on the floor');
  }
  const sorted = [];
  for (let v = 0; v < n; v++) sorted.push(`${xy[v * 2]},${xy[v * 2 + 1]},${heights[v]}`);
  assert.deepEqual(new Set(sorted).size, 8);
  assert.ok(sorted.includes('20,10,30'));
  assert.ok(!sorted.includes('10,5,15'), 'an inner point goes');
});

test('setHull reads objects, and a height below the floor as the floor', () => {
  const corners = [[0, 0, -5], [20, 0, -5], [20, 10, -5], [0, 10, -5], [0, 0, 30], [20, 0, 30], [20, 10, 30], [0, 10, 30]];
  volume(1).setHull(corners.map(([x, y, z]) => ({ x, y, z })));
  const { heights } = mesh(1);
  assert.equal(Math.min(...heights), 0);
  assert.equal(Math.max(...heights), 30);
});

test('points that enclose nothing leave the volume as it was, and warn once', () => {
  const v = volume(1);
  v.setBox(10, 10, 10);
  const seen = warnings(() => {
    v.setHull([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    v.setHull([0, 0, 0, 1, 0, 0]);
  });
  assert.equal(seen.length, 1);
  assert.equal(mesh(1).n, 8);
});

test('a volume joins its layer and stays there when the entity changes layer', () => {
  const bit = Layer.bit(Layer.get(VOLUME_LAYER).id);
  volume(1).setBox(10, 10, 10);
  assert.ok(MeshRenderer.layerMask[1] & bit);
  const entity = { index: 1, _hasComponents: { MeshRenderer: true, VolumeShadowCaster: true } };
  GameObject.prototype._applyLayerMask.call(entity, Layer.entitiesMask());
  assert.equal(MeshRenderer.layerMask[1], Layer.entitiesMask() | bit);
  const plain = { index: 2, _hasComponents: { MeshRenderer: true } };
  GameObject.prototype._applyLayerMask.call(plain, Layer.entitiesMask());
  assert.equal(MeshRenderer.layerMask[2], Layer.entitiesMask(), 'a mesh without a volume is routed as before');
});

test('an entity with no volume stays off the layer, where its collider would fill in black', () => {
  const bit = Layer.bit(Layer.get(VOLUME_LAYER).id);
  const entity = { index: 1, _hasComponents: { MeshRenderer: true, VolumeShadowCaster: true } };
  volume(1);
  GameObject.prototype._applyLayerMask.call(entity, Layer.entitiesMask());
  assert.equal(MeshRenderer.layerMask[1] & bit, 0, 'never had a volume');
  const v = volume(1);
  v.setBox(10, 10, 10);
  assert.ok(MeshRenderer.layerMask[1] & bit);
  v.clear();
  assert.equal(MeshRenderer.layerMask[1] & bit, 0, 'cleared');
  GameObject.prototype._applyLayerMask.call(entity, Layer.entitiesMask());
  assert.equal(MeshRenderer.layerMask[1] & bit, 0);
});

test('floorScaleY: validated as groundScaleY is, and a change marks the row', () => {
  const v = volume(1, 0.5);
  assert.equal(v.floorScaleY, 0.5);
  MeshRenderer.renderDirty[1] = 0;
  const epoch = MeshRenderer.paintEpoch[0];
  v.floorScaleY = 0.7;
  assert.equal(MeshRenderer.renderDirty[1], 1);
  assert.equal(MeshRenderer.paintEpoch[0], epoch + 1);
  assert.equal(v.floorScaleY, Math.fround(0.7));
  MeshRenderer.renderDirty[1] = 0;
  v.floorScaleY = 0.7;
  assert.equal(MeshRenderer.renderDirty[1], 0, 'the same value marks nothing');
  v.floorScaleY = -1;
  assert.equal(v.floorScaleY, resolveGroundScaleY(-1));
  v.setBox(10, 10, 10, { floorScaleY: 0.25 });
  assert.equal(v.floorScaleY, 0.25);
});

test('an entity with a volume refuses a mesh of its own, once in the console, and others are served', () => {
  volume(1).setBox(10, 10, 10);
  const before = mesh(1);
  const r = renderer(1);
  const seen = warnings(() => {
    assert.equal(r.setMesh([0, 0, 1, 0, 1, 1]), r);
    r.setVertices(new Float32Array(16));
    r.setHeights(new Float32Array(8));
    r.clearMesh();
    r.setPlane(10, 10, 1, 1);
    r.setRope([0, 0, 10, 0], 2);
    r.setPolygon([0, 0, 1, 0, 1, 1]);
  });
  assert.deepEqual(mesh(1), before);
  assert.equal(seen.length, 1);
  renderer(2).setMesh([0, 0, 1, 0, 1, 1]);
  assert.equal(MeshGeometry.vertCount[2], 3, 'an entity with no volume keeps its mesh');
});

test('a full arena warns about the knob that widens it', () => {
  setup({ verts: 10, indices: 60 });
  const seen = warnings(() => {
    volume(1).setBox(10, 10, 10);
    volume(2).setBox(10, 10, 10);
  });
  assert.ok(seen.some((m) => m.includes('lighting.maxVolumeVerts')), seen.join(' | '));
  assert.equal(MeshGeometry.vertCount[1], 8);
  assert.equal(MeshGeometry.vertCount[2], 0);
  assert.equal(MeshRenderer.layerMask[2], 0, 'no mesh, not on the layer');
});

test('a volume that no longer fits leaves the layer with its mesh', () => {
  setup({ verts: 14, indices: 90 });
  const bit = Layer.bit(Layer.get(VOLUME_LAYER).id);
  const v = volume(1);
  v.setBox(10, 10, 10);
  assert.ok(MeshRenderer.layerMask[1] & bit);
  warnings(() => v.addLevel([-1, -1, 1, -1, 1, 1, -1, 1], 10, 20));
  assert.equal(MeshGeometry.vertCount[1], 0);
  assert.equal(MeshRenderer.layerMask[1] & bit, 0);
});

test('the row carries a volume\'s floor scale in its tile offset, and a plain mesh keeps its own', () => {
  volume(1, 0.7).setBox(10, 10, 10);
  renderer(2).setMesh([0, 0, 1, 0, 1, 1], null, [0, 0, 1, 0, 1, 1]);
  const bit = Layer.bit(Layer.get(VOLUME_LAYER).id);
  MeshRenderer.layerMask[2] = bit;
  MeshRenderer.tileOffsetU[2] = MeshRenderer.packTileOffset01(0.25);
  MeshRenderer.active.fill(1);
  const zero = new Float32Array(ENTITIES);
  const views = {
    entityCount: ENTITIES,
    meshActive: MeshRenderer.active,
    meshVisible: MeshRenderer.renderVisible,
    meshLayerMask: MeshRenderer.layerMask,
    meshTint: MeshRenderer.tint,
    meshAlpha: MeshRenderer.alpha,
    meshTextureId: MeshRenderer.textureId,
    meshTileMode: MeshRenderer.tileMode,
    meshRepeatX: MeshRenderer.repeatX,
    meshRepeatY: MeshRenderer.repeatY,
    meshTileOffU: MeshRenderer.tileOffsetU,
    meshTileOffV: MeshRenderer.tileOffsetV,
    meshFloorScale: VolumeShadowCaster.floorScaleY,
    meshBits: bit,
    meshHasUv: MeshGeometry.hasUv,
    meshVertexX: MeshGeometry.vertexX,
    meshVertexY: MeshGeometry.vertexY,
    meshUvU: MeshGeometry.uvU,
    meshUvV: MeshGeometry.uvV,
    meshIndices: MeshGeometry.indices,
    meshVertOffset: MeshGeometry.vertOffset,
    meshVertCount: MeshGeometry.vertCount,
    meshIndexOffset: MeshGeometry.indexOffset,
    meshIndexCount: MeshGeometry.indexCount,
    x: zero,
    y: zero,
    rotC: new Float32Array(ENTITIES).fill(1),
    rotS: zero,
  };
  const out = new Float32Array(32 * MESH_UV_FILL_FLOATS);
  const written = packMeshUvFill(out, 32, Layer.get(VOLUME_LAYER).id, views);
  assert.equal(written, 11, 'ten triangles of the box, one of the mesh');
  assert.equal(out[FILL_ROW.TILE_OFF], Math.fround(0.7));
  assert.equal(out[9 * MESH_UV_FILL_FLOATS + FILL_ROW.TILE_OFF], Math.fround(0.7));
  assert.ok(Math.abs(out[10 * MESH_UV_FILL_FLOATS + FILL_ROW.TILE_OFF] - 0.25) < 1e-4);
});

test('a listed component brings the components it requires, and only then', () => {
  class Plain extends GameObject {
    static components = [];
  }
  class House extends GameObject {
    static components = [VolumeShadowCaster];
  }
  class Car extends House {}
  assert.ok(!collectComponents(Plain, GameObject).includes(MeshRenderer));
  assert.ok(collectComponents(House, GameObject).includes(MeshRenderer));
  assert.ok(collectComponents(Car, GameObject).includes(MeshRenderer), 'through a parent too');
});

test('a scene with volumes gets their layer and their share of the arena, and its class keeps its config', () => {
  class House extends GameObject {
    static components = [VolumeShadowCaster];
  }
  class Car extends House {}
  class Person extends GameObject {}
  class Town extends Scene {
    static config = { renderer: { maxMeshVerts: 100, maxMeshIndices: 300 }, layers: { ground: { kind: LAYER_KIND.MESH, zIndex: 0 } } };

    static entities = [[House, 10], [Car, 5], [Person, 1000]];
  }
  const { config } = new Town({});
  const per = LIGHTING_DEFAULTS.maxVolumeVerts;
  assert.equal(config.renderer.maxMeshVerts, 100 + 15 * per);
  assert.equal(config.renderer.maxMeshIndices, 300 + 15 * per * 6);
  assert.deepEqual(config.layers[VOLUME_LAYER], { zIndex: VOLUME_LAYER_Z, kind: LAYER_KIND.MESH, sunProjected: true, volumeFloor: true });
  assert.ok(config.layers.ground, 'its own layers stay');
  assert.equal(Town.config.renderer.maxMeshVerts, 100);
  assert.equal(Town.config.layers[VOLUME_LAYER], undefined);
  assert.equal(new Town({}).config.renderer.maxMeshVerts, 100 + 15 * per, 'a second load adds once');
});

test('a scene moves the layer with a config of its name, and lighting.maxVolumeVerts widens the arena', () => {
  class House extends GameObject {
    static components = [VolumeShadowCaster];
  }
  class Town extends Scene {
    static config = { lighting: { maxVolumeVerts: 32 }, layers: { [VOLUME_LAYER]: { zIndex: 7 } } };

    static entities = [[House, 10]];
  }
  const { config } = new Town({});
  assert.equal(config.layers[VOLUME_LAYER].zIndex, 7);
  assert.equal(config.layers[VOLUME_LAYER].sunProjected, true);
  assert.equal(config.renderer.maxMeshVerts, 320);
});

test('a scene with no volume is left alone', () => {
  class Person extends GameObject {}
  class Town extends Scene {
    static entities = [[Person, 10]];
  }
  const { config } = new Town({});
  assert.equal(config.layers?.[VOLUME_LAYER], undefined);
  assert.equal(config.renderer.maxMeshVerts | 0, 0);
});
