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

// E-76 T7: the switches of the WASM modules that still have one, and the memories every kernel lays out (a kernel
// whose JavaScript path left the engine has no switch: its memory is always made).

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

test('with spatial workers the scene makes the publish memory (the search has no switch)', () => {
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'spatialPublish'), false);
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'spatialGather'), false);

  const on = buildScene({});
  assert.ok(on.spatialPublish, 'the publish memory');
  assert.equal(on.buffers.neighborData, on.spatialPublish.buffer);
  assert.equal(on.gridMetadata.candByte, on.spatialPublish.candByte);
  assert.ok(on.gridMetadata.listStride > 0);
  assert.ok(on.gridMetadata.patternByte > 0, 'with the gather regions');
});

test('SpriteRenderer and the emit state are in the render-queue memory (the emit has no switch)', () => {
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'preRenderEmit'), false);

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
});

test('AdobeAnimComponent, the pose stash and the Adobe tables are in the render-queue memory (W27, no switch)', () => {
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'preRenderEmitAdobe'), false);

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

  const none = buildScene({}).renderQueueMemory.layout.emit;
  assert.equal(none.adobeAnimByte, -1, 'no Adobe character in the scene: no Adobe regions');
  assert.equal(none.adobeAssetsByte, -1);
});

test('with shadows the stamp scratch is in the render-queue memory (the stamp has no switch)', () => {
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'shadowStamp'), false);
  const shadows = { enabled: true, shadowsEnabled: true, maxShadowCastingLights: 12, maxShadowsPerEntity: 3, maxShadowsPerLight: 64 };
  const on = buildScene({}, shadows);
  const s = on.renderQueueMemory?.layout.stamp;
  assert.ok(s, 'the stamp regions');
  assert.equal(s.maxSun, on.gpuQueueCaps.maxSun);
  assert.equal(s.maxPerEntity, 3);
  assert.equal(s.maxLights, 12);

  assert.equal(buildScene({}, null).renderQueueMemory.layout.stamp, null, 'no shadows, no stamp regions');
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
  // Without a frequency grid the regions are there too, with no bucket tables: sway_free runs the loop.
  const free = buildScene({}, null, noGrid).renderQueueMemory.layout.sway;
  assert.ok(free, 'no bucket grid: the sway regions, for sway_free');
  assert.equal(free.buckets, 0);
  assert.equal(buildScene({}, null).renderQueueMemory.layout.sway, null, 'no decorations');
});

test('with navigation the nav buffer is the navigation memory (the flowfield has no switch)', () => {
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'navFlowfield'), false);
  const nav = { navigation: { enabled: true, cellSize: 50, maxFlowfields: 8, maxPaths: 8, maxPathLength: 32 } };
  const on = buildScene({}, null, nav);
  assert.ok(on.navigationMemory, 'the navigation memory');
  assert.equal(on.buffers.navigationData, on.navigationMemory.buffer, 'the nav buffer is its buffer');
  assert.equal(on.navigationMemory.layout.cells, 40 * 20);
  assert.equal(buildScene({}, null).navigationMemory ?? null, null, 'no navigation, no memory');
});

test('in pixi pack mode Pixi has its own sprite rows and pack scratch in the render-queue memory (W9d, no switch)', () => {
  for (const name of ['gpuPack', 'pixiPack', 'gpuPackSplit']) assert.equal(Object.hasOwn(WASM_DEFAULTS, name), false, name);
  const pixi = { preRender: { packGpuSprites: 'pixi' } };
  const l = buildScene({}, null, pixi).renderQueueMemory.layout;
  assert.equal(l.pixiInstanceRows, 100, 'one row per queue row');
  assert.equal(l.pixiInstanceFloats, 15, '15 floats a row');
  assert.ok(l.pixiInstanceByte > 0 && l.pixiIndexByte > l.pixiInstanceByte && l.pixiTableByte > 0 && l.pixiParticlesByte > 0);
  assert.equal(buildScene({}, null).renderQueueMemory.layout.pixiInstanceRows, 0, 'pre-render packs: no Pixi rows');
  const interp = { ...pixi, renderer: { maxVisibleRenderables: 100, interpolation: true } };
  // W9e: with pose interpolation the rows hold a pose batch's two streams, 6 + 11 floats.
  const li = buildScene({}, null, interp).renderQueueMemory.layout;
  assert.equal(li.pixiInstanceRows, 100, 'pose interpolation: one row per queue row too');
  assert.equal(li.pixiInstanceFloats, 17, 'of 17 floats');
});

test('with a MESH layer MeshGeometry and the MESH layers\' batches live in the mesh memory (W11, no switch)', () => {
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'meshCorners'), false);
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

  assert.equal(buildScene({}, null).renderQueueMemory.layout.collect, null, 'physics on: the pose is in Box2D\'s heap');
  // Switched off, pre-render does not run the collect kernel, but the blocks stay: the emit's glow rows read
  // Transform's pose there.
  const off = buildScene({ preRenderCollect: false }, null, noPhysics);
  assert.ok(off.renderQueueMemory.layout.collect, 'off: the blocks stay');
  assert.equal(off.buffers.componentData.Transform, off.renderQueueMemory.buffer);
});

test('the worker that sorts has its painter state in the render-queue memory (W10, no switch)', () => {
  assert.equal(Object.hasOwn(WASM_DEFAULTS, 'painterRadix'), false);
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

  const none = buildScene({}, null, { renderer, preRender: { packGpuSprites: 'preRender', sortSprites: 'none' } }).renderQueueMemory.layout;
  assert.equal(none.preRenderPainter, null, 'nobody sorts: no state');
  assert.equal(none.pixiPainter, null);
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
