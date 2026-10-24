import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderQueueMemory, renderQueueMemoryBytes } from '../../src/util/renderQueueMemory.js';
import { box2dBlockPlan } from '../../src/util/box2dEngineBlock.js';
import { box2dMemoryPages } from '../../src/box2d/box2dMemory.js';

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
  assert.equal(renderQueueMemorySpec(scene(true, { preRenderCollect: false })).collect, null);
  assert.equal(renderQueueMemorySpec(scene(false)).collect.rigidBodyBytes, 0, 'without physics, the Weed pose variant');
  assert.ok(box2dBlockPlan(scene(true)).bytes > box2dBlockPlan(scene(true, { preRenderCollect: false })).bytes,
    'the block holds the body variant');
});
