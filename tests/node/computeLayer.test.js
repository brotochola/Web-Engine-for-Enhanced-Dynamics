import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/Layer.js';
import { Collider } from '../../src/components/Collider.js';
import { Transform } from '../../src/components/Transform.js';
import { RigidBody } from '../../src/components/RigidBody.js';
import { feedLayerAt, clearFeedLayerAt } from '../../src/core/computeFeed.js';
import { packBox2dBodies, BODY_FLOATS } from '../../src/workers/Box2dBodyPack.js';
import { inferComputeLayout } from '../../src/workers/inferComputeLayout.js';
import { prependComputePrelude } from '../../src/workers/wgslPrelude.js';
import {
  ENGINE_FRAME_PREFIX_FLOATS,
  computePassActive,
  latticeLookUv,
} from '../../src/workers/ComputeLayer.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAYER_COMPUTE_SOURCE,
  FEED_LAYER_NONE,
  FEED_SLOT_NONE,
  ShapeType,
  COMPUTE_FLAG_STATIC,
} from '../../src/core/ConfigDefaults.js';

const BUILT_IN_LAYERS = {
  BACKGROUND: {},
  DECALS: {},
  CASTED_SHADOWS: {},
  ENTITIES: {},
  LIGHTING: {},
};

test('compute layer metadata: no sprite queue, BOX2D_BODIES default, maxBodies 512', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          zIndex: 6,
          maxItems: 0,
          shader: {
            fragment: 'fireLook',
            compute: { source: 'fireSim', passes: [{ entry: 'main', layout: 'simple' }] },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const fire = Layer.get('fire');
    assert.ok(fire);
    assert.equal(fire.hasRenderQueue, false);
    assert.equal(Layer.isComputeLayer(fire.id), true);
    assert.equal(fire.computeSource, LAYER_COMPUTE_SOURCE.BOX2D_BODIES);
    assert.equal(fire.compute.maxBodies, 512);
    assert.equal(fire.compute.size.scale, 1);
    assert.equal(Layer._metadata.layers[fire.id].hasRenderQueue, false);
    assert.equal(Layer._metadata.layers[fire.id].maxBodies, 512);
    assert.equal(Layer._feedMax[fire.id], 512);
    assert.equal(Layer.fire, fire);
  } finally {
    Layer.reset();
  }
});

test('initializeFromBuffers restores Layer.fire accessor', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      { fire: { shader: { fragment: 'f', compute: 's' } } },
      BUILT_IN_LAYERS,
      true
    );
    const data = Layer.getSerializableData();
    const fireId = Layer.get('fire').id;
    Layer.reset();
    Layer.initializeFromBuffers(data);
    assert.ok(Layer.fire);
    assert.equal(Layer.fire.id, fireId);
  } finally {
    Layer.reset();
  }
});

test('feedLayerId sentinel is 255 and swap-remove keeps dense list', () => {
  const count = 8;
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(count)), count);
  assert.equal(Collider.feedLayerId[0], FEED_LAYER_NONE);
  assert.equal(Collider.feedSlot[0], FEED_SLOT_NONE);

  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: { fragment: 'fireLook', compute: 'fireSim', maxBodies: 4 },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('fire').id;
    Collider.active[1] = 1;
    Collider.active[2] = 1;
    Collider.active[3] = 1;
    assert.equal(feedLayerAt(1, id), true);
    assert.equal(feedLayerAt(2, id), true);
    assert.equal(feedLayerAt(3, id), true);
    assert.equal(Collider.feedLayerId[1], id);
    assert.equal(Atomics.load(Layer._feedCount, id), 3);

    clearFeedLayerAt(1);
    assert.equal(Collider.feedLayerId[1], FEED_LAYER_NONE);
    assert.equal(Atomics.load(Layer._feedCount, id), 2);
    const slot0 = Layer._feedIndices[id][0];
    assert.ok(slot0 === 2 || slot0 === 3);
    assert.equal(Collider.feedSlot[slot0], 0);
  } finally {
    Layer.reset();
  }
});

test('packBox2dBodies stride 16 and polygon vert range', () => {
  assert.equal(BODY_FLOATS, 16);
  const n = 4;
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(n)), n);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  Transform.x = new Float32Array(n);
  Transform.y = new Float32Array(n);
  Transform.rotC = new Float32Array(n);
  Transform.rotS = new Float32Array(n);
  RigidBody.vx = new Float32Array(n);
  RigidBody.vy = new Float32Array(n);
  RigidBody.angularVelocity = new Float32Array(n);

  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: { fragment: 'f', compute: 's', maxBodies: 8 },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('fire').id;
    Collider.active[0] = 1;
    Collider.shapeType[0] = ShapeType.Polygon;
    Collider.makePolygon(0, [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 0, y: 12 },
    ]);
    Transform.x[0] = 100;
    Transform.y[0] = 50;
    Transform.rotC[0] = 1;
    Transform.rotS[0] = 0;
    RigidBody.static[0] = 1;
    feedLayerAt(0, id);

    const bodies = new Float32Array(8 * BODY_FLOATS);
    const verts = new Float32Array(64);
    const packed = packBox2dBodies(id, bodies, verts, 8, { sweep: false });
    assert.equal(packed.bodyCount, 1);
    assert.equal(packed.vertCount, 3);
    assert.equal(bodies[6], ShapeType.Polygon);
    assert.equal(bodies[11], 0);
    assert.equal(bodies[12], 3);
    assert.equal((bodies[7] | 0) & COMPUTE_FLAG_STATIC, COMPUTE_FLAG_STATIC);
    assert.equal(verts[0], -10);
    assert.equal(verts[5], 12);
  } finally {
    Layer.reset();
  }
});

test('compute textures, layouts, size.scale, and pass extras round-trip', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          zIndex: 6,
          maxItems: 0,
          shader: {
            fragment: 'fireLook',
            compute: {
              source: 'fireFluid',
              passes: [
                {
                  entry: 'shift_fields',
                  layout: 'fluid',
                  when: 'originShift',
                  swap: ['u', 'v', 't', 'p'],
                },
                {
                  entry: 'step_swirls',
                  layout: 'fluid',
                  workgroup: [64],
                  dispatchFrom: 'swirls',
                },
                { entry: 'pack_heat', source: 'firePack', layout: 'pack' },
              ],
              textures: [
                { name: 'u', format: 'r32float', pingPong: true },
                { name: 'pack', format: 'rgba8unorm', look: true },
              ],
              buffers: [{ name: 'swirls', strideFloats: 8, count: 200 }],
              layouts: {
                pack: [
                  [{ binding: 0, buffer: 'uniform', resource: 'params' }],
                  [
                    {
                      binding: 0,
                      storageTexture: { format: 'rgba8unorm', access: 'write-only' },
                      resource: 'pack',
                    },
                  ],
                ],
              },
              size: { scale: 0.25 },
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const fire = Layer.get('fire');
    assert.equal(fire.hasRenderQueue, false);
    assert.equal(fire.compute.size.scale, 0.25);
    assert.equal(fire.compute.textures.length, 2);
    assert.equal(fire.compute.textures[0].name, 'u');
    assert.equal(fire.compute.textures[0].pingPong, true);
    assert.equal(fire.compute.textures[1].look, true);
    assert.equal(fire.compute.buffers[0].name, 'swirls');
    assert.equal(fire.compute.buffers[0].count, 200);
    assert.equal(fire.compute.passes[0].when, 'originShift');
    assert.deepEqual(fire.compute.passes[0].swap, ['u', 'v', 't', 'p']);
    assert.deepEqual(fire.compute.passes[1].workgroup, [64]);
    assert.equal(fire.compute.passes[1].dispatchFrom, 'swirls');
    assert.equal(fire.compute.layouts.pack[0][0].resource, 'params');
    assert.equal(fire.compute.layouts.pack[1][0].storageTexture.format, 'rgba8unorm');

    const data = Layer.getSerializableData();
    const fireId = fire.id;
    Layer.reset();
    Layer.initializeFromBuffers(data);
    const restored = Layer.get('fire');
    assert.equal(restored.id, fireId);
    assert.equal(restored.compute.size.scale, 0.25);
    assert.equal(restored.compute.textures[1].look, true);
    assert.equal(restored.compute.layouts.pack[0][0].resource, 'params');
    assert.equal(Layer._metadata.layers[fireId].hasRenderQueue, false);
  } finally {
    Layer.reset();
  }
});

test('computeTextureExtent: scale, default canvas, explicit size, min 8', () => {
  assert.deepEqual(Layer.computeTextureExtent(1920, 1080, { scale: 0.25 }), { texW: 480, texH: 270 });
  assert.deepEqual(Layer.computeTextureExtent(1920, 1080, { scale: 1 }), { texW: 1920, texH: 1080 });
  assert.deepEqual(Layer.computeTextureExtent(100, 50, null), { texW: 100, texH: 50 });
  assert.deepEqual(Layer.computeTextureExtent(10, 10, { width: 64, height: 32 }), { texW: 64, texH: 32 });
  assert.deepEqual(Layer.computeTextureExtent(1, 1, { scale: 1 }), { texW: 8, texH: 8 });
});

test('ENGINE_FRAME_PREFIX_FLOATS is 16', () => {
  assert.equal(ENGINE_FRAME_PREFIX_FLOATS, 16);
});

test('omitted pass layout stays null (source is the infer key)', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: {
            fragment: 'fireLook',
            compute: {
              source: 'fireFluid',
              passes: [{ entry: 'shift_fields' }],
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const fire = Layer.get('fire');
    assert.equal(fire.compute.passes[0].layout, null);
    assert.equal(fire.compute.passes[0].source, 'fireFluid');
    assert.equal(fire.compute.layouts, null);
  } finally {
    Layer.reset();
  }
});

const FIRE_TEX = [
  { name: 'u', format: 'r32float', pingPong: true },
  { name: 'v', format: 'r32float', pingPong: true },
  { name: 't', format: 'r32float', pingPong: true },
  { name: 'p', format: 'r32float', pingPong: true },
  { name: 'stamp', format: 'rgba8unorm' },
  { name: 'vel', format: 'rgba32float' },
  { name: 'pack', format: 'rgba8unorm', look: true },
];
const FIRE_BUF = [{ name: 'swirls', strideFloats: 8, count: 200 }];
const SHADER_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../demos/burningBoxesScene/shaders');

test('inferComputeLayout: fireStamp / fireFluid / firePack', () => {
  const ctx = { textures: FIRE_TEX, buffers: FIRE_BUF };
  // Demo WGSL no longer declares the frame binding — the engine prelude does.
  const preluded = (name) =>
    prependComputePrelude(readFileSync(join(SHADER_DIR, name), 'utf8'), null, null);
  const stamp = inferComputeLayout(preluded('fireStamp.wgsl'), ctx);
  assert.equal(stamp[0][0].resource, 'params');
  assert.equal(stamp[0][1].resource, 'bodies');
  assert.equal(stamp[0][1].buffer, 'read-only-storage');
  assert.equal(stamp[0][2].resource, 'verts');
  assert.equal(stamp[1][0].resource, 'stamp');
  assert.equal(stamp[1][0].storageTexture.format, 'rgba8unorm');
  assert.equal(stamp[1][0].ping, 'write');
  assert.equal(stamp[1][1].resource, 'vel');
  assert.equal(stamp[1][1].storageTexture.format, 'rgba32float');

  const fluid = inferComputeLayout(preluded('fireFluid.wgsl'), ctx);
  assert.equal(fluid[0][0].resource, 'params');
  assert.equal(fluid[0][1].resource, 'swirls');
  assert.equal(fluid[0][1].buffer, 'storage');
  assert.equal(fluid[0][2].resource, 'bodies');
  assert.equal(fluid[0][2].buffer, 'read-only-storage');
  assert.equal(fluid[1][0].resource, 'u');
  assert.equal(fluid[1][0].ping, 'read');
  assert.equal(fluid[1][0].texture.sampleType, 'unfilterable-float');
  assert.equal(fluid[1][4].resource, 'stamp');
  assert.equal(fluid[1][4].texture.sampleType, 'float');
  assert.equal(fluid[2][0].resource, 'u');
  assert.equal(fluid[2][0].ping, 'write');
  assert.equal(fluid[2][0].storageTexture.format, 'r32float');

  const pack = inferComputeLayout(preluded('firePack.wgsl'), ctx);
  assert.equal(pack[0][0].resource, 'params');
  assert.equal(pack[1][0].resource, 't');
  assert.equal(pack[1][1].resource, 'stamp');
  assert.equal(pack[2][0].resource, 'pack');
  assert.equal(pack[2][0].storageTexture.format, 'rgba8unorm');
});

test('inferComputeLayout: heatWrite without heat texture throws', () => {
  const wgsl = `@group(2) @binding(0) var heatWrite: texture_storage_2d<rgba8unorm, write>;`;
  assert.throws(
    () => inferComputeLayout(wgsl, { textures: FIRE_TEX, buffers: FIRE_BUF }),
    /WeedJS: unknown compute resource "heatWrite"/
  );
});

test('inferComputeLayout: frame and shapes aliases', () => {
  const wgsl = `
    @group(0) @binding(0) var<uniform> frame: FrameData;
    @group(0) @binding(1) var<storage, read> shapes: array<Body>;
  `;
  const groups = inferComputeLayout(wgsl, { textures: [], buffers: [] });
  assert.equal(groups[0][0].resource, 'params');
  assert.equal(groups[0][1].resource, 'bodies');
});

test('computePassActive: originShift skips zoom/still; zoomChanged only on zoom', () => {
  assert.equal(computePassActive('originShift', false, false), true);
  assert.equal(computePassActive('originShift', true, false), false);
  assert.equal(computePassActive('originShift', false, true), false);
  assert.equal(computePassActive('zoomChanged', true, false), true);
  assert.equal(computePassActive('zoomChanged', false, false), false);
  assert.equal(computePassActive('zoomChanged', true, true), true);
  assert.equal(computePassActive(null, true, true), true);
});

test('latticeLookUv: snapped origin, non-square canvas, view center in 0-1', () => {
  const centered = latticeLookUv(0, 0, 800, 400, 200, 100, 800, 1, 0.5, 0.5);
  assert.equal(centered.u, 0.5);
  assert.equal(centered.v, 0.5);

  const snapped = latticeLookUv(101, 53, 800, 400, 200, 100, 800, 1, 0.5, 0.5);
  assert.ok(snapped.u > 0 && snapped.u < 1);
  assert.ok(snapped.v > 0 && snapped.v < 1);
  const h = 800 / 200;
  const originX = Math.floor(101 / h) * h;
  assert.ok(Math.abs(snapped.u - (0.5 + (101 - originX) / 800)) < 1e-12);
});

test('layerN: kindling negative scroll + +uTime*scroll moves uv.y toward screen up', () => {
  // Matches fireLook layerN. Y-down lattice: smaller uv.y is screen up.
  const offsetY = (time, scroll) => time * scroll;
  assert.ok(offsetY(1, -0.35) < 0);
  assert.ok(offsetY(1, 0.35) > 0);
});
