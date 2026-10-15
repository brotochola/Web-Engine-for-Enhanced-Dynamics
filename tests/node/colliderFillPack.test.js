import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  packColliderFill,
  packColliderFillPoseOnly,
  packMeshUvFill,
  rewriteExplicitMeshCorners,
  colliderFillCanSkipPack,
  copyMeshFillPoseScratch,
  COLLIDER_FILL_FLOATS,
  MESH_UV_FILL_FLOATS,
  resetColliderFillMeshLayerWarn,
} from '../../src/render/colliderFillBatch.js';
import {
  MeshRenderer,
  MESH_NO_TEXTURE,
  resetMeshRendererDrawableWarn,
  warnMeshRendererNeedsDrawableCollider,
} from '../../src/components/meshRenderer.js';
import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { Collider } from '../../src/components/collider.js';

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

test('packColliderFill filters MeshRenderer.layerMask', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews({ entities: 3, fixtures: 3 });
  views.meshActive[0] = 1;
  views.meshActive[1] = 1;
  views.meshActive[2] = 1;
  views.meshLayerMask[0] = 1;
  views.meshLayerMask[1] = 2;
  views.meshLayerMask[2] = 1;
  views.meshBits = 3;
  addTri(views, 0, 0, 0, 0, 10, 0, 0, 10);
  addTri(views, 1, 1, 0, 0, 8, 0, 0, 8);
  addTri(views, 2, 2, 0, 0, 6, 0, 0, 6);

  const out = new Float32Array(16 * COLLIDER_FILL_FLOATS);
  const n0 = packColliderFill(out, 16, 0, views);
  assert.equal(n0, 2);
  const n1 = packColliderFill(out, 16, 1, views);
  assert.equal(n1, 1);
});

test('packColliderFillPoseOnly matches full pack after pose/paint move', () => {
  const views = makeViews({ entities: 2, fixtures: 2 });
  views.meshActive[0] = 1;
  views.meshActive[1] = 1;
  views.meshLayerMask[0] = 1;
  views.meshLayerMask[1] = 1;
  views.x[0] = 10;
  views.y[0] = 20;
  views.x[1] = 40;
  views.y[1] = 50;
  views.offsetX[1] = 3;
  views.offsetY[1] = 4;
  addTri(views, 0, 0, 0, 0, 8, 0, 0, 8);
  addTri(views, 1, 1, 1, 1, 5, 1, 1, 5);

  const cap = 8;
  const out = new Float32Array(cap * COLLIDER_FILL_FLOATS);
  views.instanceEntity = new Uint32Array(cap);
  const n0 = packColliderFill(out, cap, 0, views);
  assert.equal(n0, 2);
  assert.equal(views.instanceEntity[0], 0);
  assert.equal(views.instanceEntity[1], 1);

  views.x[0] = 100;
  views.y[1] = 70;
  views.rotC[1] = 0;
  views.rotS[1] = 1;
  views.meshTint[0] = 0x112233;
  views.meshAlpha[1] = 0.5;

  const nPose = packColliderFillPoseOnly(out, cap, n0, views.instanceEntity, views);
  assert.equal(nPose, 2);

  const full = new Float32Array(cap * COLLIDER_FILL_FLOATS);
  views.outU32 = null;
  const n1 = packColliderFill(full, cap, 0, views);
  assert.equal(n1, 2);
  for (let i = 0; i < n1 * COLLIDER_FILL_FLOATS; i++) {
    assert.ok(
      Math.abs(out[i] - full[i]) < 1e-5,
      `float ${i} pose-only ${out[i]} full ${full[i]}`,
    );
  }
});

test('packColliderFill keeps world verts (camera is RT transform)', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.x[0] = 100;
  views.y[0] = 50;
  addTri(views, 0, 0, 0, 0, 10, 0, 0, 10);

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
  assert.equal(out[2], 10);
  assert.equal(out[3], 0);
  assert.equal(out[4], 0);
  assert.equal(out[5], 10);
  assert.equal(out[6], 100);
  assert.equal(out[7], 50);
});

test('visualOutset inflates local verts along normalize(local)', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.meshVisualOutset = new Float32Array([2]);
  addTri(views, 0, 0, 0, 0, 10, 0, 0, 10);

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
  assert.equal(out[2], 12);
  assert.equal(out[3], 0);
  assert.equal(out[4], 0);
  assert.equal(out[5], 12);
});

test('WORLD tile packs +1/period and animationFrameStart as flat texId', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.meshTextureId = new Uint16Array([2]);
  views.meshTileMode = new Uint8Array([1]);
  views.meshRepeatX = new Uint16Array([128]);
  views.meshRepeatY = new Uint16Array([64]);
  views.animationFrameStart = [0, 0, 7];
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[12], 7);
  assert.ok(Math.abs(out[13] - 1 / 128) < 1e-6);
  assert.ok(Math.abs(out[14] - 1 / 64) < 1e-6);
});

test('two islands share one instanceCount sum', () => {
  const views = makeViews({ entities: 2, fixtures: 2 });
  views.meshActive[0] = 1;
  views.meshActive[1] = 1;
  views.meshLayerMask[0] = 1;
  views.meshLayerMask[1] = 1;
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);
  addTri(views, 1, 1, 1, 1, 5, 1, 1, 5);

  const out = new Float32Array(8 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 8, 0, views);
  assert.equal(n, 2);
  assert.equal(out[0], 0);
  assert.equal(out[COLLIDER_FILL_FLOATS], 1);
});

test('static mesh fill packs live Transform, not stale pose', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.x[0] = 10;
  views.y[0] = 20;
  views.liveX = new Float32Array([40]);
  views.liveY = new Float32Array([80]);
  views.liveRotC = new Float32Array([1]);
  views.liveRotS = new Float32Array([0]);
  views.rbStatic = new Uint8Array([1]);
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[6], 40);
  assert.equal(out[7], 80);
});

test('dynamic mesh fill packs live Transform when published rotation is dead', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.x[0] = 10;
  views.y[0] = 20;
  views.rotC[0] = 0;
  views.rotS[0] = 0;
  views.liveX = new Float32Array([30]);
  views.liveY = new Float32Array([40]);
  views.liveRotC = new Float32Array([1]);
  views.liveRotS = new Float32Array([0]);
  views.rbStatic = new Uint8Array([0]);
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[6], 30);
  assert.equal(out[7], 40);
  assert.equal(out[8], 1);
  assert.equal(out[9], 0);
});

test('dynamic mesh fill packs live Transform when pose is leftover', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.x[0] = 0;
  views.y[0] = 0;
  views.liveX = new Float32Array([400]);
  views.liveY = new Float32Array([220]);
  views.liveRotC = new Float32Array([1]);
  views.liveRotS = new Float32Array([0]);
  views.rbStatic = new Uint8Array([0]);
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[6], 400);
  assert.equal(out[7], 220);
});

test('packer warns once when MeshRenderer has no MESH layer bit', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshVisible[0] = 1;
  views.meshLayerMask[0] = 0;
  views.meshBits = 1;
  addTri(views, 0, 0, 0, 0, 2, 0, 0, 2);

  const warnings = [];
  const prev = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
    packColliderFill(out, 4, 0, views);
    packColliderFill(out, 4, 0, views);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WeedJS: MeshRenderer requires setLayer on a LAYER_KIND.MESH layer/);
  } finally {
    console.warn = prev;
    resetColliderFillMeshLayerWarn();
  }
});

test('packer skips spawn-in-progress MeshRenderer (active, no layer, no fixtures)', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshVisible[0] = 1;
  views.meshLayerMask[0] = 0;
  views.meshBits = 1;

  const warnings = [];
  const prev = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
    const n = packColliderFill(out, 4, 0, views);
    assert.equal(n, 0);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = prev;
    resetColliderFillMeshLayerWarn();
  }
});

test('MeshRenderer warns once when collider is not drawable', () => {
  resetMeshRendererDrawableWarn();
  const warnings = [];
  const prev = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    warnMeshRendererNeedsDrawableCollider();
    warnMeshRendererNeedsDrawableCollider();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WeedJS: MeshRenderer has no drawable collider/);
  } finally {
    console.warn = prev;
    resetMeshRendererDrawableWarn();
  }
});

test('Collider has no fillTint', () => {
  assert.equal(Collider.ARRAY_SCHEMA.fillTint, undefined);
});

test('pixiWorker has no Graphics fixture fill', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../../src/workers/pixiWorker.js'), 'utf8');
  assert.equal(src.includes('_syncFixtureFills'), false);
  assert.equal(src.includes('_ensureFixtureFillGfx'), false);
  assert.equal(src.includes('new PIXI.Graphics'), false);
});

test('destructibleTerrainScene declares LAYER_KIND.MESH', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scene = fs.readFileSync(
    path.join(here, '../../demos/destructibleTerrainScene/destructibleTerrainScene.js'),
    'utf8'
  );
  const island = fs.readFileSync(
    path.join(here, '../../demos/destructibleTerrainScene/gameObjects/terrainIsland.js'),
    'utf8'
  );
  assert.match(scene, /kind:\s*LAYER_KIND\.MESH/);
  assert.match(scene, /fragment:\s*'rockContour'/);
  assert.match(scene, /webgl:\s*'\/demos\/shaders\/rockContour\.frag'/);
  assert.match(scene, /webgpu:\s*'\/demos\/shaders\/rockContour\.wgsl'/);
  assert.match(scene, /terrainRendererBackend/);
  assert.match(scene, /benchRemesh/);
  assert.equal(scene.includes('fillSpace'), false);
  assert.match(scene, /rocky:\s*'\/demos\/img\/rocky\.jpg'/);
  assert.match(island, /MeshRenderer/);
  assert.match(island, /setTexture\('rocky'\)/);
  assert.match(island, /setTileWorld\(128\)/);
  assert.match(island, /visualOutset\s*=\s*2/);
  assert.equal(island.includes('SpriteRenderer'), false);
  assert.equal(island.includes('fillTint'), false);
});

test('colliderFill.wgsl samples the atlas in uniform control flow', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wgsl = fs.readFileSync(path.join(here, '../../src/shaders/colliderFill.wgsl'), 'utf8');
  const frag = wgsl.slice(wgsl.indexOf('fn mainFrag'));
  const sampleAt = frag.indexOf('textureSample');
  const branchAt = frag.indexOf('vHasTex');
  assert.ok(sampleAt >= 0, 'mainFrag samples uTexture');
  assert.ok(branchAt < 0 || sampleAt < branchAt, 'textureSample must precede any vHasTex branch');
});

test('MESH look path is one RT, no fillSpace / SCREEN bake', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../../src/workers/pixiWorker.js'), 'utf8');
  assert.equal(src.includes('fillSpace'), false);
  assert.match(src, /_renderMeshFillToRt/);
  assert.match(src, /if\s*\(\s*!isMesh\s*\)/);
  assert.match(src, /cl\.rtOut\s*=/);
  assert.match(src, /_meshLookFlipV\(\)/);
  assert.match(src, /_makeLookShaderMesh\(cl\.shader,\s*isMesh\s*&&\s*this\._meshLookFlipV\(\)\)/);
  assert.match(src, /_makeLookShaderMesh\(cl\.shader,\s*!!cl\.fillBatch\s*&&\s*this\._meshLookFlipV\(\)\)/);
  assert.match(src, /return !this\._useWebGpu/);
  assert.match(src, /skip\._skipRt/);
  assert.match(src, /paintEpoch/);
  assert.match(src, /packColliderFillPoseOnly/);
  assert.match(src, /meshFillPresenceChanged/);
});

function attachExplicit(views, entity, xy, indices, uvs) {
  const n = views.entityCount | 0;
  if (!views.meshVertOffset) {
    views.meshVertOffset = new Int32Array(n);
    views.meshVertOffset.fill(-1);
    views.meshVertCount = new Uint16Array(n);
    views.meshIndexOffset = new Int32Array(n);
    views.meshIndexOffset.fill(-1);
    views.meshIndexCount = new Uint32Array(n);
    views.meshHasUv = new Uint8Array(n);
    views.meshVertexX = new Float32Array(64);
    views.meshVertexY = new Float32Array(64);
    views.meshUvU = new Float32Array(64);
    views.meshUvV = new Float32Array(64);
    views.meshIndices = new Uint16Array(64);
    views._meshCursor = 0;
    views._indexCursor = 0;
  }
  const vertN = (xy.length / 2) | 0;
  const at = views._meshCursor | 0;
  views._meshCursor = at + vertN;
  for (let v = 0; v < vertN; v++) {
    views.meshVertexX[at + v] = xy[v * 2];
    views.meshVertexY[at + v] = xy[v * 2 + 1];
    if (uvs) {
      views.meshUvU[at + v] = uvs[v * 2];
      views.meshUvV[at + v] = uvs[v * 2 + 1];
      views.meshHasUv[entity] = 1;
    }
  }
  views.meshVertOffset[entity] = at;
  views.meshVertCount[entity] = vertN;
  if (indices) {
    const iAt = views._indexCursor | 0;
    views._indexCursor = iAt + indices.length;
    for (let t = 0; t < indices.length; t++) views.meshIndices[iAt + t] = indices[t];
    views.meshIndexOffset[entity] = iAt;
    views.meshIndexCount[entity] = indices.length;
  }
}

function meshApi(index) {
  return new MeshRenderer(index | 0);
}

function initMeshPool(verts, indices, entities) {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const bytes = MeshGeometry.getBufferSize(verts, indices, entities);
  const buf = new SharedArrayBuffer(bytes);
  MeshGeometry.initializeArrays(buf, verts, indices, entities);
  assert.equal(buf.byteLength, bytes);
}

test('explicit mesh with no collider packs its triangles', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.meshVisualOutset = new Float32Array([9]);
  views.offsetX[0] = 50;
  views.x[0] = 100;
  attachExplicit(views, 0, [0, 0, 10, 0, 0, 8]);

  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[0], 0);
  assert.equal(out[2], 10);
  assert.equal(out[5], 8);
  assert.equal(out[6], 100);
  assert.equal(views.layerHasVertexUv, 0);
});

test('explicit mesh wins over a fixture fan', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  addTri(views, 0, 0, 9, 9, 19, 9, 9, 19);
  attachExplicit(views, 0, [1, 2, 3, 2, 1, 4]);
  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[0], 1);
  assert.equal(out[1], 2);
});

test('indexed explicit mesh packs each triangle', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  attachExplicit(
    views,
    0,
    [0, 0, 4, 0, 4, 2, 0, 2],
    [0, 1, 2, 0, 2, 3],
  );
  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 2);
  assert.equal(out[COLLIDER_FILL_FLOATS + 4], 0);
  assert.equal(out[COLLIDER_FILL_FLOATS + 5], 2);
});

test('per-vertex UVs skip the 18-float pack', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  attachExplicit(
    views,
    0,
    [0, 0, 4, 0, 0, 4],
    null,
    [0, 0, 1, 0, 0, 1],
  );
  const fill = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  assert.equal(packColliderFill(fill, 4, 0, views), 0);
  assert.equal(views.layerHasVertexUv, 1);
  const uv = new Float32Array(4 * MESH_UV_FILL_FLOATS);
  const n = packMeshUvFill(uv, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(uv[0], 0);
  assert.equal(uv[2], 4);
  assert.equal(uv[18], 0);
  assert.equal(uv[20], 1);
  assert.equal(uv[23], 1);
});

test('packer warns once when a MESH layer has nothing to draw', () => {
  resetColliderFillMeshLayerWarn();
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.meshBits = 1;
  const warnings = [];
  const prev = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
    assert.equal(packColliderFill(out, 4, 0, views), 0);
    packColliderFill(out, 4, 0, views);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no drawable collider/);
  } finally {
    console.warn = prev;
    resetColliderFillMeshLayerWarn();
  }
});

test('fixture fan still packs when no explicit mesh was set', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.meshVertOffset = new Int32Array([-1]);
  views.meshVertCount = new Uint16Array(1);
  views.meshIndexOffset = new Int32Array([-1]);
  views.meshIndexCount = new Uint32Array(1);
  views.meshHasUv = new Uint8Array(1);
  addTri(views, 0, 0, 0, 0, 6, 0, 0, 6);
  const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
  const n = packColliderFill(out, 4, 0, views);
  assert.equal(n, 1);
  assert.equal(out[2], 6);
});

test('mesh geometry revision blocks skip', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  addTri(views, 0, 0, 0, 0, 4, 0, 0, 4);
  views.fixtureRevision = new Uint32Array([3]);
  views.meshGeomRevision = new Uint32Array([1]);
  views.lastMeshRevision = 1;
  const prevPose = {};
  copyMeshFillPoseScratch(views, prevPose);
  assert.equal(colliderFillCanSkipPack(views, 3, prevPose), true);
  views.meshGeomRevision[0] = 2;
  assert.equal(colliderFillCanSkipPack(views, 3, prevPose), false);
});

test('setMesh packs without a collider and rejects non-finite positions', () => {
  initMeshPool(32, 64, 2);
  const warnings = [];
  const prev = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const mr = meshApi(0);
    assert.equal(mr.setMesh([0, 0, NaN, 0, 0, 1]), mr);
    assert.equal(MeshGeometry.vertOffset[0], -1);
    assert.equal(mr.setMesh([0, 0, 10, 0, 0, 8]), mr);
    assert.equal(MeshGeometry.vertCount[0], 3);
    assert.equal(MeshGeometry.indexOffset[0], -1);
    assert.equal(MeshGeometry.vertexX[MeshGeometry.vertOffset[0] + 1], 10);

    const views = makeViews({ entities: 1, fixtures: 1 });
    views.meshActive[0] = 1;
    views.meshLayerMask[0] = 1;
    views.meshVertOffset = MeshGeometry.vertOffset;
    views.meshVertCount = MeshGeometry.vertCount;
    views.meshIndexOffset = MeshGeometry.indexOffset;
    views.meshIndexCount = MeshGeometry.indexCount;
    views.meshHasUv = MeshGeometry.hasUv;
    views.meshVertexX = MeshGeometry.vertexX;
    views.meshVertexY = MeshGeometry.vertexY;
    views.meshUvU = MeshGeometry.uvU;
    views.meshUvV = MeshGeometry.uvV;
    views.meshIndices = MeshGeometry.indices;
    const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
    assert.equal(packColliderFill(out, 4, 0, views), 1);
    assert.equal(out[2], 10);

    mr.setVertices([0, 0, 4, 0, 0, 3]);
    assert.equal(MeshGeometry.vertexX[MeshGeometry.vertOffset[0] + 1], 4);
    assert.equal(mr.setVertices([0, 0, 1, 0]), mr);
    assert.equal(MeshGeometry.vertexX[MeshGeometry.vertOffset[0] + 1], 4);
    mr.clearMesh();
    assert.equal(MeshGeometry.vertOffset[0], -1);
    mr.setMesh([0, 0, 2, 0, 0, 2]);
    assert.equal(MeshGeometry.vertCount[0], 3);
  } finally {
    console.warn = prev;
    MeshGeometry.reset();
  }
  assert.equal(warnings.length, 0);
});

test('setMesh warns once when the vertex pool is off', () => {
  MeshGeometry.reset();
  const warnings = [];
  const prev = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const mr = meshApi(0);
    mr.setMesh([0, 0, 1, 0, 0, 1]);
    mr.setMesh([0, 0, 2, 0, 0, 2]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /maxMeshVerts/);
  } finally {
    console.warn = prev;
    MeshGeometry.reset();
  }
});

test('setPolygon, setPlane, and setRope write a mesh', () => {
  initMeshPool(64, 128, 2);
  try {
    const poly = meshApi(0);
    poly.setPolygon([0, 0, 3, 0, 3, 1, 1, 1, 1, 2, 0, 2]);
    assert.equal(MeshGeometry.vertCount[0], 6);
    assert.equal(MeshGeometry.indexCount[0], 12);
    assert.equal(MeshGeometry.hasUv[0], 0);

    const plane = meshApi(1);
    plane.setPlane(10, 6, 1, 1);
    assert.equal(MeshGeometry.vertCount[1], 4);
    assert.equal(MeshGeometry.indexCount[1], 6);
    assert.equal(MeshGeometry.hasUv[1], 1);
    const pAt = MeshGeometry.vertOffset[1];
    assert.equal(MeshGeometry.vertexX[pAt], -5);
    assert.equal(MeshGeometry.vertexY[pAt], -3);
    assert.equal(MeshGeometry.uvU[pAt + 1], 1);

    plane.setRope([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
    assert.equal(MeshGeometry.vertCount[1], 4);
    assert.equal(MeshGeometry.indexCount[1], 6);
    assert.equal(MeshGeometry.hasUv[1], 1);
    const rAt = MeshGeometry.vertOffset[1];
    assert.ok(Math.abs(MeshGeometry.vertexY[rAt] - 2) < 1e-5);
    assert.ok(Math.abs(MeshGeometry.vertexY[rAt + 1] + 2) < 1e-5);
  } finally {
    MeshGeometry.reset();
  }
});

test('meshUvFill.wgsl samples the atlas before the vHasTex branch', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wgsl = fs.readFileSync(path.join(here, '../../src/shaders/meshUvFill.wgsl'), 'utf8');
  const frag = wgsl.slice(wgsl.indexOf('fn mainFrag'));
  const sampleAt = frag.indexOf('textureSample');
  const branchAt = frag.indexOf('vHasTex');
  assert.ok(sampleAt >= 0);
  assert.ok(branchAt < 0 || sampleAt < branchAt);
});

test('pose-only paint keeps corners and writes tint', () => {
  const views = makeViews({ entities: 1, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshLayerMask[0] = 1;
  views.meshTint[0] = 0x112233;
  addTri(views, 0, 0, 0, 0, 8, 0, 0, 6);
  const cap = 4;
  const out = new Float32Array(cap * COLLIDER_FILL_FLOATS);
  views.instanceEntity = new Uint32Array(cap);
  const n = packColliderFill(out, cap, 0, views);
  assert.equal(n, 1);
  const corners = out.slice(0, 6);
  views.meshTint[0] = 0xaabbcc;
  views.meshAlpha[0] = 0.5;
  packColliderFillPoseOnly(out, cap, n, views.instanceEntity, views);
  for (let i = 0; i < 6; i++) assert.equal(out[i], corners[i]);
  const bits = new Uint32Array(out.buffer, out.byteOffset, out.length);
  const packed = bits[10];
  assert.equal(packed & 0xffffff, 0xaabbcc);
  assert.equal((packed >>> 24) & 255, 128);
});

test('visualOutset bumps outsetEpoch and not paintEpoch', () => {
  const n = 1;
  const buf = new ArrayBuffer(MeshRenderer.getBufferSize(n));
  MeshRenderer.initializeArrays(buf, n);
  MeshRenderer.visualOutset[0] = 0;
  MeshRenderer.renderDirty[0] = 0;
  const paint = MeshRenderer.paintEpoch[0];
  const mr = new MeshRenderer(0);
  mr.visualOutset = 4;
  assert.equal(MeshRenderer.visualOutset[0], 4);
  assert.equal(MeshRenderer.outsetEpoch[0], 1);
  assert.equal(MeshRenderer.paintEpoch[0], paint);
  mr.tint = 0xff00ff;
  assert.equal(MeshRenderer.paintEpoch[0], (paint + 1) >>> 0);
  assert.equal(MeshRenderer.outsetEpoch[0], 1);
  MeshRenderer.clearArrays();
});

test('writeVertices bumps vertGen and leaves topology revision', () => {
  initMeshPool(32, 64, 2);
  try {
    const a = meshApi(0);
    const b = meshApi(1);
    const rev0 = MeshGeometry.revision[0];
    a.setMesh([0, 0, 10, 0, 0, 8]);
    b.setMesh([1, 1, 4, 1, 1, 5]);
    const rev1 = MeshGeometry.revision[0];
    assert.ok(rev1 !== rev0);
    const epoch = Atomics.load(MeshGeometry.vertEpoch, 0);
    a.setVertices([0, 0, 20, 0, 0, 3]);
    assert.equal(MeshGeometry.revision[0], rev1);
    assert.equal(Atomics.load(MeshGeometry.vertGen, 0) > 0, true);
    assert.equal(Atomics.load(MeshGeometry.vertGen, 1), 0);
    assert.ok(Atomics.load(MeshGeometry.vertEpoch, 0) !== epoch);
    assert.equal(MeshGeometry.vertexX[MeshGeometry.vertOffset[0] + 1], 20);
    assert.equal(MeshGeometry.vertexX[MeshGeometry.vertOffset[1]], 1);
  } finally {
    MeshGeometry.reset();
  }
});

test('vert rewrite updates one mesh and leaves the other corners', () => {
  const views = makeViews({ entities: 2, fixtures: 1 });
  views.meshActive[0] = 1;
  views.meshActive[1] = 1;
  views.meshLayerMask[0] = 1;
  views.meshLayerMask[1] = 1;
  attachExplicit(views, 0, [0, 0, 4, 0, 0, 4]);
  attachExplicit(views, 1, [1, 1, 3, 1, 1, 3]);
  const cap = 4;
  const out = new Float32Array(cap * COLLIDER_FILL_FLOATS);
  views.instanceEntity = new Uint32Array(cap);
  const n = packColliderFill(out, cap, 0, views);
  assert.equal(n, 2);
  const keep = out[COLLIDER_FILL_FLOATS];
  views.meshVertexX[views.meshVertOffset[0] + 1] = 40;
  views.meshVertGen = new Uint32Array([1, 0]);
  const last = new Uint32Array(2);
  const code = rewriteExplicitMeshCorners(
    out, n, views.instanceEntity, views, COLLIDER_FILL_FLOATS, last,
  );
  assert.equal(code, 1);
  assert.equal(out[2], 40);
  assert.equal(out[COLLIDER_FILL_FLOATS], keep);
  assert.equal(out[COLLIDER_FILL_FLOATS + 2], 3);
});

test('MeshRenderer paintEpoch bumps once per dirty burst', () => {
  const n = 2;
  const buf = new ArrayBuffer(MeshRenderer.getBufferSize(n));
  MeshRenderer.initializeArrays(buf, n);
  MeshRenderer.renderDirty[0] = 0;
  const mr = new MeshRenderer(0);
  mr.tint = 0xff0000;
  const ep = MeshRenderer.paintEpoch[0];
  mr.tint = 0xff0000;
  assert.equal(MeshRenderer.paintEpoch[0], ep);
  mr.tint = 0x00ff00;
  assert.equal(MeshRenderer.paintEpoch[0], ep);
  MeshRenderer.renderDirty[0] = 0;
  mr.tint = 0x0000ff;
  assert.equal(MeshRenderer.paintEpoch[0], (ep + 1) >>> 0);
  MeshRenderer.clearArrays();
});

test('spawn path resets mesh tile / texture / outset', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../../src/core/gameObject.js'), 'utf8');
  assert.match(src, /MESH_NO_TEXTURE/);
  assert.match(src, /visualOutset\[i\]\s*=\s*0/);
  assert.match(src, /paintEpoch/);
  assert.equal(MESH_NO_TEXTURE, 0xffff);
});
