import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Query } from '../../src/core/query.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { standaloneBlock } from '../../src/util/box2dEngineBlock.js';
import { createSceneSharedBuffers, renderQueueMemorySpec } from '../../src/util/sceneSharedBuffers.js';
import { quietly } from '../bench/workerHarness.mjs';

// Close-out group B: without physics the engine block is a shared memory of its own, laid out as Box2D's block is
// (the render-queue part, then the spatial part), so the bullet tick, which reads the pool, Transform, Collider and
// the spatial grid in one memory, runs in WASM in a scene without physics too.

class Prop extends GameObject {}
Prop.components = [Collider, SpriteRenderer];

function scene(over = {}) {
  Query.reset();
  return {
    _physicsEnabled: false,
    totalEntityCount: 64,
    nextComponentId: 3,
    registeredClasses: [{ class: Prop, count: 64, startIndex: 0, entityType: 0, components: Prop.components }],
    componentPools: {
      Transform: { ComponentClass: Transform },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    },
    config: {
      worldWidth: 4096,
      worldHeight: 4096,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 3000, maxImpactsPerFrame: 64 },
      physics: { enabled: false, maxJoints: 0 },
      spatial: { cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 32, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 256, ySort: false },
      preRender: { packGpuSprites: 'preRender', sortSprites: 'preRender' },
      layers: {},
      wasm: { ...WASM_DEFAULTS, ...(over.wasm || {}) },
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
    preInitializeEntityTypeArrays() {},
    constructor: { queries: [] },
  };
}

test('without physics the spec lays the bullet tick in the engine block', () => {
  const b = renderQueueMemorySpec(scene()).collect?.bullets;
  assert.ok(b, 'the bullet tick regions, no physics');
  assert.equal(b.bullets, 3000);
  assert.equal(renderQueueMemorySpec(scene({ wasm: { box2dBlock: false } })).collect?.bullets ?? null, null, 'no block, no tick');
});

test('without physics the engine block is a memory of its own, with the render-queue and spatial parts in it', async () => {
  const s = scene();
  s.box2dBlock = standaloneBlock(s);
  assert.ok(s.box2dBlock, 'a standalone block');
  assert.equal(s.box2dBlock.standalone, true);
  assert.ok(s.box2dBlock.byte > 0, 'past a null guard');
  assert.ok(s.box2dBlock.queueBytes > 0 && s.box2dBlock.spatialBytes > 0, 'both parts');
  await quietly(() => createSceneSharedBuffers(s));
  const memory = s.box2dBlock.memory;
  assert.equal(s.renderQueueMemory?.memory, memory, 'the render-queue regions are in the block');
  assert.equal(s.spatialPublish?.memory, memory, 'the spatial regions are in the block');
  const c = s.renderQueueMemory.layout.collect;
  assert.ok(c && c.bullets, 'the collect with the bullet tick regions');
  assert.ok(c.transformByte >= s.box2dBlock.byte && c.colliderByte >= s.box2dBlock.byte, 'Transform and Collider in it');
  assert.equal(c.rigidBodyByte ?? -1, -1, 'no bodies without physics');
  assert.ok(s.spatialPublish.gridByte >= s.box2dBlock.spatialByte, 'the grid in the spatial part');
  assert.equal(standaloneBlock({ ...scene(), _physicsEnabled: true }), null, 'with physics the block is Box2D\'s');
});
