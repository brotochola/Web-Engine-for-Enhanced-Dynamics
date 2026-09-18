import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  packColliderFill,
  COLLIDER_FILL_FLOATS,
  resetColliderFillMeshLayerWarn,
} from '../../src/render/colliderFillBatch.js';
import { resetMeshRendererDrawableWarn, warnMeshRendererNeedsDrawableCollider } from '../../src/components/meshRenderer.js';
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
  assert.match(island, /MeshRenderer/);
  assert.equal(island.includes('SpriteRenderer'), false);
  assert.equal(island.includes('fillTint'), false);
});
