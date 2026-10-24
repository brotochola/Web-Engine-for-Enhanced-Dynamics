import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { Query } from '../../src/core/query.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Layer } from '../../src/core/layer.js';
import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { LAYER_KIND, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { meshLayerCapacities } from '../../src/util/meshMemory.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { EMIT_ADOBE_ASSET_BYTES, EMIT_ADOBE_MAX_ASSETS } from '../../src/util/wasmMemoryMap.js';

// E-76 T7: one switch per WASM module. wasm.spatialPublish false must give the scene the plain-SAB
// JavaScript publish path (what 32-bit ids get), default true the publish memory.

class Entity extends GameObject {}
Entity.components = [RigidBody, Collider, SpriteRenderer];

function buildScene(wasm, lightingOverride = null, configOverride = {}, extraComponents = []) {
  const previousLog = console.log;
  console.log = () => {};
  try {
    Query.reset();
    const scene = {
      totalEntityCount: 1000,
      nextComponentId: 4,
      registeredClasses: [{ class: Entity, count: 1000, startIndex: 0, entityType: 0, components: [...Entity.components, ...extraComponents] }],
      componentPools: {
        Transform: { ComponentClass: Transform },
        RigidBody: { ComponentClass: RigidBody },
        Collider: { ComponentClass: Collider },
        SpriteRenderer: { ComponentClass: SpriteRenderer },
        ...Object.fromEntries(extraComponents.map((C) => [C.name, { ComponentClass: C }])),
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

test('wasm.preRenderEmitAdobe puts AdobeAnimComponent, the pose stash and the Adobe tables in the render-queue memory (W27)', () => {
  assert.equal(WASM_DEFAULTS.preRenderEmitAdobe, true);

  const on = buildScene({}, null, {}, [AdobeAnimComponent]);
  const rqm = on.renderQueueMemory;
  const e = rqm.layout.emit;
  assert.ok(e.adobeAnimByte > e.persistAnimByte, 'the AdobeAnimComponent block, after the emit regions');
  assert.equal(on.buffers.componentData.AdobeAnimComponent, rqm.buffer);
  assert.equal(on.buffers.componentDataByte.AdobeAnimComponent, e.adobeAnimByte);
  assert.equal(AdobeAnimComponent.active.buffer, rqm.buffer, 'the main thread binds it there');
  assert.equal(AdobeAnimComponent.active.byteOffset, e.adobeAnimByte);
  for (const k of ['stashXByte', 'stashYByte', 'stashRotCByte', 'stashRotSByte', 'adobeListByte', 'adobeAssetsByte']) {
    assert.ok(e[k] > 0 && e[k] % 64 === 0, `${k} on a line`);
  }
  assert.equal(e.stashYByte - e.stashXByte, 100 * 4 + 48, 'a stash row per queue row, from a line');
  assert.equal(e.adobeAssetsBytes, EMIT_ADOBE_MAX_ASSETS * EMIT_ADOBE_ASSET_BYTES + 4 * 1048576, 'the directory and 4 MB by default');
  const nine = buildScene({}, null, { preRender: { adobeTablesMB: 9 } }, [AdobeAnimComponent]).renderQueueMemory.layout.emit;
  assert.equal(nine.adobeAssetsBytes, EMIT_ADOBE_MAX_ASSETS * EMIT_ADOBE_ASSET_BYTES + 9 * 1048576, 'preRender.adobeTablesMB');
  assert.throws(() => buildScene({}, null, { preRender: { adobeTablesMB: 2.5 } }, [AdobeAnimComponent]), /preRender\.adobeTablesMB/);

  const off = buildScene({ preRenderEmitAdobe: false }, null, {}, [AdobeAnimComponent]);
  const o = off.renderQueueMemory.layout.emit;
  assert.ok(o, 'the emit regions stay');
  for (const k of ['adobeAnimByte', 'stashXByte', 'stashYByte', 'stashRotCByte', 'stashRotSByte', 'adobeListByte', 'adobeAssetsByte']) {
    assert.equal(o[k], -1, `${k}: none`);
  }
  assert.equal(off.buffers.componentDataByte.AdobeAnimComponent, undefined);
  assert.ok(off.buffers.componentData.AdobeAnimComponent instanceof SharedArrayBuffer);
  assert.notEqual(off.buffers.componentData.AdobeAnimComponent, off.renderQueueMemory.buffer);

  const none = buildScene({}).renderQueueMemory.layout.emit;
  assert.equal(none.adobeAnimByte, -1, 'no Adobe character in the scene: no Adobe regions');
  assert.equal(none.adobeAssetsByte, -1);
  assert.equal(buildScene({ preRenderEmit: false }, null, {}, [AdobeAnimComponent]).renderQueueMemory.layout.emit, null, 'needs the emit');
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

test('wasm.preRenderCollect puts Transform, its pose and Collider in the render-queue memory when physics is off (W4b)', () => {
  assert.equal(WASM_DEFAULTS.preRenderCollect, true);
  const noPhysics = { physics: { maxJoints: 0, enabled: false } };
  const on = buildScene({}, null, noPhysics);
  const c = on.renderQueueMemory?.layout.collect;
  assert.ok(c, 'the collect regions');
  assert.equal(c.entities, 1000);
  assert.ok(c.transformByte > 0 && c.colliderByte > 0 && c.poseByte > 0 && c.listByte > 0 && c.tableByte > 0);
  assert.equal(on.buffers.componentDataByte.Transform, c.transformByte);
  assert.equal(on.buffers.componentDataByte.Collider, c.colliderByte);
  assert.equal(on.buffers.componentData.Transform, on.renderQueueMemory.buffer, 'Transform is a block of the memory');
  assert.equal(Transform.active.buffer, on.renderQueueMemory.buffer);

  assert.equal(buildScene({ preRenderCollect: false }, null, noPhysics).renderQueueMemory.layout.collect, null, 'off');
  assert.equal(buildScene({}, null).renderQueueMemory.layout.collect, null, 'physics on: the pose is in Box2D\'s heap');
  assert.equal(buildScene({ preRenderEmit: false }, null, noPhysics).renderQueueMemory.layout.collect, null, 'needs the emit');
  const off = buildScene({ preRenderCollect: false }, null, noPhysics);
  assert.equal(off.buffers.componentDataByte.Transform, undefined);
  assert.ok(off.buffers.componentData.Transform instanceof SharedArrayBuffer && off.buffers.componentData.Transform !== off.renderQueueMemory.buffer);
});

test('wasm.painterRadix gives the worker that sorts its painter state in the render-queue memory (W10)', () => {
  assert.equal(WASM_DEFAULTS.painterRadix, true);
  const renderer = { maxVisibleRenderables: 100, ySort: true };
  // As the scene resolves preRender.sortSprites before the buffers (resolveSpritePipeline).
  const pre = { renderer, preRender: { packGpuSprites: 'preRender', sortSprites: 'preRender' } };
  const pixi = { renderer, preRender: { packGpuSprites: 'pixi', sortSprites: 'pixi' } };

  const preL = buildScene({}, null, pre).renderQueueMemory.layout;
  const p = preL.preRenderPainter;
  assert.ok(p, 'pre-render sorts: its painter state');
  assert.equal(preL.pixiPainter, null, 'Pixi does not sort');
  assert.equal(p.rows, 100, 'one row per queue row');
  assert.ok(p.orderByte > preL.queueBByte && p.tableByte > 0 && p.idxEntityByte > 0 && p.idxGlowByte > 0);

  const pixiL = buildScene({}, null, pixi).renderQueueMemory.layout;
  assert.ok(pixiL.pixiPainter, 'Pixi sorts (Predator): its painter state');
  assert.equal(pixiL.preRenderPainter, null, 'pre-render does not sort');

  assert.equal(buildScene({ painterRadix: false }, null, pre).renderQueueMemory.layout.preRenderPainter, null, 'off');
  assert.equal(buildScene({ painterRadix: false }, null, pixi).renderQueueMemory.layout.pixiPainter, null, 'off');
  const none = buildScene({}, null, { renderer, preRender: { packGpuSprites: 'preRender', sortSprites: 'none' } }).renderQueueMemory.layout;
  assert.equal(none.preRenderPainter, null, 'nobody sorts: no state');
  assert.equal(none.pixiPainter, null);
  assert.equal(buildScene({ gpuPack: false, preRenderEmit: false }, null, pre).renderQueueMemory, null, 'it rides on the memory, does not make it');
});

test('the Weed pose payload binds at a byte offset of a shared buffer', async () => {
  const { createWeedPosePayload, bindWeedPoseFields } = await import('../../src/box2d/box2dHotFields.js');
  const sab = new SharedArrayBuffer(64 + 10 * 20);
  const p = createWeedPosePayload(10, sab, 64);
  bindWeedPoseFields(p);
  assert.equal(Transform.x.buffer, sab);
  assert.equal(Transform.x.byteOffset, 64);
  assert.equal(Transform.rotS.byteOffset, 64 + 4 * 10 * 4);
  const own = createWeedPosePayload(10);
  assert.deepEqual(own.channelOffsets, [0, 10, 20, 30, 40]);
});
