import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Query } from '../../src/core/query.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Layer } from '../../src/core/layer.js';
import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { LAYER_KIND, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { meshLayerCapacities } from '../../src/util/meshMemory.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';

// E-76 T7: one switch per WASM module. wasm.spatialPublish false must give the scene the plain-SAB
// JavaScript publish path (what 32-bit ids get), default true the publish memory.

class Entity extends GameObject {}
Entity.components = [RigidBody, Collider, SpriteRenderer];

function buildScene(wasm, lightingOverride = null, configOverride = {}) {
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
        lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false, ...lightingOverride },
        logic: { staggeredUpdates: false },
        debug: { maxDebugDrawEntries: 1 },
        navigation: { enabled: false },
        renderer: { maxVisibleRenderables: 100 },
        layers: {},
        wasm: { ...WASM_DEFAULTS, ...wasm },
        ...configOverride,
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

test('wasm.shadowStamp puts the stamp scratch in the render-queue memory when shadows are on', () => {
  assert.equal(WASM_DEFAULTS.shadowStamp, true);
  const shadows = { enabled: true, shadowsEnabled: true, maxShadowCastingLights: 12, maxShadowsPerEntity: 3, maxShadowsPerLight: 64 };
  const on = buildScene({}, shadows);
  const s = on.renderQueueMemory?.layout.stamp;
  assert.ok(s, 'the stamp regions');
  assert.equal(s.maxSun, on.gpuQueueCaps.maxSun);
  assert.equal(s.maxPerEntity, 3);
  assert.equal(s.maxLights, 12);

  assert.equal(buildScene({ shadowStamp: false }, shadows).renderQueueMemory.layout.stamp, null, 'off');
  assert.equal(buildScene({}, null).renderQueueMemory.layout.stamp, null, 'no shadows, no stamp regions');
  const stampOnly = buildScene({ gpuPack: false, preRenderEmit: false }, shadows);
  assert.ok(stampOnly.renderQueueMemory?.layout.stamp, 'the stamp alone still makes the memory');
});

test('wasm.decorationSway puts the sway arrays in the render-queue memory, next to the decorations', () => {
  assert.equal(WASM_DEFAULTS.decorationSway, true);
  const grass = { decoration: { maxDecorations: 800 }, particle: { maxParticles: 0, swayFrequencyBuckets: 100 } };
  const on = buildScene({}, null, grass);
  const w = on.renderQueueMemory?.layout.sway;
  assert.ok(w, 'the sway regions');
  assert.equal(w.decorations, 800);
  assert.equal(w.buckets, 100);
  assert.ok(on.renderQueueMemory.layout.emit.decorationByte >= 0, 'next to the decorations block');

  assert.equal(buildScene({ decorationSway: false }, null, grass).renderQueueMemory.layout.sway, null, 'off');
  const noGrid = { ...grass, particle: { maxParticles: 0, swayFrequencyBuckets: 0 } };
  assert.equal(buildScene({}, null, noGrid).renderQueueMemory.layout.sway, null, 'no bucket grid, the loop stays JS');
  assert.equal(buildScene({}, null).renderQueueMemory.layout.sway, null, 'no decorations');
  const noEmit = buildScene({ preRenderEmit: false }, null, grass);
  assert.equal(noEmit.renderQueueMemory.layout.sway, null, 'without the emit the decorations are not in the memory');
});

test('wasm.navFlowfield puts the nav buffer in the navigation memory', () => {
  assert.equal(WASM_DEFAULTS.navFlowfield, true);
  const nav = { navigation: { enabled: true, cellSize: 50, maxFlowfields: 8, maxPaths: 8, maxPathLength: 32 } };
  const on = buildScene({}, null, nav);
  assert.ok(on.navigationMemory, 'the navigation memory');
  assert.equal(on.buffers.navigationData, on.navigationMemory.buffer, 'the nav buffer is its buffer');
  assert.equal(on.navigationMemory.layout.cells, 40 * 20);

  const off = buildScene({ navFlowfield: false }, null, nav);
  assert.equal(off.navigationMemory, null, 'off');
  assert.ok(off.buffers.navigationData instanceof SharedArrayBuffer);
  assert.equal(buildScene({}, null).navigationMemory ?? null, null, 'no navigation, no memory');
});

test('wasm.pixiPack gives Pixi its own sprite rows and pack scratch in the render-queue memory (W9d)', () => {
  assert.equal(WASM_DEFAULTS.pixiPack, true);
  const pixi = { preRender: { packGpuSprites: 'pixi' } };
  const l = buildScene({}, null, pixi).renderQueueMemory.layout;
  assert.equal(l.pixiInstanceRows, 100, 'one row per queue row');
  assert.ok(l.pixiInstanceByte > 0 && l.pixiIndexByte > l.pixiInstanceByte && l.pixiTableByte > 0 && l.pixiParticlesByte > 0);
  assert.equal(buildScene({ pixiPack: false }, null, pixi).renderQueueMemory.layout.pixiInstanceRows, 0, 'off');
  assert.equal(buildScene({}, null).renderQueueMemory.layout.pixiInstanceRows, 0, 'pre-render packs: no Pixi rows');
  const interp = { ...pixi, renderer: { maxVisibleRenderables: 100, interpolation: true } };
  assert.equal(buildScene({}, null, interp).renderQueueMemory.layout.pixiInstanceRows, 0, 'pose interpolation packs its own way');
  assert.equal(buildScene({ gpuPack: false, preRenderEmit: false }, null, pixi).renderQueueMemory, null, 'needs gpuPack');
});

test('wasm.meshCorners puts MeshGeometry and the MESH layers\' batches in the mesh memory (W11)', () => {
  assert.equal(WASM_DEFAULTS.meshCorners, true);
  const renderer = { maxVisibleRenderables: 100, maxMeshVerts: 512, maxMeshIndices: 1536 };
  const meshes = {
    renderer,
    physics: { maxJoints: 0, maxFixturePoolSize: 300 },
    layers: { ground: { kind: LAYER_KIND.MESH, zIndex: 1 }, sprites: { zIndex: 2 }, cloth: { kind: LAYER_KIND.MESH, zIndex: 3 } },
  };
  const on = buildScene({}, null, meshes);
  const mem = on.meshMemory;
  assert.ok(mem, 'the mesh memory');
  assert.equal(on.buffers.meshGeomData, mem.buffer, 'MeshGeometry\'s buffer is its buffer');
  assert.equal(MeshGeometry.vertOffset.buffer, mem.buffer, 'the main thread binds it there');
  assert.equal(MeshGeometry.vertOffset.byteOffset, 0, 'from byte 0');
  const caps = meshLayerCapacities(300, 1000, 512, 1536);
  assert.deepEqual(mem.layout.layers.map((l) => l.layerId), [Layer.get('ground').id, Layer.get('cloth').id], 'each MESH layer, in order');
  for (const l of mem.layout.layers) {
    assert.equal(l.fillRows, caps.fill, 'the fill rows Pixi gives the layer');
    assert.equal(l.uvRows, caps.uv, 'the UV rows Pixi gives the layer');
  }
  assert.equal(mem.layout.geometryBytes, MeshGeometry.getBufferSize(512, 1536, 1000));

  const off = buildScene({ meshCorners: false }, null, meshes);
  assert.equal(off.meshMemory, null, 'off');
  assert.ok(off.buffers.meshGeomData instanceof SharedArrayBuffer);
  assert.equal(off.buffers.meshGeomData.byteLength, MeshGeometry.getBufferSize(512, 1536, 1000), 'a buffer of its own');

  const noMeshLayer = buildScene({}, null, { renderer, layers: { sprites: { zIndex: 2 } } });
  assert.equal(noMeshLayer.meshMemory, null, 'no MESH layer, nothing to rewrite');
  assert.ok(noMeshLayer.buffers.meshGeomData instanceof SharedArrayBuffer);
  assert.equal(buildScene({}, null, { layers: meshes.layers }).meshMemory, null, 'no mesh vertices, no MeshGeometry');
});
