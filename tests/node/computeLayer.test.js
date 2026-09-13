import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer, reservedLookUniformFloatCount } from '../../src/core/Layer.js';
import { Collider } from '../../src/components/Collider.js';
import { Transform } from '../../src/components/Transform.js';
import { RigidBody } from '../../src/components/RigidBody.js';
import { feedLayerAt, clearFeedLayerAt } from '../../src/core/computeFeed.js';
import { packBox2dBodies, BODY_FLOATS } from '../../src/workers/Box2dBodyPack.js';
import { inferComputeLayout, resolveComputeLayout, DEFAULT_SIMPLE_LAYOUT } from '../../src/workers/inferComputeLayout.js';
import { prependComputePrelude, buildComputePrelude } from '../../src/workers/wgslPrelude.js';
import {
  ENGINE_FRAME_PREFIX_FLOATS,
  computePassActive,
  allComputePassesIdle,
  computeLayerPacksBodies,
  ComputeLayer,
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
  COMPUTE_FLAG_SWEEP,
  COMPUTE_LAYER_DEFAULT_MAX_PARTICLES,
} from '../../src/core/ConfigDefaults.js';
import { LiquidFun } from '../../src/core/LiquidFun.js';
import { liquidFunRenderByteSize } from '../../src/core/liquidFunRender.js';
import { packLiquidFunParticles, PARTICLE_FLOATS } from '../../src/workers/LiquidFunParticlePack.js';

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
    assert.equal(fire.compute.maxParticles, 0);
    assert.equal(fire.compute.size.scale, 1);
    assert.equal(Layer._metadata.layers[fire.id].hasRenderQueue, false);
    assert.equal(Layer._metadata.layers[fire.id].maxBodies, 512);
    assert.equal(Layer._metadata.layers[fire.id].maxParticles, 0);
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
  RigidBody.px = new Float32Array(n);
  RigidBody.py = new Float32Array(n);

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
    RigidBody.px[0] = 80;
    RigidBody.py[0] = 40;
    feedLayerAt(0, id);

    const bodies = new Float32Array(8 * BODY_FLOATS);
    const verts = new Float32Array(64);
    const packed = packBox2dBodies(id, bodies, verts, 8, { sweep: false });
    assert.equal(packed.bodyCount, 1);
    assert.equal(packed.vertCount, 3);
    assert.equal(bodies[6], ShapeType.Polygon);
    assert.equal(bodies[11], 0);
    assert.equal(bodies[12], 3);
    assert.equal(bodies[13], 80);
    assert.equal(bodies[14], 40);
    assert.equal((bodies[7] | 0) & COMPUTE_FLAG_STATIC, COMPUTE_FLAG_STATIC);
    assert.equal(verts[0], -10);
    assert.equal(verts[5], 12);
  } finally {
    Layer.reset();
  }
});

test('packBox2dBodies uses latched pose not live Transform', () => {
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
  RigidBody.px = new Float32Array(n);
  RigidBody.py = new Float32Array(n);
  const poseX = new Float32Array(n);
  const poseY = new Float32Array(n);
  const poseRotC = new Float32Array(n);
  const poseRotS = new Float32Array(n);
  const prevPoseX = new Float32Array(n);
  const prevPoseY = new Float32Array(n);
  const prevPoseRotC = new Float32Array(n);
  const prevPoseRotS = new Float32Array(n);

  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: { fragment: 'f', compute: 's', maxBodies: 16 },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('fire').id;
    Collider.active[0] = 1;
    Collider.shapeType[0] = ShapeType.Box;
    Collider.width[0] = 40;
    Collider.height[0] = 40;
    Transform.x[0] = 100;
    Transform.y[0] = 50;
    Transform.rotC[0] = 1;
    Transform.rotS[0] = 0;
    RigidBody.active[0] = 1;
    RigidBody.static[0] = 0;
    RigidBody.px[0] = 999;
    RigidBody.py[0] = 888;
    poseX[0] = 200;
    poseY[0] = 80;
    poseRotC[0] = 1;
    poseRotS[0] = 0;
    feedLayerAt(0, id);

    const bodies = new Float32Array(16 * BODY_FLOATS);
    const verts = new Float32Array(64);
    const poseOpts = {
      sweep: false,
      poseX,
      poseY,
      poseRotC,
      poseRotS,
      prevPoseX,
      prevPoseY,
      prevPoseRotC,
      prevPoseRotS,
    };

    let packed = packBox2dBodies(id, bodies, verts, 16, poseOpts);
    assert.equal(packed.bodyCount, 1);
    assert.equal(bodies[0], 200);
    assert.equal(bodies[1], 80);

    RigidBody.active[0] = 0;
    bodies.fill(0);
    packed = packBox2dBodies(id, bodies, verts, 16, poseOpts);
    assert.equal(packed.bodyCount, 1);
    assert.equal(bodies[0], 100);
    assert.equal(bodies[1], 50);

    RigidBody.active[0] = 1;
    poseX[0] = 80;
    poseY[0] = 80;
    prevPoseX[0] = 0;
    prevPoseY[0] = 80;
    prevPoseRotC[0] = 1;
    prevPoseRotS[0] = 0;
    poseOpts.sweep = true;
    bodies.fill(0);
    packed = packBox2dBodies(id, bodies, verts, 16, poseOpts);
    assert.ok(packed.bodyCount > 1, 'sweep emits extra samples');
    assert.equal(bodies[0], 80);
    assert.equal(bodies[1], 80);
    assert.equal(bodies[13], 0);
    assert.equal(bodies[14], 80);
    assert.equal(bodies[BODY_FLOATS], 0);
    assert.equal(bodies[BODY_FLOATS + 1], 80);
    assert.equal((bodies[BODY_FLOATS + 7] | 0) & COMPUTE_FLAG_SWEEP, COMPUTE_FLAG_SWEEP);
    for (let b = 0; b < packed.bodyCount; b++) {
      const x = bodies[b * BODY_FLOATS];
      const y = bodies[b * BODY_FLOATS + 1];
      assert.notEqual(x, 999);
      assert.notEqual(y, 888);
    }
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
  const out = { texW: 0, texH: 0 };
  assert.equal(Layer.computeTextureExtent(10, 10, { width: 64, height: 32 }, out), out);
  assert.deepEqual(out, { texW: 64, texH: 32 });
});

test('viewport RT resize: compute look has rtOut only; uTexture stays lookSource', () => {
  const lookSource = { id: 'pack' };
  const densitySource = { id: 'density' };
  const computeCl = { compute: {}, lookSource, rt: null, rtOut: { id: 'lookOut' } };
  const densityCl = { rt: { source: densitySource }, rtOut: { id: 'lookOut' } };
  assert.equal(Layer.customLayerNeedsViewportResize(computeCl), true);
  assert.equal(Layer.customLayerNeedsViewportResize({ rt: null, rtOut: null }), false);
  assert.equal(Layer.customLayerLookTexture(computeCl), lookSource);
  assert.equal(Layer.customLayerLookTexture(densityCl), densitySource);
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
  { name: 'fuel', format: 'rgba32float' },
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
  assert.equal(stamp[1][2].resource, 'fuel');
  assert.equal(stamp[1][2].storageTexture.format, 'rgba32float');

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
  assert.equal(fluid[1][6].resource, 'fuel');
  assert.equal(fluid[1][6].texture.sampleType, 'unfilterable-float');
  assert.equal(fluid[2][0].resource, 'u');
  assert.equal(fluid[2][0].ping, 'write');
  assert.equal(fluid[2][0].storageTexture.format, 'r32float');

  const pack = inferComputeLayout(preluded('firePack.wgsl'), ctx);
  assert.equal(pack[0][0].resource, 'params');
  assert.equal(pack[1][0].resource, 't');
  assert.equal(pack[1][1].resource, 'stamp');
  assert.equal(pack[2][0].resource, 'pack');
  assert.equal(pack[2][0].storageTexture.format, 'rgba8unorm');

  const particles = inferComputeLayout(preluded('fireParticles.wgsl'), ctx);
  assert.equal(particles[0][0].resource, 'params');
  assert.equal(particles[0][1].resource, 'particles');
  assert.equal(particles[0][1].buffer, 'read-only-storage');
  assert.equal(particles[1][0].resource, 'fuel');
  assert.equal(particles[1][0].ping, 'write');
});

test('inferComputeLayout: heatWrite without heat texture throws', () => {
  const wgsl = `@group(2) @binding(0) var heatWrite: texture_storage_2d<rgba8unorm, write>;`;
  assert.throws(
    () => inferComputeLayout(wgsl, { textures: FIRE_TEX, buffers: FIRE_BUF }),
    /WeedJS: unknown compute resource "heatWrite"/
  );
});

test('inferComputeLayout: particles alias', () => {
  const wgsl = `
    @group(0) @binding(0) var<uniform> frame: FrameData;
    @group(0) @binding(1) var<storage, read> particles: array<LfParticle>;
  `;
  const groups = inferComputeLayout(wgsl, { textures: [], buffers: [] });
  assert.equal(groups[0][0].resource, 'params');
  assert.equal(groups[0][1].resource, 'particles');
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

test('computePassActive: originShift skips still cam; zoomChanged only on zoom', () => {
  assert.equal(computePassActive('originShift', false, false), true);
  assert.equal(computePassActive('originShift', true, false), true);
  assert.equal(computePassActive('originShift', false, true), false);
  assert.equal(computePassActive('originShift', true, true), false);
  assert.equal(computePassActive('zoomChanged', true, false), true);
  assert.equal(computePassActive('zoomChanged', false, false), false);
  assert.equal(computePassActive('zoomChanged', true, true), true);
  assert.equal(computePassActive(null, true, true), true);
});

test('fireLook: sample then discard outside 0-1; fluid uses scene uCellSize', () => {
  const look = readFileSync(join(SHADER_DIR, 'fireLook.wgsl'), 'utf8');
  const sampleAt = look.indexOf('textureSample(uTexture, uSampler');
  const discardAt = look.indexOf('uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0');
  assert.ok(sampleAt >= 0);
  assert.ok(discardAt > sampleAt);
  assert.match(look, /uCellSize/);
  const fluid = readFileSync(join(SHADER_DIR, 'fireFluid.wgsl'), 'utf8');
  assert.match(fluid, /max\(frame\.uCellSize/);
  assert.equal(/canvasW \/ max\(frame\.texW/.test(fluid), false);
});

test('world-fixed lattice: no camera-relative origin/shift, cell_active gates the fluid+stamp sim', () => {
  const fluid = readFileSync(join(SHADER_DIR, 'fireFluid.wgsl'), 'utf8');
  const stamp = readFileSync(join(SHADER_DIR, 'fireStamp.wgsl'), 'utf8');
  const look = readFileSync(join(SHADER_DIR, 'fireLook.wgsl'), 'utf8');
  const particles = readFileSync(join(SHADER_DIR, 'fireParticles.wgsl'), 'utf8');
  for (const src of [fluid, stamp, look, particles]) {
    assert.equal(/lattice_origin|lattice_shift/.test(src), false);
  }
  assert.match(particles, /fn cell_active\(id: vec2<i32>\)/);
  assert.equal(/fn shift_swirls/.test(fluid), false);
  assert.match(fluid, /fn cell_active\(id: vec2<i32>\)/);
  assert.match(stamp, /fn cell_active\(id: vec2<i32>\)/);
  // Every fluid pass that swaps a texture must gate on cell_active, since
  // inactive cells must stay zeroed (empty), not stale/undefined.
  for (const entry of ['cool_rise', 'apply_swirls', 'apply_stamp', 'apply_body_vel', 'push_from_solid', 'diffuse_temperature', 'jacobi_pressure', 'project_velocity', 'advect_velocity', 'advect_temperature']) {
    const fnStart = fluid.indexOf(`fn ${entry}(`);
    assert.ok(fnStart >= 0, `${entry} should exist`);
    const nextFn = fluid.indexOf('\n@compute', fnStart + 1);
    const body = fluid.slice(fnStart, nextFn === -1 ? undefined : nextFn);
    assert.match(body, /cell_active\(id\)/, `${entry} should gate on cell_active`);
  }
});

test('fire stamp: burning crust is live fluid; inert solids push; ember overlays in look', () => {
  const stamp = readFileSync(join(SHADER_DIR, 'fireStamp.wgsl'), 'utf8');
  const fluid = readFileSync(join(SHADER_DIR, 'fireFluid.wgsl'), 'utf8');
  const pack = readFileSync(join(SHADER_DIR, 'firePack.wgsl'), 'utf8');
  const look = readFileSync(join(SHADER_DIR, 'fireLook.wgsl'), 'utf8');
  assert.match(stamp, /!isBurning \|\| d <= -inner/);
  assert.match(stamp, /uStampInner/);
  assert.match(stamp, /uStampOuter/);
  assert.match(stamp, /burnSolid/);
  assert.match(stamp, /uEmberPad/);
  assert.match(stamp, /isBlow/);
  assert.match(stamp, /isJet/);
  assert.match(stamp, /fuelWrite/);
  assert.match(fluid, /fuel\.r > 0\.5/);
  assert.match(fluid, /uLfDrive/);
  assert.match(fluid, /fn inert_solid/);
  assert.match(fluid, /fn push_from_solid/);
  assert.match(stamp, /s\.velX/);
  assert.match(stamp, /velKind = 2\.0/);
  const applyStart = fluid.indexOf('fn apply_body_vel(');
  const applyNext = fluid.indexOf('\n@compute', applyStart + 1);
  const applyBody = fluid.slice(applyStart, applyNext === -1 ? undefined : applyNext);
  assert.match(applyBody, /velL/);
  assert.match(applyBody, /velT/);
  assert.equal(/velR/.test(applyBody), false);
  assert.equal(/velU/.test(applyBody), false);

  const inertSolid = (open, burnA, hasBody) => open < 0.5 && burnA < 0.5 && hasBody < 0.5;
  assert.equal(inertSolid(0, 0, 0), true);
  assert.equal(inertSolid(0, 1, 0), false);
  assert.equal(inertSolid(1, 0, 0), false);
  assert.equal(inertSolid(0, 0, 1), false, 'flying crate is not an inert floor');
  assert.match(pack, /let ember = clamp\(mark\.b/);
  assert.match(look, /let ember = heat\.a/);
  assert.match(look, /eRgb \* eA \+ premul/);

  const pushNormal = (l, r, d, u) => {
    let nx = 0;
    let ny = 0;
    if (l) nx += 1;
    if (r) nx -= 1;
    if (d) ny += 1;
    if (u) ny -= 1;
    const len = Math.hypot(nx, ny);
    if (len <= 1e-4) return { nx: 0, ny: 0 };
    return { nx: nx / len, ny: ny / len };
  };
  const one = pushNormal(true, false, false, false);
  assert.ok(Math.abs(one.nx - 1) < 1e-9 && Math.abs(one.ny) < 1e-9);
  const burnNeighbor = pushNormal(false, false, false, false);
  assert.equal(burnNeighbor.nx, 0);
  assert.equal(burnNeighbor.ny, 0);

  const overA = (dstA, srcA) => srcA + dstA * (1 - srcA);
  assert.ok(overA(0.5, 0.8) > 0.5);

  const closed = (d, skin, burning, inner) => {
    if (d > skin) return false;
    if (!burning) return true;
    return d <= -inner;
  };
  assert.equal(closed(0, 0, true, 0), true);
  assert.equal(closed(-10, 0, true, 64), false);
  assert.equal(closed(-10, 0, false, 64), true);

  // MAC left face of an air cell is the right wall of a solid on the left.
  const sharedFaceU = (closedSelf, bodySelf, closedLeft, bodyLeft, vx, airU) => {
    if (closedSelf && bodySelf) return vx;
    if (!closedSelf && closedLeft && bodyLeft) return vx;
    return airU;
  };
  assert.equal(sharedFaceU(false, false, true, true, 400, 0), 400);
  assert.equal(sharedFaceU(true, true, false, false, 400, 0), 400);
  assert.equal(sharedFaceU(false, false, false, false, 400, 0), 0);
});

test("burningBoxesScene: fire layer sizes compute.size from world dims via FIRE_CELL_SIZE (demo math, not an engine mode)", () => {
  try {
    Layer.reset();
    const cellSize = 4;
    const worldWidth = 4000;
    const worldHeight = 3000;
    Layer.initializeFromConfig(
      {
        fire: {
          shader: {
            fragment: 'fireLook',
            compute: {
              source: 'fireFluid',
              size: {
                width: Math.ceil(worldWidth / cellSize),
                height: Math.ceil(worldHeight / cellSize),
              },
              passes: [{ entry: 'main' }],
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const fire = Layer.get('fire');
    assert.equal(fire.compute.size.width, 1000);
    assert.equal(fire.compute.size.height, 750);
    const ext = Layer.computeTextureExtent(800, 600, fire.compute.size);
    assert.equal(ext.texW, 1000);
    assert.equal(ext.texH, 750);
  } finally {
    Layer.reset();
  }
});

test('layerN: kindling negative scroll + +uTime*scroll moves uv.y toward screen up', () => {
  // Matches fireLook layerN. Y-down lattice: smaller uv.y is screen up.
  const offsetY = (time, scroll) => time * scroll;
  assert.ok(offsetY(1, -0.35) < 0);
  assert.ok(offsetY(1, 0.35) > 0);
});

test('compute layer: source liquidFun defaults maxParticles to 4096', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: {
            fragment: 'fireLook',
            compute: { source: 'fireFluid', passes: [{ entry: 'main' }] },
            source: LAYER_COMPUTE_SOURCE.LIQUID_FUN,
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const fire = Layer.get('fire');
    assert.equal(fire.computeSource, LAYER_COMPUTE_SOURCE.LIQUID_FUN);
    assert.equal(fire.compute.maxParticles, COMPUTE_LAYER_DEFAULT_MAX_PARTICLES);
    assert.equal(Layer._metadata.layers[fire.id].maxParticles, COMPUTE_LAYER_DEFAULT_MAX_PARTICLES);
  } finally {
    Layer.reset();
  }
});

test('compute layer: dispatchFrom particles round-trips', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: {
            fragment: 'fireLook',
            compute: {
              source: 'fireFluid',
              passes: [
                { entry: 'raster_particles', source: 'fireParticles', workgroup: [64], dispatchFrom: 'particles' },
              ],
            },
            maxParticles: 4096,
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const fire = Layer.get('fire');
    assert.equal(fire.compute.maxParticles, 4096);
    assert.equal(fire.compute.passes[0].dispatchFrom, 'particles');
    assert.deepEqual(fire.compute.passes[0].workgroup, [64]);
  } finally {
    Layer.reset();
  }
});

function makeLfHeap(n) {
  const floatsStart = 16;
  const sab = new SharedArrayBuffer(floatsStart + n * 5 * 4);
  return {
    sab,
    n,
    countByteOffset: 0,
    xByteOffset: floatsStart,
    yByteOffset: floatsStart + n * 4,
    vxByteOffset: floatsStart + n * 8,
    vyByteOffset: floatsStart + n * 12,
    alphaByteOffset: floatsStart + n * 16,
  };
}

test('packLiquidFunParticles: HEAP x/y/vx/vy into SSBO', () => {
  const n = 4;
  const heap = makeLfHeap(n);
  try {
    LiquidFun.unbindSabs();
    LiquidFun.bindHeapPose({
      sab: heap.sab,
      maxCount: n,
      countByteOffset: heap.countByteOffset,
      xByteOffset: heap.xByteOffset,
      yByteOffset: heap.yByteOffset,
      vxByteOffset: heap.vxByteOffset,
      vyByteOffset: heap.vyByteOffset,
      alphaByteOffset: heap.alphaByteOffset,
    });
    const views = LiquidFun.getViews();
    views.count[0] = 2;
    views.x[0] = 10;
    views.y[0] = 20;
    views.vx[0] = 3;
    views.vy[0] = 4;
    views.x[1] = 50;
    views.y[1] = 60;
    views.vx[1] = -1;
    views.vy[1] = 8;
    const out = new Float32Array(8 * PARTICLE_FLOATS);
    const packed = packLiquidFunParticles(1, out, 8);
    assert.equal(packed.particleCount, 2);
    assert.equal(out[0], 10);
    assert.equal(out[1], 20);
    assert.equal(out[2], 3);
    assert.equal(out[3], 4);
    assert.equal(out[4], 50);
    assert.equal(out[5], 60);
    assert.equal(out[6], -1);
    assert.equal(out[7], 8);
  } finally {
    LiquidFun.unbindSabs();
  }
});

test('packLiquidFunParticles: layerId 0 or this compute layer; cap overflow', () => {
  const n = 4;
  const heap = makeLfHeap(n);
  const render = new SharedArrayBuffer(liquidFunRenderByteSize(n));
  try {
    LiquidFun.unbindSabs();
    LiquidFun.bindSabs({ render, maxCount: n });
    LiquidFun.bindHeapPose({
      sab: heap.sab,
      maxCount: n,
      countByteOffset: heap.countByteOffset,
      xByteOffset: heap.xByteOffset,
      yByteOffset: heap.yByteOffset,
      vxByteOffset: heap.vxByteOffset,
      vyByteOffset: heap.vyByteOffset,
      alphaByteOffset: heap.alphaByteOffset,
    });
    const views = LiquidFun.getViews();
    views.count[0] = 3;
    views.x[0] = 1;
    views.y[0] = 2;
    views.vx[0] = 0;
    views.vy[0] = 0;
    views.x[1] = 3;
    views.y[1] = 4;
    views.x[2] = 5;
    views.y[2] = 6;
    views.layerId[0] = 0;
    views.layerId[1] = 9;
    views.layerId[2] = 3;
    const out = new Float32Array(8 * PARTICLE_FLOATS);
    const packed = packLiquidFunParticles(3, out, 8);
    assert.equal(packed.particleCount, 2);
    assert.equal(out[0], 1);
    assert.equal(out[4], 5);
    const capped = packLiquidFunParticles(3, out, 1);
    assert.equal(capped.particleCount, 1);
    assert.equal(packLiquidFunParticles(3, out, 0).particleCount, 0);
  } finally {
    LiquidFun.unbindSabs();
  }
});

test('burningBoxesScene: landscape bg + particle fuel pass', () => {
  const scene = readFileSync(
    join(SHADER_DIR, '../burningBoxesScene.js'),
    'utf8'
  );
  assert.match(scene, /setBackground\(\{ texture: 'landscape'/);
  assert.match(scene, /zoomParallax: 0\.35/);
  assert.match(scene, /background_lanscape\.jpg/);
  assert.match(scene, /dispatchFrom: 'particles'/);
  assert.match(scene, /maxParticles: FIRE_LF_MAX/);
});

test('resolveComputeLayout: empty WGSL gets simple params+bodies+verts+out', () => {
  const groups = resolveComputeLayout('fn x() {}', { textures: [], buffers: [] });
  assert.deepEqual(groups, DEFAULT_SIMPLE_LAYOUT);
  assert.equal(groups[0][0].resource, 'params');
  assert.equal(groups[0][1].resource, 'bodies');
  assert.equal(groups[0][2].resource, 'verts');
  assert.equal(groups[1][0].resource, 'out');
});

test('resolveComputeLayout: fireStamp raw merges prelude params', () => {
  const ctx = { textures: FIRE_TEX, buffers: FIRE_BUF };
  const raw = readFileSync(join(SHADER_DIR, 'fireStamp.wgsl'), 'utf8');
  const groups = resolveComputeLayout(raw, ctx);
  assert.equal(groups[0][0].resource, 'params');
  assert.equal(groups[0][1].resource, 'bodies');
  assert.equal(groups[0][2].resource, 'verts');
  assert.equal(groups[1][0].resource, 'stamp');
  const preluded = inferComputeLayout(prependComputePrelude(raw, null, null), ctx);
  assert.equal(groups[0][0].resource, preluded[0][0].resource);
  assert.equal(groups[1][0].resource, preluded[1][0].resource);
});

test('feedLayerAt/clearFeedLayerAt interleaved stays dense and bijective', () => {
  const count = 8;
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(count)), count);
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      { sim: { shader: { fragment: 'f', compute: 's', maxBodies: 8 } } },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('sim').id;
    for (let i = 0; i < 4; i++) Collider.active[i] = 1;
    assert.equal(feedLayerAt(0, id), true);
    assert.equal(feedLayerAt(1, id), true);
    assert.equal(clearFeedLayerAt(0) || true, true);
    assert.equal(feedLayerAt(2, id), true);
    assert.equal(feedLayerAt(3, id), true);
    assert.equal(clearFeedLayerAt(1) || true, true);
    assert.equal(feedLayerAt(0, id), true);
    const n = Atomics.load(Layer._feedCount, id);
    const seen = new Set();
    for (let s = 0; s < n; s++) {
      const idx = Layer._feedIndices[id][s];
      assert.equal(Collider.feedLayerId[idx], id);
      assert.equal(Collider.feedSlot[idx], s);
      assert.equal(seen.has(idx), false);
      seen.add(idx);
    }
    assert.equal(seen.size, n);
    assert.equal(n, 3);
  } finally {
    Layer.reset();
  }
});

test('ComputeLayer.destroy then resize throws WeedJS error', () => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 };
  globalThis.GPUTextureUsage = {
    TEXTURE_BINDING: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    STORAGE_BINDING: 8,
  };
  globalThis.GPUShaderStage = { COMPUTE: 1 };
  const mkBuf = () => ({ destroy() {} });
  const mkTex = () => ({ destroy() {}, createView() { return {}; } });
  const device = {
    createBuffer: () => mkBuf(),
    createTexture: () => mkTex(),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => ({}),
    createBindGroup: () => ({}),
    queue: { writeBuffer() {}, submit() {} },
  };
  const cl = new ComputeLayer({
    device,
    meta: {
      id: 0,
      name: 'sim',
      compute: { passes: [], textures: [], size: { width: 16, height: 16 } },
    },
    renderer: {},
    lookSource: {},
  });
  cl.resize(16, 16);
  cl.destroy();
  assert.throws(() => cl.resize(32, 32), /WeedJS: ComputeLayer used after destroy/);
});

test('compute FrameData is prefix + scene uniforms, not reserved look slots', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: {
            fragment: 'f',
            compute: 's',
            uniforms: {
              uRise: { value: -1, type: 'f32' },
              uCellSize: { value: 8, type: 'f32' },
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const fire = Layer.get('fire');
    const map = Layer._uniformMaps[fire.id];
    assert.equal(reservedLookUniformFloatCount(), 14);
    assert.equal(map.uTime.offset, 0);
    assert.equal(map.uRise.offset, 14);
    assert.equal(map.uCellSize.offset, 15);
    const prelude = buildComputePrelude(map, Layer._metadata.layers[fire.id].uniformTypes);
    assert.match(prelude, /uRise: f32/);
    assert.match(prelude, /uCellSize: f32/);
    assert.equal(/^\s+uTime:/m.test(prelude), false);
    assert.match(prelude, /time: f32/);
  } finally {
    Layer.reset();
  }
});

test('computeLayerPacksBodies false for LIQUID_FUN', () => {
  assert.equal(computeLayerPacksBodies(LAYER_COMPUTE_SOURCE.LIQUID_FUN), false);
  assert.equal(computeLayerPacksBodies(LAYER_COMPUTE_SOURCE.BOX2D_BODIES), true);
});

test('allComputePassesIdle true only when every pass is gated off', () => {
  const origin = [{ when: 'originShift' }, { when: 'originShift' }];
  assert.equal(allComputePassesIdle(origin, false, true), true);
  assert.equal(allComputePassesIdle(origin, false, false), false);
  assert.equal(allComputePassesIdle([{ when: null }], false, true), false);
});

test('pass dispatch workgroup counts round-trip', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        sim: {
          shader: {
            fragment: 'look',
            compute: {
              source: 'sim',
              passes: [{ entry: 'main', dispatch: { x: 4, y: 2 } }],
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const sim = Layer.get('sim');
    assert.deepEqual(sim.compute.passes[0].dispatch, { x: 4, y: 2 });
  } finally {
    Layer.reset();
  }
});

test('ComputeLayer.writeBuffer body size is TypedArray elements', () => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 };
  globalThis.GPUTextureUsage = {
    TEXTURE_BINDING: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    STORAGE_BINDING: 8,
  };
  globalThis.GPUShaderStage = { COMPUTE: 1 };
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
  RigidBody.px = new Float32Array(n);
  RigidBody.py = new Float32Array(n);
  const writes = [];
  const mkBuf = () => ({ destroy() {} });
  const mkTex = () => ({ destroy() {}, createView() { return {}; } });
  const device = {
    createBuffer: () => mkBuf(),
    createTexture: () => mkTex(),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      copyTextureToTexture() {},
      finish() { return {}; },
      beginComputePass() {
        return { end() {}, setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {} };
      },
    }),
    queue: {
      writeBuffer(_buf, _off, data, _dataOff, size) {
        if (size != null) writes.push({ length: data.length, size });
      },
      submit() {},
    },
  };
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      { sim: { shader: { fragment: 'f', compute: 's', maxBodies: 8 } } },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('sim').id;
    Collider.active[0] = 1;
    Collider.active[1] = 1;
    Collider.shapeType[0] = ShapeType.Box;
    Collider.shapeType[1] = ShapeType.Box;
    Collider.width[0] = 16;
    Collider.height[0] = 16;
    Collider.width[1] = 16;
    Collider.height[1] = 16;
    Transform.rotC[0] = 1;
    Transform.rotC[1] = 1;
    feedLayerAt(0, id);
    feedLayerAt(1, id);
    const cl = new ComputeLayer({
      device,
      meta: {
        id,
        name: 'sim',
        maxBodies: 8,
        computeSource: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
        compute: { passes: [], textures: [], size: { width: 16, height: 16 } },
      },
      renderer: {},
      lookSource: null,
    });
    cl._ready = true;
    cl.step(
      {
        dt: 0.016,
        cameraX: 0,
        cameraY: 0,
        canvasW: 16,
        canvasH: 16,
        zoom: 1,
        time: 0,
        worldW: 16,
        worldH: 16,
      },
      null
    );
    const bodyWrite = writes.find((w) => w.size === 2 * BODY_FLOATS);
    assert.ok(bodyWrite, `expected body write of ${2 * BODY_FLOATS} floats, got ${JSON.stringify(writes)}`);
    assert.ok(bodyWrite.size <= bodyWrite.length);
    assert.equal(writes.some((w) => w.size === 2 * BODY_FLOATS * 4), false);
  } finally {
    Layer.reset();
  }
});

