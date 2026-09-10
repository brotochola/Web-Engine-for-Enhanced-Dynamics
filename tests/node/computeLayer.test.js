import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/Layer.js';
import { Collider } from '../../src/components/Collider.js';
import { Transform } from '../../src/components/Transform.js';
import { RigidBody } from '../../src/components/RigidBody.js';
import { feedLayerAt, clearFeedLayerAt } from '../../src/core/computeFeed.js';
import { packBox2dBodies, BODY_FLOATS } from '../../src/workers/Box2dBodyPack.js';
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
            grid: { cellSize: 8 },
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
    assert.equal(fire.compute.grid.cellSize, 8);
    assert.equal(Layer._metadata.layers[fire.id].hasRenderQueue, false);
    assert.equal(Layer._metadata.layers[fire.id].maxBodies, 512);
    assert.equal(Layer._feedMax[fire.id], 512);
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
