import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Query } from '../../src/core/query.js';
import { GameObject } from '../../src/core/gameObject.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';

// E-76 T7: one switch per WASM module. wasm.spatialPublish false must give the scene the plain-SAB
// JavaScript publish path (what 32-bit ids get), default true the publish memory.

class Entity extends GameObject {}
Entity.components = [RigidBody, Collider, SpriteRenderer];

function buildScene(wasm) {
  const previousLog = console.log;
  console.log = () => {};
  try {
    Query.reset();
    const scene = {
      totalEntityCount: 1000,
      nextComponentId: 4,
      registeredClasses: [{ class: Entity, count: 1000, startIndex: 0, entityType: 0, components: Entity.components }],
      componentPools: {
        Transform: { ComponentClass: Transform },
        RigidBody: { ComponentClass: RigidBody },
        Collider: { ComponentClass: Collider },
        SpriteRenderer: { ComponentClass: SpriteRenderer },
      },
      config: {
        worldWidth: 2000,
        worldHeight: 1000,
        canvasWidth: 800,
        canvasHeight: 600,
        particle: { maxParticles: 0 },
        decoration: { maxDecorations: 0 },
        bullet: { maxBullets: 0 },
        physics: { maxJoints: 0 },
        spatial: { cellSize: 100, maxNeighbors: 32, maxEntitiesPerCell: 64, rowsPerBlock: 2, numberOfSpatialWorkers: 2 },
        lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
        logic: { staggeredUpdates: false },
        debug: { maxDebugDrawEntries: 1 },
        navigation: { enabled: false },
        renderer: { maxVisibleRenderables: 100 },
        layers: {},
        wasm: { ...WASM_DEFAULTS, ...wasm },
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
    createSceneSharedBuffers(scene);
    return scene;
  } finally {
    console.log = previousLog;
  }
}

test('wasm.spatialPublish chooses between the publish memory and the JS path', () => {
  assert.equal(WASM_DEFAULTS.spatialPublish, true);

  const on = buildScene({});
  assert.ok(on.spatialPublish, 'publish memory by default');
  assert.equal(on.buffers.neighborData, on.spatialPublish.buffer);
  assert.equal(on.gridMetadata.candByte, on.spatialPublish.candByte);
  assert.ok(on.gridMetadata.listStride > 0);

  const off = buildScene({ spatialPublish: false });
  assert.equal(off.spatialPublish, null, 'no publish memory');
  assert.ok(off.buffers.neighborData instanceof SharedArrayBuffer);
  assert.equal(off.buffers.neighborData.byteLength, 1000 * 33 * 2, 'plain neighbour rows');
  assert.equal(off.gridMetadata.candByte, 0, 'the spatial worker binds no WASM publish');
});

test('wasm.preRenderEmit puts SpriteRenderer and the emit state in the render-queue memory', () => {
  assert.equal(WASM_DEFAULTS.preRenderEmit, true);

  const on = buildScene({});
  const rqm = on.renderQueueMemory;
  assert.ok(rqm?.layout.emit, 'the memory carries the emit regions');
  const e = rqm.layout.emit;
  assert.equal(on.buffers.componentData.SpriteRenderer, rqm.buffer);
  assert.equal(on.buffers.componentDataByte.SpriteRenderer, e.spriteRendererByte);
  assert.equal(SpriteRenderer.active.buffer, rqm.buffer, 'the main thread binds it there');
  assert.equal(SpriteRenderer.active.byteOffset, e.spriteRendererByte);
  // The scene has no ShadowCaster and no decorations: no blocks, nothing bound at an offset.
  assert.equal(e.shadowCasterByte, -1);
  assert.equal(e.decorationByte, -1);
  assert.equal(on.buffers.componentDataByte.ShadowCaster, undefined);
  assert.equal(on.buffers.entityTextureData, rqm.buffer);
  assert.equal(on.buffers.entityTextureByte, e.lastTextureByte);
  // Other components keep buffers of their own.
  assert.ok(on.buffers.componentData.Transform instanceof SharedArrayBuffer);
  assert.notEqual(on.buffers.componentData.Transform, rqm.buffer);

  const off = buildScene({ preRenderEmit: false });
  assert.equal(off.renderQueueMemory.layout.emit, null, 'the pack memory without the emit regions');
  assert.notEqual(off.buffers.componentData.SpriteRenderer, off.renderQueueMemory.buffer);
  assert.equal(SpriteRenderer.active.byteOffset, 0);
  assert.deepEqual(off.buffers.componentDataByte, {});
  assert.equal(off.buffers.entityTextureByte, 0);

  const emitOnly = buildScene({ gpuPack: false });
  assert.ok(emitOnly.renderQueueMemory?.layout.emit, 'the emit alone still makes the memory');

  const none = buildScene({ gpuPack: false, preRenderEmit: false });
  assert.equal(none.renderQueueMemory, null);
  assert.ok(none.buffers.renderQueueDataA instanceof SharedArrayBuffer);
});
