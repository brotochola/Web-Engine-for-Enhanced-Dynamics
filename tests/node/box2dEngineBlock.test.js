import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderQueueMemory, renderQueueMemoryBytes } from '../../src/util/renderQueueMemory.js';
import { box2dBlockPlan } from '../../src/util/box2dEngineBlock.js';
import { box2dMemoryPages } from '../../src/box2d/box2dMemory.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';

// Phase 4: with physics on, the render-queue regions are laid in a block of Box2D's memory. These check the
// two halves that do not need a browser: the regions placed in a given memory at a byte, and the plan that sizes
// the block and Box2D's memory before any buffer exists.

const ARGS = [500, 500 * 64, 4096, null, null, null, false, null];

test('the render-queue regions sit in a given memory from its byte, every region shifted by it', () => {
  const own = createRenderQueueMemory(...ARGS);
  const bytes = renderQueueMemoryBytes(...ARGS);
  assert.ok(bytes > 0);
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64, shared: true });
  const base = 65536 * 3;
  const placed = createRenderQueueMemory(...ARGS, null, { memory, baseByte: base });
  assert.ok(placed);
  assert.equal(placed.memory, memory);
  assert.equal(placed.buffer, memory.buffer);
  for (const key of ['queueAByte', 'queueBByte', 'gpuAByte', 'gpuBByte', 'indexByte', 'inverseByte', 'tableByte', 'particlesByte']) {
    assert.equal(placed.layout[key], own.layout[key] + base, key);
  }
  assert.equal(createRenderQueueMemory(...ARGS, null, { memory, baseByte: base + 8 }), null, 'an unaligned byte is refused');
  const small = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  assert.equal(createRenderQueueMemory(...ARGS, null, { memory: small, baseByte: 0 }), null, 'a block too small is refused');
});

test('the block plan: physics on and the switch on, Box2D grown by the block', () => {
  const scene = (over = {}) => ({
    _physicsEnabled: true,
    totalEntityCount: 1000,
    componentPools: {},
    config: {
      physics: { wasmMemoryMB: 64 },
      wasm: {},
      renderer: { maxVisibleRenderables: 500 },
      lighting: { enabled: false, shadowsEnabled: false },
      decoration: { maxDecorations: 0 },
      particle: {},
      preRender: {},
      ...over,
    },
  });
  const plan = box2dBlockPlan(scene());
  assert.ok(plan && plan.bytes > 0);
  assert.ok(plan.pages > box2dMemoryPages({ wasmMemoryMB: 64 }));
  assert.ok((plan.pages - box2dMemoryPages({ wasmMemoryMB: 64 })) * 65536 >= plan.bytes, 'the pages hold the block');
  assert.equal(box2dBlockPlan({ ...scene(), _physicsEnabled: false }), null, 'no physics, no block');
  assert.equal(box2dBlockPlan(scene({ wasm: { box2dBlock: false } })), null, 'the switch off');
  assert.equal(box2dBlockPlan(scene({ physics: { wasmMemoryMB: 2048 } })), null, 'past 2 GB the memories stay apart');

  // A spatial part that would take the block past 2 GB stays out of it, and the render-queue part keeps its place.
  const spatial = (maxNeighbors, entityIdWidth = 16) => ({
    ...scene({
      entityIdWidth,
      worldWidth: 4096,
      worldHeight: 4096,
      spatial: { numberOfSpatialWorkers: 2, cellSize: 128, maxEntitiesPerCell: 64, maxNeighbors },
    }),
    totalEntityCount: 60000,
  });
  try {
    const fits = box2dBlockPlan(spatial(64));
    assert.ok(fits && fits.spatialBytes > 60000 * 65 * 2 * 2, 'a spatial part that fits is in the block');
    const big = box2dBlockPlan(spatial(9000));
    assert.ok(big, 'the block stays');
    assert.equal(big.spatialBytes, 0, 'the spatial part past 2 GB stays out');
    assert.equal(big.queueBytes, fits.queueBytes, 'the render-queue part keeps its place');
    assert.equal(big.bytes, big.queueBytes);
    // W8b: at 32-bit ids the part is laid out too, with 4-byte ids, and past 2 GB at half the neighbours.
    const wide = box2dBlockPlan(spatial(64, 32));
    assert.ok(wide && wide.spatialBytes > 60000 * 65 * 4 * 2, 'at 32-bit ids the spatial part is in the block, 4-byte ids');
    assert.equal(box2dBlockPlan(spatial(4500, 32)).spatialBytes, 0, 'at 32-bit ids, past 2 GB it stays out');
  } finally {
    bindEntityIdWidth(16);
  }
});

test('in the block, the collect keeps RigidBody and the two published pose buffers instead of the Weed pose', () => {
  const entities = 300;
  const withBodies = { entities, transformBytes: 3 * entities, colliderBytes: 64 * entities, rigidBodyBytes: 80 * entities };
  const args = [500, 500 * 64, 4096, { entities, spriteBytes: 200 * entities, casterBytes: 0, decorationBytes: 0 }, null, null, false];
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 128, shared: true });
  const base = 65536 * 2;
  const placed = createRenderQueueMemory(...args, withBodies, null, { memory, baseByte: base });
  assert.ok(placed);
  assert.equal(placed.layout.inBox2dBlock, true);
  const c = placed.layout.collect;
  assert.equal(c.poseByte, -1, 'no Weed pose with physics');
  for (const key of ['transformByte', 'rigidBodyByte', 'bodyPoseAByte', 'bodyPoseBByte', 'colliderByte']) {
    assert.ok(c[key] >= base && c[key] % 64 === 0, key);
  }
  assert.ok(c.bodyPoseBByte >= c.bodyPoseAByte + entities * 16, 'pose buffer A holds x, y, rotC, rotS');
  assert.ok(c.colliderByte >= c.bodyPoseBByte + entities * 16, 'pose buffer B holds x, y, rotC, rotS');
  assert.ok(renderQueueMemoryBytes(...args, withBodies) > renderQueueMemoryBytes(...args, null) + 2 * entities * 16, 'the block is sized with them');

  const own = createRenderQueueMemory(...args, { ...withBodies, rigidBodyBytes: 0 });
  assert.equal(own.layout.inBox2dBlock, false);
  assert.ok(own.layout.collect.poseByte > 0, 'without physics, the Weed pose');
  assert.equal(own.layout.collect.rigidBodyByte, -1);
  assert.equal(own.layout.collect.bodyPoseAByte, -1);
  assert.equal(own.layout.collect.bodyPoseBByte, -1);
});

test('the physics host views Transform, RigidBody and Collider where the engine lays them at a byte', async () => {
  const { readFileSync } = await import('node:fs');
  const { Transform } = await import('../../src/components/transform.js');
  const { RigidBody } = await import('../../src/components/rigidBody.js');
  const { Collider } = await import('../../src/components/collider.js');
  const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
  const piece = (from, to) => {
    const start = host.indexOf(from);
    const end = host.indexOf(to, start);
    assert.ok(start >= 0 && end > start, from);
    return host.slice(start, end + to.length);
  };
  const src = [
    'var MAX_POLYGON_VERTICES = 8;',
    piece('  var TRANSFORM_SCHEMA = {', '\n  };'),
    piece('  var RIGIDBODY_SCHEMA = {', '\n  };'),
    piece('  var COLLIDER_SCHEMA = {', '\n  };'),
    piece('  function schemaEntry(', '\n  }\n'),
    piece('  function bindSchema(', '\n  }\n'),
  ].join('\n');
  const h = new Function(`${src}\nreturn { bindSchema, TRANSFORM_SCHEMA, RIGIDBODY_SCHEMA, COLLIDER_SCHEMA };`)();
  const n = 37;
  const sab = new SharedArrayBuffer(1 << 20);
  for (const [Component, schema, byte] of [
    [Transform, h.TRANSFORM_SCHEMA, 64 * 5],
    [RigidBody, h.RIGIDBODY_SCHEMA, 64 * 300],
    [Collider, h.COLLIDER_SCHEMA, 64 * 900],
  ]) {
    Component.initializeArrays(sab, n, byte);
    const views = h.bindSchema(sab, n, schema, byte);
    for (const name of Object.keys(schema)) {
      const engine = Component[name];
      const mine = views[name];
      assert.ok(engine && mine, `${Component.name}.${name}`);
      assert.equal(mine.byteOffset, engine.byteOffset, `${Component.name}.${name} at the same byte`);
      assert.equal(mine.length, engine.length, `${Component.name}.${name} the same length`);
    }
  }
});

test('the spec: with physics the collect asks for the body variant, which needs the block switch', async () => {
  const { renderQueueMemorySpec } = await import('../../src/util/sceneSharedBuffers.js');
  const { Transform } = await import('../../src/components/transform.js');
  const { RigidBody } = await import('../../src/components/rigidBody.js');
  const { SpriteRenderer } = await import('../../src/components/spriteRenderer.js');
  const scene = (physics, wasm = {}) => ({
    _physicsEnabled: physics,
    totalEntityCount: 1000,
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    },
    config: {
      physics: { enabled: physics, wasmMemoryMB: 64 },
      wasm,
      renderer: { maxVisibleRenderables: 500 },
      lighting: { enabled: false, shadowsEnabled: false },
      decoration: { maxDecorations: 0 },
      particle: {},
      preRender: {},
    },
  });
  assert.ok(renderQueueMemorySpec(scene(true)).collect.rigidBodyBytes > 0);
  assert.equal(renderQueueMemorySpec(scene(true, { box2dBlock: false })).collect, null, 'no block, no body variant');
  assert.ok(renderQueueMemorySpec(scene(true, { preRenderCollect: false })).collect.rigidBodyBytes > 0,
    'the collect kernel off, its blocks stay: the emit reads Transform there');
  assert.equal(renderQueueMemorySpec(scene(false)).collect.rigidBodyBytes, 0, 'without physics, the Weed pose variant');
  assert.equal(box2dBlockPlan(scene(true)).bytes, box2dBlockPlan(scene(true, { preRenderCollect: false })).bytes,
    'the block is the same either way');
});

test('the spatial publish regions sit in the block after the render-queue part, every region shifted', async () => {
  const { createSpatialPublishMemory, spatialPublishMemoryBytes } = await import('../../src/util/spatialPublishMemory.js');
  const { box2dBlockParts } = await import('../../src/util/box2dEngineBlock.js');
  const grid = { totalCells: 40 * 30, cellByteSize: 4 + 32 * 2 };
  const own = createSpatialPublishMemory(2000, 16, 2, grid);
  assert.ok(own);
  const bytes = spatialPublishMemoryBytes(2000, 16, 2, grid);
  assert.ok(bytes > 0);
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 128, shared: true });
  const block = box2dBlockParts({ memory, byte: 65536, bytes: 65536 * 3 + bytes }, { queueBytes: 65536 * 3, spatialBytes: bytes });
  assert.equal(block.spatialByte, 65536 * 4);
  const placed = createSpatialPublishMemory(2000, 16, 2, grid, { memory, baseByte: block.spatialByte });
  assert.ok(placed);
  assert.equal(placed.memory, memory);
  for (const key of ['posByte', 'rangeByte', 'neighborByte', 'candByte', 'listByte', 'gridByte', 'markerByte', 'truncatedByte', 'rebuildByte', 'orderByte', 'patternByte']) {
    assert.equal(placed[key], own[key] + block.spatialByte, key);
  }
  assert.ok(placed.patternByte + placed.patternBytes <= block.spatialByte + bytes, 'the regions fit the part');
  assert.equal(createSpatialPublishMemory(2000, 16, 2, grid, { memory, baseByte: block.spatialByte + 4 }), null, 'unaligned');
  assert.equal(box2dBlockParts(null, { queueBytes: 0, spatialBytes: 0 }), null);
});

test('the block plan sizes the spatial part after the render-queue part', () => {
  const scene = (spatial) => ({
    _physicsEnabled: true,
    totalEntityCount: 1000,
    componentPools: {},
    config: {
      physics: { wasmMemoryMB: 64 },
      wasm: {},
      renderer: { maxVisibleRenderables: 500 },
      lighting: { enabled: false, shadowsEnabled: false },
      decoration: { maxDecorations: 0 },
      particle: {},
      preRender: {},
      worldWidth: 4096,
      worldHeight: 4096,
      spatial: { numberOfSpatialWorkers: spatial, cellSize: 128, maxNeighbors: 16, maxEntitiesPerCell: 32 },
    },
  });
  const without = box2dBlockPlan(scene(0));
  const withSpatial = box2dBlockPlan(scene(2));
  assert.equal(without.spatialBytes, 0);
  assert.equal(withSpatial.queueBytes, without.queueBytes);
  assert.equal(withSpatial.queueBytes % 64, 0);
  assert.ok(withSpatial.spatialBytes > 0);
  assert.equal(withSpatial.bytes, withSpatial.queueBytes + withSpatial.spatialBytes);
});

test('W19: with physics the bodies part carries the bullet tick regions, for any pool with the spatial grid', async () => {
  const { renderQueueMemorySpec } = await import('../../src/util/sceneSharedBuffers.js');
  const { Transform } = await import('../../src/components/transform.js');
  const { RigidBody } = await import('../../src/components/rigidBody.js');
  const { WASM_DEFAULTS } = await import('../../src/util/configDefaults.js');
  assert.equal(WASM_DEFAULTS.bulletTick, true);
  const scene = (over = {}) => ({
    _physicsEnabled: true,
    totalEntityCount: 1000,
    componentPools: { Transform: { ComponentClass: Transform }, RigidBody: { ComponentClass: RigidBody } },
    config: {
      physics: { enabled: true, wasmMemoryMB: 64 },
      wasm: over.wasm || {},
      renderer: { maxVisibleRenderables: 500 },
      lighting: { enabled: false, shadowsEnabled: false },
      decoration: { maxDecorations: 0 },
      particle: {},
      preRender: {},
      bullet: { maxBullets: over.maxBullets ?? 4000, maxImpactsPerFrame: 128 },
      worldWidth: 4096,
      worldHeight: 4096,
      spatial: { numberOfSpatialWorkers: over.spatial ?? 1, cellSize: 128, maxNeighbors: 16, maxEntitiesPerCell: 32 },
    },
  });
  const b = renderQueueMemorySpec(scene()).collect?.bullets;
  assert.ok(b, 'no sprites to collect, yet the bodies part is laid for the bullets');
  assert.equal(b.bullets, 4000);
  assert.equal(b.impacts, 128);
  assert.equal(renderQueueMemorySpec(scene({ wasm: { bulletTick: false } })).collect, null, 'the switch off');
  // Past 65 535 bullets the kernel's 32-bit form runs (close-out group B): the regions are laid for it too.
  assert.equal(renderQueueMemorySpec(scene({ maxBullets: 70000 })).collect?.bullets?.bullets, 70000, 'a 32-bit pool gets the kernel');
  assert.equal(renderQueueMemorySpec(scene({ spatial: 0 })).collect, null, 'no spatial grid, no cast');
  assert.equal(renderQueueMemorySpec(scene({ wasm: { box2dBlock: false } })).collect, null, 'no block');

  const args = [500, 500 * 64, 4096, null, null, null, false];
  const withBullets = { entities: 1000, transformBytes: 3000, colliderBytes: 64000, rigidBodyBytes: 80000, bullets: b };
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 256, shared: true });
  const placed = createRenderQueueMemory(...args, withBullets, null, { memory, baseByte: 65536 });
  const l = placed.layout.collect.bullets;
  for (const key of ['componentByte', 'activeByte', 'impactsByte', 'returnedByte', 'stampByte', 'tableByte', 'resultsByte']) {
    assert.ok(l[key] >= 65536 && l[key] % 64 === 0, key);
  }
  assert.ok(l.impactsByte >= l.activeByte + (4000 + 1) * 2 && l.returnedByte >= l.impactsByte + 128 * 24);
});

test('W2b: with physics and raycasted lighting the bodies part carries LightOccluder, the visibility regions and the gather\'s', async () => {
  const { renderQueueMemorySpec } = await import('../../src/util/sceneSharedBuffers.js');
  const { Transform } = await import('../../src/components/transform.js');
  const { RigidBody } = await import('../../src/components/rigidBody.js');
  const { Collider } = await import('../../src/components/collider.js');
  const { LightOccluder } = await import('../../src/components/lightOccluder.js');
  const { WASM_DEFAULTS } = await import('../../src/util/configDefaults.js');
  const { visibilityMemoryBytes, visibilityMemoryOpts } = await import('../../src/util/visibilityMemory.js');
  assert.equal(WASM_DEFAULTS.visibilityGather, true);
  const scene = (over = {}) => ({
    _physicsEnabled: true,
    totalEntityCount: 1000,
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      ...(over.noOccluders ? {} : { LightOccluder: { ComponentClass: LightOccluder } }),
    },
    config: {
      physics: { enabled: true, wasmMemoryMB: 64, maxFixturePoolSize: over.fixtures ?? 300 },
      wasm: over.wasm || {},
      renderer: { maxVisibleRenderables: 500 },
      lighting: { enabled: true, raycasted: over.raycasted ?? true, shadowsEnabled: false, maxPolygonVertices: 256 },
      decoration: { maxDecorations: 0 },
      particle: {},
      preRender: {},
      bullet: { maxBullets: 0 },
      worldWidth: 4096,
      worldHeight: 4096,
      spatial: { numberOfSpatialWorkers: over.spatial ?? 1, cellSize: 128, maxNeighbors: 48, maxEntitiesPerCell: 32 },
    },
  });
  const v = renderQueueMemorySpec(scene()).collect?.visibility;
  assert.ok(v, 'no sprites to collect, yet the bodies part is laid for the gather');
  const opts = visibilityMemoryOpts({ maxVerts: 256, entities: 1000, fixtures: 300 });
  assert.deepEqual(v.opts, opts);
  assert.equal(v.bytes, visibilityMemoryBytes(opts));
  assert.equal(v.occluderBytes, LightOccluder.getBufferSize(1000));
  assert.equal(v.events, 48, 'one record per neighbour a row holds');
  assert.equal(renderQueueMemorySpec(scene({ wasm: { solidSegments: false } })).collect.visibility.opts.fixtures, 0, 'W1 off: no outline regions');
  assert.equal(renderQueueMemorySpec(scene({ wasm: { visibilityGather: false } })).collect, null, 'the switch off');
  assert.equal(renderQueueMemorySpec(scene({ wasm: { visibilitySweep: false } })).collect, null, 'it needs the sweep');
  assert.equal(renderQueueMemorySpec(scene({ raycasted: false })).collect, null, 'no raycasted lighting');
  assert.equal(renderQueueMemorySpec(scene({ spatial: 0 })).collect, null, 'no neighbour rows');
  assert.equal(renderQueueMemorySpec(scene({ noOccluders: true })).collect, null, 'no occluders');
  assert.equal(renderQueueMemorySpec(scene({ wasm: { box2dBlock: false } })).collect, null, 'no block');

  const args = [500, 500 * 64, 4096, null, null, null, false];
  const collect = { entities: 1000, transformBytes: 3000, colliderBytes: 64000, rigidBodyBytes: 80000, bullets: null, visibility: v };
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 512, shared: true });
  const placed = createRenderQueueMemory(...args, collect, null, { memory, baseByte: 65536 });
  const l = placed.layout.collect.visibility;
  for (const key of ['occluderByte', 'byte', 'tableByte', 'resultsByte', 'eventsByte']) {
    assert.ok(l[key] >= 65536 && l[key] % 64 === 0, key);
  }
  assert.ok(l.byte >= l.occluderByte + v.occluderBytes && l.tableByte >= l.byte + v.bytes, 'in order, apart');
  assert.ok(l.eventsByte + 48 * 48 <= memory.buffer.byteLength);
  assert.deepEqual(l.opts, opts);
});
